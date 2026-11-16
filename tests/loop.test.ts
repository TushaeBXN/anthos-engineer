import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTurn, type Agent } from "../agent/loop.js";
import { resolveModel } from "../agent/models.js";
import type { Reply, Session, ToolCall, ToolResult } from "../agent/types.js";
import { UsageTracker } from "../agent/usage.js";
import type { ForgePolicy } from "../policy/schema.js";
import { tools } from "../tools/index.js";

const POLICY: ForgePolicy = {
  version: 1,
  default: "deny",
  rules: [
    { id: "allow-reads", resource: "filesystem", operation: "read", target: "**", effect: "allow" },
    { id: "allow-src", resource: "filesystem", operation: "write", target: "src/**", effect: "allow" },
    { id: "deny-secrets", resource: "filesystem", operation: "write", target: "secrets/**", effect: "deny" },
  ],
};

const USAGE = { inputTokens: 100, cachedTokens: 0, outputTokens: 10 };
const call = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id, name, input });
const wants = (...toolCalls: ToolCall[]): Reply => ({ text: "", toolCalls, usage: USAGE, stopped: "tools" });
const says = (text: string): Reply => ({ text, toolCalls: [], usage: USAGE, stopped: "done" });

/** A model that plays back scripted replies and records what it was sent. */
function script(replies: Reply[]): { session: Session; received: Array<string | ToolResult[]> } {
  const received: Array<string | ToolResult[]> = [];
  return {
    received,
    session: {
      async send(input) {
        received.push(input);
        const reply = replies.shift();
        if (!reply) throw new Error("The script ran out of replies");
        return reply;
      },
    },
  };
}

function agent(session: Session, overrides: Partial<Agent> = {}): Agent & { log: string[]; asked: string[] } {
  const log: string[] = [];
  const asked: string[] = [];
  return {
    session,
    tools,
    policy: POLICY,
    usage: new UsageTracker(resolveModel({})),
    screen: {
      say: (text) => log.push(`say: ${text}`),
      activity: (label, detail) => log.push(detail ? `${label} [${detail}]` : label),
      note: (text) => log.push(`note: ${text}`),
      working: () => {},
    },
    who: { agentId: "test", sessionId: "s1" },
    cwd: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-loop-"))),
    approve: async (label) => {
      asked.push(label);
      return false;
    },
    audit: () => {},
    log,
    asked,
    ...overrides,
  };
}

describe("runTurn", () => {
  test("a plain answer ends the turn after one request", async () => {
    const { session, received } = script([says("Hello.")]);
    const a = agent(session);
    assert.equal(await runTurn("hi", a), "Hello.");
    assert.deepEqual(received, ["hi"]);
    assert.deepEqual(a.log, ["say: Hello."]);
  });

  test("tool calls run, results go back, and the loop continues until the model stops", async () => {
    const { session, received } = script([
      wants(call("1", "write", { path: "src/a.ts", content: "one\ntwo\n" })),
      wants(call("2", "read", { path: "src/a.ts" })),
      says("Done."),
    ]);
    const a = agent(session);
    assert.equal(await runTurn("make a file", a), "Done.");

    assert.equal(fs.readFileSync(path.join(a.cwd, "src/a.ts"), "utf8"), "one\ntwo\n");
    const [, afterWrite, afterRead] = received as [string, ToolResult[], ToolResult[]];
    assert.deepEqual(afterWrite, [{ id: "1", output: "Created src/a.ts", isError: false }]);
    assert.match(afterRead[0].output, /1 {2}one/);
    assert.deepEqual(a.log, ["Write src/a.ts [+2 −0]", "Read src/a.ts", "say: Done."]);
  });

  test("usage and changed lines are counted across the turn", async () => {
    const { session } = script([
      wants(call("1", "write", { path: "src/a.ts", content: "one\ntwo\n" })),
      wants(call("2", "edit", { path: "src/a.ts", old_string: "two", new_string: "2" })),
      says("Done."),
    ]);
    const a = agent(session);
    await runTurn("go", a);
    assert.equal(a.usage.inputTokens, 300);
    assert.deepEqual(a.usage.linesChanged, { added: 3, removed: 1, files: 1 });
  });

  test("a denied action never runs and the model is told why", async () => {
    const { session, received } = script([
      wants(call("1", "write", { path: "secrets/key.txt", content: "x" })),
      says("I cannot write there."),
    ]);
    const a = agent(session);
    await runTurn("go", a);

    assert.equal(fs.existsSync(path.join(a.cwd, "secrets/key.txt")), false);
    const result = (received[1] as ToolResult[])[0];
    assert.equal(result.isError, true);
    assert.match(result.output, /Not allowed by policy/);
    assert.deepEqual(a.asked, [], "a deny is final: the person is not asked");
  });

  test("an action with no rule asks the person; declined means it does not run", async () => {
    const { session, received } = script([
      wants(call("1", "write", { path: "docs/a.md", content: "x" })),
      says("Understood."),
    ]);
    const a = agent(session);
    await runTurn("go", a);

    assert.deepEqual(a.asked, ["Write docs/a.md"]);
    assert.equal(fs.existsSync(path.join(a.cwd, "docs/a.md")), false);
    assert.match((received[1] as ToolResult[])[0].output, /declined/);
  });

  test("an action with no rule runs once the person approves", async () => {
    const { session } = script([wants(call("1", "write", { path: "docs/a.md", content: "x" })), says("Done.")]);
    const a = agent(session, { approve: async () => true });
    await runTurn("go", a);
    assert.equal(fs.readFileSync(path.join(a.cwd, "docs/a.md"), "utf8"), "x");
  });

  test("every policy decision reaches the audit log", async () => {
    const audited: string[] = [];
    const { session } = script([wants(call("1", "write", { path: "secrets/k", content: "x" })), says("ok")]);
    await runTurn("go", agent(session, { audit: (r) => audited.push(`${r.decision}:${r.matchedRuleId}`) }));
    assert.deepEqual(audited, ["deny:deny-secrets"]);
  });

  test("the person's answer to an ask is audited too", async () => {
    const audited: string[] = [];
    const { session } = script([wants(call("1", "bash", { command: "echo hi" })), says("ok")]);
    await runTurn("go", agent(session, { approve: async () => true, audit: (r) => audited.push(`${r.request.operation}:${r.decision}:${r.reason}`) }));
    assert.deepEqual(audited, ["echo hi:allow:Approved by the user"]);
  });

  test("several tool calls in one reply each get a result, in order", async () => {
    const { session, received } = script([
      wants(
        call("1", "write", { path: "src/a.ts", content: "a" }),
        call("2", "nope", {}),
        call("3", "read", {}),
        call("4", "read", { path: "src/missing.ts" }),
      ),
      says("ok"),
    ]);
    await runTurn("go", agent(session));
    const results = received[1] as ToolResult[];
    assert.deepEqual(results.map((r) => [r.id, r.isError]), [["1", false], ["2", true], ["3", true], ["4", true]]);
    assert.match(results[1].output, /no tool named "nope"/);
    assert.match(results[2].output, /Missing required input: path/);
    assert.match(results[3].output, /ENOENT/);
  });

  test("a tool's own failure is passed back as an error, not thrown", async () => {
    const { session, received } = script([
      wants(call("1", "edit", { path: "src/a.ts", old_string: "x", new_string: "y" })),
      says("ok"),
    ]);
    const a = agent(session);
    fs.mkdirSync(path.join(a.cwd, "src"));
    fs.writeFileSync(path.join(a.cwd, "src/a.ts"), "hello\n");
    await runTurn("go", a);
    assert.equal((received[1] as ToolResult[])[0].isError, true);
    assert.deepEqual(a.log, ["Edit src/a.ts [failed]", "say: ok"]);
  });

  test("a reply cut off mid tool call: nothing runs, and the model is told to take smaller steps", async () => {
    const cut: Reply = {
      text: "",
      toolCalls: [call("1", "write", { path: "src/a.ts", content: "half a fi" })],
      usage: USAGE,
      stopped: "cut_off",
    };
    const { session, received } = script([cut, says("ok")]);
    const a = agent(session);
    await runTurn("go", a);
    assert.equal(fs.existsSync(path.join(a.cwd, "src/a.ts")), false);
    assert.match((received[1] as ToolResult[])[0].output, /cut off/);
  });

  test("a reply cut off mid sentence is asked to continue", async () => {
    const cut: Reply = { text: "First half", toolCalls: [], usage: USAGE, stopped: "cut_off" };
    const { session, received } = script([cut, says("second half.")]);
    assert.equal(await runTurn("go", agent(session)), "second half.");
    assert.match(received[1] as string, /cut off/);
  });

  test("a refusal ends the turn", async () => {
    const refused: Reply = { text: "", toolCalls: [], usage: USAGE, stopped: "refused" };
    const { session, received } = script([refused]);
    const a = agent(session);
    await runTurn("go", a);
    assert.equal(received.length, 1);
    assert.deepEqual(a.log, ["note: The model declined this request."]);
  });

  test("the loop stops at the step limit instead of running forever", async () => {
    const forever: Session = { send: async () => wants(call("1", "glob", { pattern: "*" })) };
    const a = agent(forever, { maxSteps: 3 });
    await runTurn("go", a);
    assert.equal(a.usage.inputTokens, 300);
    assert.equal(a.log.at(-1), "note: Stopped: too many steps in one turn.");
  });

  test("the loop stops before the next request once the budget is spent", async () => {
    const { session, received } = script([wants(call("1", "glob", { pattern: "*" })), says("never sent")]);
    const a = agent(session);
    a.usage = new UsageTracker(resolveModel({}), 0.0001);
    await runTurn("go", a);
    assert.equal(received.length, 1);
    assert.match(a.log.at(-1) ?? "", /Budget reached/);
  });

  test("very long tool output is cut before it goes back to the model", async () => {
    const { session, received } = script([wants(call("1", "read", { path: "src/big.txt" })), says("ok")]);
    const a = agent(session);
    fs.mkdirSync(path.join(a.cwd, "src"));
    fs.writeFileSync(path.join(a.cwd, "src/big.txt"), "x".repeat(100_000));
    await runTurn("go", a);
    const output = (received[1] as ToolResult[])[0].output;
    assert.ok(output.length < 31_000);
    assert.match(output, /output cut/);
  });
});

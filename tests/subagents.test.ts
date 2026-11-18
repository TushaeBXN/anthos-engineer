import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTurn, type Agent } from "../agent/loop.js";
import { resolveModel } from "../agent/models.js";
import { BUILT_IN, loadAgentTypes, makeTaskTool, parseAgentFile, type AgentType } from "../agent/subagents.js";
import type { Reply, Session, ToolCall, ToolResult, ToolSpec } from "../agent/types.js";
import { UsageTracker } from "../agent/usage.js";
import type { ForgePolicy } from "../policy/schema.js";
import { makeTools } from "../tools/index.js";

const POLICY: ForgePolicy = {
  version: 1,
  default: "deny",
  rules: [
    { id: "allow-reads", resource: "filesystem", operation: "read", target: "**", effect: "allow" },
    { id: "allow-src", resource: "filesystem", operation: "write", target: "src/**", effect: "allow" },
  ],
};

const call = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id, name, input });
const usage = (n: number) => ({ inputTokens: n, cachedTokens: 0, outputTokens: 10 });
const wants = (n: number, ...toolCalls: ToolCall[]): Reply => ({ text: "", toolCalls, usage: usage(n), stopped: "tools" });
const says = (n: number, text: string): Reply => ({ text, toolCalls: [], usage: usage(n), stopped: "done" });

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

/** A parent agent with the task tool; child sessions come from `children` in order. */
function setup(parentReplies: Reply[], children: Reply[][], types: AgentType[] = BUILT_IN) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-sub-")));
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src/a.ts"), "export const a = 1;\n");

  const log: string[] = [];
  const audited: string[] = [];
  const childTools: string[][] = [];
  const childPrompts: string[] = [];
  const parent = script(parentReplies);
  const tools = makeTools();
  let agent: Agent;
  tools.push(
    makeTaskTool({
      parent: () => agent,
      newSession: (system: string, specs: ToolSpec[]) => {
        childPrompts.push(system);
        childTools.push(specs.map((s) => s.name));
        return script(children.shift() ?? []).session;
      },
      basePrompt: "BASE PROMPT",
      types,
    }),
  );
  agent = {
    session: parent.session,
    tools,
    policy: POLICY,
    usage: new UsageTracker(resolveModel({})),
    screen: {
      say: (t) => log.push(`say: ${t}`),
      activity: (label, detail) => log.push(detail ? `${label} [${detail}]` : label),
      note: (t) => log.push(`note: ${t}`),
      working: () => {},
    },
    who: { agentId: "forge", sessionId: "s1" },
    cwd,
    approve: async () => false,
    audit: (r) => audited.push(`${r.request.agentId}:${r.request.operation}:${r.decision}`),
  };
  return { agent, received: parent.received, log, audited, childTools, childPrompts };
}

describe("agent files", () => {
  test("frontmatter sets name, tools, steps and model; the body is the instructions", () => {
    const type = parseAgentFile(
      "---\nname: reviewer\ndescription: Reviews diffs\ntools: read, grep\nmaxSteps: 12\nmodel: other-model\n---\nLook for bugs.\n",
      ".forge/agents/reviewer.md",
    );
    assert.deepEqual(type, {
      name: "reviewer", description: "Reviews diffs", tools: ["read", "grep"], maxSteps: 12,
      model: "other-model", instructions: "Look for bugs.", source: ".forge/agents/reviewer.md",
    });
  });

  test("no frontmatter or no name means it is not an agent; a bad step count falls back", () => {
    assert.equal(parseAgentFile("just text", "x"), null);
    assert.equal(parseAgentFile("---\ndescription: d\n---\n", "x"), null);
    assert.equal(parseAgentFile("---\nname: a\nmaxSteps: 0\n---\n", "x")!.maxSteps, 30);
  });

  test(".forge/agents adds types and can replace a built-in", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-types-"));
    fs.mkdirSync(path.join(cwd, ".forge/agents"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".forge/agents/reviewer.md"), "---\nname: reviewer\n---\n");
    fs.writeFileSync(path.join(cwd, ".forge/agents/explore.md"), "---\nname: explore\ndescription: Mine\n---\n");
    const types = loadAgentTypes(cwd);
    assert.deepEqual(types.map((t) => t.name), ["general", "explore", "reviewer"]);
    assert.equal(types.find((t) => t.name === "explore")!.description, "Mine");
  });
});

describe("task tool", () => {
  test("the child works on its own and only its report comes back", async () => {
    const { agent, received, log, childPrompts } = setup(
      [wants(1000, call("1", "task", { description: "find a", prompt: "Where is a defined?", agent: "explore" })), says(1200, "It is in src/a.ts.")],
      [[wants(300, call("c1", "read", { path: "src/a.ts" })), says(400, "a is defined in src/a.ts line 1.")]],
    );
    assert.equal(await runTurn("where is a?", agent), "It is in src/a.ts.");

    const result = (received[1] as ToolResult[])[0]!;
    assert.deepEqual(result, { id: "1", output: "a is defined in src/a.ts line 1.", isError: false });
    assert.ok(log.includes("explore · Read src/a.ts"), "the child's tool calls show, tagged");
    assert.ok(!log.some((l) => l.includes("say: a is defined")), "the child's report is not printed; the parent relays it");
    assert.match(childPrompts[0]!, /Forge sub-agent[\s\S]*Only look[\s\S]*BASE PROMPT/);
  });

  test("explore gets read-only tools, and no child gets the task tool", async () => {
    const { agent, childTools } = setup(
      [wants(10, call("1", "task", { description: "x", prompt: "x", agent: "explore" }), call("2", "task", { description: "y", prompt: "y" })), says(10, "ok")],
      [[says(10, "done")], [says(10, "done")]],
    );
    await runTurn("go", agent);
    const [explore, general] = childTools;
    assert.ok(explore!.includes("read") && !explore!.includes("write") && !explore!.includes("bash"));
    assert.ok(general!.includes("write") && general!.includes("bash"));
    assert.ok(!explore!.includes("task") && !general!.includes("task"));
  });

  test("the child's tool calls go through the same policy, audited under its name", async () => {
    const { agent, audited } = setup(
      [wants(10, call("1", "task", { description: "x", prompt: "x" })), says(10, "ok")],
      [[wants(10, call("c1", "write", { path: "docs/x.md", content: "x" })), says(10, "Could not write docs/x.md: declined.")]],
    );
    await runTurn("go", agent);
    assert.ok(audited.includes("forge/general:write:deny"), audited.join(", "));
    assert.equal(fs.existsSync(path.join(agent.cwd, "docs/x.md")), false);
  });

  test("tokens add up across parent and child; the context figure stays the parent's", async () => {
    const { agent } = setup(
      [wants(1000, call("1", "task", { description: "x", prompt: "x" })), says(1200, "ok")],
      [[wants(300, call("c1", "read", { path: "src/a.ts" })), says(400, "report")]],
    );
    await runTurn("go", agent);
    assert.equal(agent.usage.inputTokens, 1000 + 1200 + 300 + 400);
    assert.equal(agent.usage.contextUsed, 1210);
  });

  test("an unknown agent type, or a child with no report, is an error the model sees", async () => {
    const { agent, received } = setup(
      [wants(10, call("1", "task", { description: "x", prompt: "x", agent: "nope" }), call("2", "task", { description: "y", prompt: "y" })), says(10, "ok")],
      [[{ text: "", toolCalls: [], usage: usage(10), stopped: "refused" }]],
    );
    await runTurn("go", agent);
    const [unknown, empty] = received[1] as ToolResult[];
    assert.match(unknown!.output, /No agent named "nope"/);
    assert.equal(empty!.isError, true);
    assert.match(empty!.output, /without a report/);
  });
});

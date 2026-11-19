import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { CONTINUE, RECENT_CHARS, SUMMARY_PROMPT, carried, estimateTokens, shouldCompact, withSummary } from "../agent/compaction.js";
import { runTurn, type Agent } from "../agent/loop.js";
import { resolveModel } from "../agent/models.js";
import { anthropicSession } from "../agent/providers/anthropic.js";
import { openaiSession } from "../agent/providers/openai.js";
import type { Compaction, Reply, Session, ToolCall, ToolResult, ToolSpec } from "../agent/types.js";
import { UsageTracker } from "../agent/usage.js";
import { tools } from "../tools/index.js";

const READ: ToolSpec = {
  name: "read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

describe("when to compact", () => {
  test("past 70% of the window counting what's about to be sent; never with no window or when turned off", () => {
    assert.equal(shouldCompact(600, "x".repeat(400), 1000, 0.7), false, "600 + 100 = 700, not past 700");
    assert.equal(shouldCompact(600, "x".repeat(404), 1000, 0.7), true);
    assert.equal(shouldCompact(900, [{ id: "1", output: "big", isError: false }], 1000, 0.7), true);
    assert.equal(shouldCompact(999_999, "x", null, 0.7), false, "unknown window");
    assert.equal(shouldCompact(999_999, "x", 1000, 0), false, "turned off");
    assert.equal(estimateTokens([{ id: "1", output: "abcd".repeat(10), isError: false }]), 10);
  });

  test("after a compaction, not again until the conversation has grown 15% of the window past that point", () => {
    // Floor 600 (system prompt and tools): at 750 it's past 70% but has only grown 150, under 15% of 1000.
    assert.equal(shouldCompact(750, "", 1000, 0.7, 600), false);
    assert.equal(shouldCompact(760, "", 1000, 0.7, 600), true);
  });
});

describe("what replaces the conversation", () => {
  test("the user's request and the latest results are kept word for word, whatever the summary says", () => {
    const text = carried("did stuff", "fix the login bug", [{ id: "c1", output: "error at auth.ts:42", isError: true }]);
    assert.match(text, /\[A summary .*\]\ndid stuff/);
    assert.match(text, /\[The user's request, word for word, for reference.*\]\nfix the login bug/);
    assert.match(text, /\[The latest tool results, word for word\]\nResult of tool call c1:\nerror at auth\.ts:42/);
  });

  test("long results are cut; a pending message that is the request itself isn't repeated", () => {
    const long = carried("s", "r", [{ id: "c1", output: "x".repeat(RECENT_CHARS + 500), isError: false }]);
    assert.match(long, /\(cut\)$/);
    assert.ok(long.length < RECENT_CHARS + 300);
    assert.doesNotMatch(carried("s", "same", "same"), /latest tool results/);
  });
});

describe("compaction in the loop", () => {
  const savedAt = process.env["FORGE_COMPACT_AT"];
  afterEach(() => {
    if (savedAt === undefined) delete process.env["FORGE_COMPACT_AT"];
    else process.env["FORGE_COMPACT_AT"] = savedAt;
  });

  const call: ToolCall = { id: "c1", name: "read", input: { path: "a.txt" } };
  /** A model with a 1000-token window: the first reply is already at 900. */
  function setup() {
    const log: string[] = [];
    const replies: Reply[] = [
      { text: "", toolCalls: [call], usage: { inputTokens: 880, cachedTokens: 0, outputTokens: 20 }, stopped: "tools" },
      { text: "Done.", toolCalls: [], usage: { inputTokens: 150, cachedTokens: 0, outputTokens: 5 }, stopped: "done" },
    ];
    const session: Session = {
      async send(input) {
        log.push(`send ${typeof input === "string" ? JSON.stringify(input) : `results ${input.map((r) => r.id)}`}`);
        return replies.shift()!;
      },
      async compact(pending, latest): Promise<Compaction> {
        log.push(`compact pending=${Array.isArray(pending) ? `results ${pending.map((r) => r.id)}` : pending} latest=${latest}`);
        return { summary: "s".repeat(100), carried: "c".repeat(400), fallback: false, usage: { inputTokens: 950, cachedTokens: 0, outputTokens: 100 } };
      },
    };
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-compact-"));
    fs.writeFileSync(path.join(cwd, "a.txt"), "hello");
    const notes: string[] = [];
    const agent: Agent = {
      session, tools, cwd,
      policy: { version: 1, default: "deny", rules: [{ id: "r", resource: "filesystem", operation: "read", target: "**", effect: "allow" }] },
      usage: new UsageTracker(resolveModel({ FORGE_CONTEXT: "1000" })),
      screen: { say: () => {}, activity: () => {}, note: (t) => notes.push(t), working: () => {} },
      who: { agentId: "t", sessionId: "s" }, approve: async () => false, audit: () => {},
    };
    return { agent, log, notes };
  }

  test("mid-task, the pending tool results go into the summary and the model is told to continue", async () => {
    const { agent, log, notes } = setup();
    assert.equal(await runTurn("read a.txt", agent), "Done.");
    assert.deepEqual(log, ['send "read a.txt"', "compact pending=results c1 latest=read a.txt", `send ${JSON.stringify(CONTINUE)}`]);
    assert.match(notes[0]!, /Context 903 of 1k: summarizing the conversation to make room/);
    assert.match(notes[1]!, /Summarized: .* → about 100/);
    assert.equal(agent.usage.inputTokens, 880 + 950 + 150, "the summary request is counted");
    assert.equal(agent.usage.contextFloor, 150, "the size right after compacting is remembered");
  });

  test("compactAt 0 turns it off", async () => {
    process.env["FORGE_COMPACT_AT"] = "0";
    const { agent, log } = setup();
    await runTurn("read a.txt", agent);
    assert.deepEqual(log, ['send "read a.txt"', "send results c1"]);
  });
});

/** A local server: streamed requests get `stream`, others get `json`; every request body is recorded. */
async function server(handle: (body: Record<string, unknown>) => { status?: number; stream?: string[]; json?: unknown }) {
  const bodies: Record<string, unknown>[] = [];
  const s = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      bodies.push(body);
      const out = handle(body);
      if (out.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const e of out.stream) res.write(e);
        res.end();
      } else {
        res.writeHead(out.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(out.json ?? { error: { message: "fail", type: "api_error" } }));
      }
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, bodies, close: () => s.close() };
}

describe("compaction — OpenAI-compatible", () => {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const toolTurn = [chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] }, "tool_calls"), "data: [DONE]\n\n"];
  const textTurn = [chunk({ content: "ok" }, "stop"), "data: [DONE]\n\n"];
  const summaryJson = { id: "s", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "SUMMARY: read a, next edit b" }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 40, total_tokens: 540 } };

  let mode: "ok" | "fail" | "no-tool-choice" = "ok";
  let srv: Awaited<ReturnType<typeof server>>;
  before(async () => {
    srv = await server((body) => {
      if (body["stream"]) {
        const msgs = body["messages"] as Record<string, unknown>[];
        return { stream: msgs.at(-1)!["role"] === "tool" || String(msgs.at(-1)!["content"]).startsWith("[A summary") ? textTurn : toolTurn };
      }
      if (mode === "fail") return { status: 500 };
      if (mode === "no-tool-choice" && body["tool_choice"]) return { status: 400 };
      return { json: summaryJson };
    });
  });
  after(() => srv.close());

  test("the summary request holds the history, the pending results and the instructions; the history is then replaced", async () => {
    mode = "ok";
    const session = openaiSession("m", "SYSTEM", [READ], srv.url, "k");
    await session.send("read a");
    const pending: ToolResult[] = [{ id: "c1", output: "contents of a", isError: false }];
    const result = await session.compact!(pending, "read a");
    assert.deepEqual(result, {
      summary: "SUMMARY: read a, next edit b",
      carried: carried("SUMMARY: read a, next edit b", "read a", pending),
      fallback: false,
      usage: { inputTokens: 500, cachedTokens: 0, outputTokens: 40 },
    });

    const summaryReq = srv.bodies.at(-1)!;
    assert.equal(summaryReq["tool_choice"], "none");
    const roles = (summaryReq["messages"] as Record<string, unknown>[]).map((m) => m["role"]);
    assert.deepEqual(roles, ["system", "user", "assistant", "tool", "user"]);
    assert.equal((summaryReq["messages"] as Record<string, unknown>[]).at(-1)!["content"], SUMMARY_PROMPT);

    await session.send(CONTINUE);
    const next = srv.bodies.at(-1)!["messages"] as Record<string, unknown>[];
    assert.deepEqual(next.map((m) => m["role"]), ["system", "user"]);
    assert.equal(next[0]!["content"], "SYSTEM");
    assert.equal(next[1]!["content"], withSummary(carried("SUMMARY: read a, next edit b", "read a", pending), CONTINUE));
    assert.match(String(next[1]!["content"]), /word for word, for reference.*\]\nread a[\s\S]*word for word\]\nResult of tool call c1:\ncontents of a/);
  });

  test("a server that rejects tool_choice is asked again without it", async () => {
    mode = "no-tool-choice";
    const session = openaiSession("m", "SYSTEM", [READ], srv.url, "k");
    await session.send("read a");
    const result = await session.compact!([{ id: "c1", output: "x", isError: false }], "read a");
    assert.equal(result!.fallback, false);
    assert.equal(srv.bodies.at(-1)!["tool_choice"], undefined);
  });

  test("if summarizing fails, the history is cleared anyway and the user's request is kept", async () => {
    mode = "fail";
    const session = openaiSession("m", "SYSTEM", [READ], srv.url, "k");
    await session.send("read a");
    const result = await session.compact!([{ id: "c1", output: "x", isError: false }], "read a and fix it");
    assert.equal(result!.fallback, true);
    await session.send(CONTINUE);
    const next = srv.bodies.at(-1)!["messages"] as Record<string, unknown>[];
    assert.deepEqual(next.map((m) => m["role"]), ["system", "user"]);
    assert.match(String(next[1]!["content"]), /cleared because it no longer fit[\s\S]*read a and fix it/);
  });

  test("nothing to compact in a new conversation", async () => {
    assert.equal(await openaiSession("m", "SYSTEM", [READ], srv.url, "k").compact!(undefined, ""), null);
  });
});

describe("compaction — Anthropic", () => {
  const sse = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const textStream = [
    sse("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage } }),
    sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }),
    sse("content_block_stop", { index: 0 }),
    sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
    sse("message_stop", {}),
  ];
  const summaryJson = { id: "s", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text: "SUMMARY" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 700, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };

  let srv: Awaited<ReturnType<typeof server>>;
  const saved = { url: process.env["ANTHROPIC_BASE_URL"], key: process.env["ANTHROPIC_API_KEY"] };
  before(async () => {
    srv = await server((body) => (body["stream"] ? { stream: textStream } : { json: summaryJson }));
    process.env["ANTHROPIC_BASE_URL"] = srv.url;
    process.env["ANTHROPIC_API_KEY"] = "test-key";
  });
  after(() => {
    srv.close();
    if (saved.url === undefined) delete process.env["ANTHROPIC_BASE_URL"];
    else process.env["ANTHROPIC_BASE_URL"] = saved.url;
    if (saved.key === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = saved.key;
  });

  test("pending tool results and the instructions share one user message; the next request starts from the summary", async () => {
    const session = anthropicSession("claude-test", "SYSTEM", [READ]);
    await session.send("hi");
    const pending: ToolResult[] = [{ id: "toolu_1", output: "x", isError: false }];
    const result = await session.compact!(pending, "hi");
    assert.deepEqual(result, { summary: "SUMMARY", carried: carried("SUMMARY", "hi", pending), fallback: false, usage: { inputTokens: 700, cachedTokens: 0, outputTokens: 60 } });

    const req = srv.bodies.at(-1)!;
    assert.deepEqual(req["tool_choice"], { type: "none" });
    assert.ok(Array.isArray(req["tools"]), "tools stay defined, since the history holds tool calls");
    const last = (req["messages"] as Record<string, unknown>[]).at(-1)!;
    assert.deepEqual((last["content"] as Record<string, unknown>[]).map((b) => b["type"]), ["tool_result", "text"]);

    await session.send(CONTINUE);
    const next = srv.bodies.at(-1)!["messages"] as Record<string, unknown>[];
    assert.equal(next.length, 1);
    assert.equal(next[0]!["content"], withSummary(carried("SUMMARY", "hi", pending), CONTINUE));
  });
});

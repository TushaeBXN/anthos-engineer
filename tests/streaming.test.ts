import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { checkInput, runTurn, type Agent } from "../agent/loop.js";
import { resolveModel } from "../agent/models.js";
import { anthropicSession } from "../agent/providers/anthropic.js";
import { openaiSession } from "../agent/providers/openai.js";
import type { Reply, Session, ToolSpec } from "../agent/types.js";
import type { Screen } from "../agent/ui.js";
import { UsageTracker } from "../agent/usage.js";
import { tools } from "../tools/index.js";

const READ: ToolSpec = {
  name: "read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string", description: "Path" } }, required: ["path"] },
};

/** A local server that answers every POST with the given server-sent events, and records request bodies. */
async function sseServer(respond: (body: Record<string, unknown>) => { status?: number; events: string[] }) {
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      bodies.push(body);
      const { status = 200, events } = respond(body);
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "rejected", type: "invalid_request_error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const e of events) res.write(e);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies, close: () => server.close() };
}

const chunk = (choice: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: choice ? [{ index: 0, ...choice }] : [], ...extra })}\n\n`;

describe("streaming — OpenAI-compatible", () => {
  let server: Awaited<ReturnType<typeof sseServer>>;
  let rejectUsage = false;
  before(async () => {
    server = await sseServer((body) => {
      if (rejectUsage && body["stream_options"]) return { status: 400, events: [] };
      return {
        events: [
          chunk({ delta: { role: "assistant", content: "Read" } }),
          chunk({ delta: { content: "ing two files." } }),
          chunk({ delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read", arguments: "" } }] } }),
          chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }),
          chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }),
          chunk({ delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "read", arguments: '{"path":"b.ts"}' } }] } }),
          chunk({ delta: {}, finish_reason: "tool_calls" }),
          ...(body["stream_options"] ? [chunk(null, { usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } })] : []),
          "data: [DONE]\n\n",
        ],
      };
    });
  });
  after(() => server.close());

  test("text arrives in pieces; tool calls are rebuilt from theirs; usage comes from the last chunk", async () => {
    const session = openaiSession("m", "system", [READ], server.url, "k");
    const pieces: string[] = [];
    const reply = await session.send("go", (d) => pieces.push(d));

    assert.deepEqual(pieces, ["Read", "ing two files."]);
    assert.equal(reply.text, "Reading two files.");
    assert.deepEqual(reply.toolCalls, [
      { id: "call_a", name: "read", input: { path: "a.ts" } },
      { id: "call_b", name: "read", input: { path: "b.ts" } },
    ]);
    assert.deepEqual(reply.usage, { inputTokens: 120, cachedTokens: 0, outputTokens: 30 });
    assert.equal(reply.stopped, "tools");
    assert.equal(server.bodies.at(-1)!["stream"], true);
  });

  test("the reply goes back into the conversation, so the next request carries it", async () => {
    const session = openaiSession("m", "system", [READ], server.url, "k");
    await session.send("go");
    await session.send([{ id: "call_a", output: "x", isError: false }]);
    const messages = server.bodies.at(-1)!["messages"] as Record<string, unknown>[];
    const assistant = messages.find((m) => m["role"] === "assistant")!;
    assert.equal(assistant["content"], "Reading two files.");
    assert.equal((assistant["tool_calls"] as unknown[]).length, 2);
  });

  test("a server that rejects stream_options still works, without usage", async () => {
    rejectUsage = true;
    try {
      const reply = await openaiSession("m", "system", [READ], server.url, "k").send("go");
      assert.equal(reply.text, "Reading two files.");
      assert.deepEqual(reply.usage, { inputTokens: 0, cachedTokens: 0, outputTokens: 0 });
    } finally {
      rejectUsage = false;
    }
  });

  test("a reply cut off at the output limit says so", async () => {
    const cut = await sseServer(() => ({ events: [chunk({ delta: { content: "Half" } }), chunk({ delta: {}, finish_reason: "length" }), "data: [DONE]\n\n"] }));
    try {
      const reply = await openaiSession("m", "system", [], cut.url, "k").send("go");
      assert.equal(reply.stopped, "cut_off");
    } finally {
      cut.close();
    }
  });
});

const sse = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

describe("streaming — Anthropic", () => {
  let server: Awaited<ReturnType<typeof sseServer>>;
  const saved = { url: process.env["ANTHROPIC_BASE_URL"], key: process.env["ANTHROPIC_API_KEY"] };
  before(async () => {
    server = await sseServer(() => ({
      events: [
        sse("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } } }),
        sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Let me " } }),
        sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "look." } }),
        sse("content_block_stop", { index: 0 }),
        sse("content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } }),
        sse("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"path": "src/' } }),
        sse("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: 'a.ts"}' } }),
        sse("content_block_stop", { index: 1 }),
        sse("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 25 } }),
        sse("message_stop", {}),
      ],
    }));
    process.env["ANTHROPIC_BASE_URL"] = server.url;
    process.env["ANTHROPIC_API_KEY"] = "test-key";
  });
  after(() => {
    server.close();
    if (saved.url === undefined) delete process.env["ANTHROPIC_BASE_URL"];
    else process.env["ANTHROPIC_BASE_URL"] = saved.url;
    if (saved.key === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = saved.key;
  });

  test("text streams; the tool call and usage come from the final message", async () => {
    const pieces: string[] = [];
    const reply = await anthropicSession("claude-test", "system", [READ]).send("go", (d) => pieces.push(d));
    assert.deepEqual(pieces, ["Let me ", "look."]);
    assert.equal(reply.text, "Let me look.");
    assert.deepEqual(reply.toolCalls, [{ id: "toolu_1", name: "read", input: { path: "src/a.ts" } }]);
    assert.deepEqual(reply.usage, { inputTokens: 50, cachedTokens: 10, outputTokens: 25 });
    assert.equal(reply.stopped, "tools");
  });

  test("the request streams, with eager input streaming on every tool", async () => {
    await anthropicSession("claude-test", "system", [READ]).send("go");
    const body = server.bodies.at(-1)!;
    assert.equal(body["stream"], true);
    assert.deepEqual((body["tools"] as Record<string, unknown>[]).map((t) => t["eager_input_streaming"]), [true]);
  });
});

describe("streaming — an empty reply stays valid to send back", () => {
  test("OpenAI-compatible: the empty reply goes back as \"\", never null without tool calls (Ollama rejects that)", async () => {
    const server = await sseServer(() => ({ events: [chunk({ delta: { role: "assistant" } }), chunk({ delta: {}, finish_reason: "stop" }), "data: [DONE]\n\n"] }));
    try {
      const session = openaiSession("m", "system", [READ], server.url, "k");
      await session.send("go");
      await session.send("answer now");
      const messages = server.bodies.at(-1)!["messages"] as { role: string; content: unknown }[];
      assert.deepEqual(messages.map((m) => m.role), ["system", "user", "assistant", "user"]);
      assert.equal(messages[2]!.content, "");
    } finally {
      server.close();
    }
  });

  test("Anthropic: an empty reply isn't sent back at all (the API requires content)", async () => {
    const server = await sseServer(() => ({
      events: [
        sse("message_start", { message: { id: "msg_2", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
        sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } }),
        sse("message_stop", {}),
      ],
    }));
    const saved = { url: process.env["ANTHROPIC_BASE_URL"], key: process.env["ANTHROPIC_API_KEY"] };
    process.env["ANTHROPIC_BASE_URL"] = server.url;
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    try {
      const session = anthropicSession("claude-test", "system", [READ]);
      await session.send("go");
      await session.send("answer now");
      const messages = server.bodies.at(-1)!["messages"] as { role: string }[];
      assert.deepEqual(messages.map((m) => m.role), ["user", "user"]);
    } finally {
      server.close();
      if (saved.url === undefined) delete process.env["ANTHROPIC_BASE_URL"];
      else process.env["ANTHROPIC_BASE_URL"] = saved.url;
      if (saved.key === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = saved.key;
    }
  });
});

describe("streaming — the loop", () => {
  const says = (text: string): Reply => ({ text, toolCalls: [], usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 }, stopped: "done" });
  function agentWith(screen: Screen, pieces: string[]): Agent {
    const session: Session = {
      async send(_input, onText) {
        for (const p of pieces) onText?.(p);
        return says(pieces.join(""));
      },
    };
    return {
      session, tools, screen, policy: { version: 1, default: "deny", rules: [] }, usage: new UsageTracker(resolveModel({})),
      who: { agentId: "t", sessionId: "s" }, cwd: fs.mkdtempSync(path.join(os.tmpdir(), "forge-stream-")),
      approve: async () => false, audit: () => {},
    };
  }

  test("a screen that streams gets the pieces in order, then the whole reply once, and no say()", async () => {
    const log: string[] = [];
    const screen: Screen = {
      say: (t) => log.push(`say ${t}`), activity: () => {}, note: () => {},
      working: (on) => log.push(`working ${on}`),
      stream: (d) => log.push(`piece ${d}`),
      endStream: (t) => log.push(`end ${t}`),
    };
    await runTurn("hi", agentWith(screen, ["Hel", "lo."]));
    assert.deepEqual(log, ["working true", "working false", "piece Hel", "piece lo.", "working false", "end Hello."]);
  });

  test("a screen that doesn't stream gets say() once", async () => {
    const log: string[] = [];
    const screen: Screen = { say: (t) => log.push(`say ${t}`), activity: () => {}, note: () => {}, working: () => {} };
    await runTurn("hi", agentWith(screen, ["Hel", "lo."]));
    assert.deepEqual(log, ["say Hello."]);
  });
});

describe("tool input checks", () => {
  const schema: ToolSpec["inputSchema"] = {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "integer" },
      mode: { type: "string", enum: ["a", "b"] },
      tags: { type: ["array", "null"] },
    },
    required: ["path"],
  };
  test("required fields, types and allowed values are checked; extra fields and nullable types pass", () => {
    assert.equal(checkInput(schema, { path: "x", limit: 3, mode: "a", tags: null, extra: 1 }), null);
    assert.match(checkInput(schema, {})!, /Missing required input: path/);
    assert.match(checkInput(schema, { path: 5 })!, /"path" should be string, not number/);
    assert.match(checkInput(schema, { path: "x", limit: 2.5 })!, /"limit" should be integer/);
    assert.match(checkInput(schema, { path: "x", mode: "c" })!, /must be one of: "a", "b"/);
    assert.match(checkInput(schema, { path: "x", tags: {} })!, /"tags" should be array or null, not object/);
  });
});

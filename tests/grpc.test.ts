import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import type { Agent } from "../agent/loop.js";
import { resolveModel } from "../agent/models.js";
import type { AgentIO } from "../agent/start.js";
import type { Reply, ToolCall } from "../agent/types.js";
import { UsageTracker } from "../agent/usage.js";
import { forgeService, startServer } from "../grpc/server.js";
import { tools } from "../tools/index.js";

const USAGE = { inputTokens: 100, cachedTokens: 0, outputTokens: 10 };
const call = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id, name, input });
const wants = (...toolCalls: ToolCall[]): Reply => ({ text: "", toolCalls, usage: USAGE, stopped: "tools" });
const says = (text: string): Reply => ({ text, toolCalls: [], usage: USAGE, stopped: "done" });

/** Each session plays the next script: a bash command with no rule (so it needs approval), then an answer. */
function scriptedAgent(cwd: string, io: AgentIO): Agent {
  const replies = [wants(call("1", "bash", { command: "echo approved-ran" })), says("All done.")];
  const alwaysAllowed = new Set<string>();
  return {
    session: {
      // The final answer streams in two pieces, as a real model's would.
      async send(_input, onText) {
        const reply = replies.shift()!;
        if (reply.text) for (const piece of ["All ", "done."]) onText?.(piece);
        return reply;
      },
    },
    tools,
    policy: { version: 1, default: "deny", rules: [] },
    usage: new UsageTracker(resolveModel({})),
    screen: io.screen,
    who: { agentId: "forge", sessionId: "grpc-test" },
    cwd,
    interactive: true,
    async approve(label, reason) {
      if (alwaysAllowed.has(label)) return true;
      const answer = await io.ask(label, reason);
      return answer !== "no";
    },
    audit: () => {},
  };
}

type Event = Record<string, Record<string, unknown>> & { kind: string };

describe("gRPC server", () => {
  let port = 0;
  let stop: () => Promise<void>;
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-grpc-")));
  const { Forge } = forgeService();
  const clients: grpc.Client[] = [];
  const connect = (p = port) => {
    const client = new Forge(`127.0.0.1:${p}`, grpc.credentials.createInsecure());
    clients.push(client);
    return client;
  };

  before(async () => {
    ({ port, stop } = await startServer({ port: 0, makeAgent: scriptedAgent }));
  });
  after(async () => {
    clients.forEach((c) => c.close());
    await stop();
  });

  /** Open a session, run one turn, answer the approval with `approved`, collect every event. */
  function turn(approved: boolean, metadata = new grpc.Metadata(), client = connect()) {
    return new Promise<{ events: Event[]; error?: grpc.ServiceError }>((resolve) => {
      const events: Event[] = [];
      const stream = (client as unknown as { Session(m: grpc.Metadata): grpc.ClientDuplexStream<unknown, Event> }).Session(metadata);
      stream.on("data", (e: Event) => {
        events.push(e);
        if (e.kind === "ready") stream.write({ message: { text: "run it" } });
        if (e.kind === "approvalRequest") stream.write({ approval: { id: e.approvalRequest!.id, approved } });
        if (e.kind === "turnDone") stream.end();
      });
      stream.on("error", (error: grpc.ServiceError) => resolve({ events, error }));
      stream.on("end", () => resolve({ events }));
      stream.write({ start: { cwd } });
    });
  }

  test("a turn streams ready, the approval request, tool activity, the answer as it is written, and the final answer", async () => {
    const { events } = await turn(true);
    const kinds = events.map((e) => e.kind).filter((k) => k !== "working");
    assert.deepEqual(kinds, ["ready", "approvalRequest", "activity", "textDelta", "textDelta", "text", "turnDone"]);
    assert.deepEqual(events.filter((e) => e.kind === "textDelta").map((e) => e.textDelta!.text), ["All ", "done."]);
    assert.equal(events.find((e) => e.kind === "text")!.text!.text, "All done.");
    assert.equal(events.find((e) => e.kind === "approvalRequest")!.approvalRequest!.label, "Run echo approved-ran");
    assert.deepEqual(events.find((e) => e.kind === "activity")!.activity, { label: "Run echo approved-ran", detail: "", failed: false });
    const done = events.find((e) => e.kind === "turnDone")!.turnDone!;
    assert.equal(done.text, "All done.");
    assert.match(String(done.status), /claude-opus-5-5/);
  });

  test("a no from the client means the tool does not run", async () => {
    const { events } = await turn(false);
    assert.deepEqual(events.find((e) => e.kind === "activity")!.activity, { label: "Run echo approved-ran", detail: "declined", failed: true });
  });

  test("a message before Start is an error, not a crash", async () => {
    const client = connect();
    const event = await new Promise<Event>((resolve) => {
      const stream = (client as unknown as { Session(): grpc.ClientDuplexStream<unknown, Event> }).Session();
      stream.on("data", (e: Event) => {
        resolve(e);
        stream.end();
      });
      stream.write({ message: { text: "hi" } });
    });
    assert.equal(event.kind, "error");
    assert.match(String(event.error!.message), /Send Start/);
  });

  test("listening off localhost without a token is refused", async () => {
    await assert.rejects(startServer({ host: "0.0.0.0", port: 0 }), /FORGE_GRPC_TOKEN/);
  });

  test("with a token, a client without it is rejected and one with it gets through", async () => {
    const secured = await startServer({ port: 0, token: "s3cret", makeAgent: scriptedAgent });
    const client = connect(secured.port);
    try {
      const without = await turn(true, new grpc.Metadata(), client);
      assert.equal(without.error?.code, grpc.status.UNAUTHENTICATED);

      const metadata = new grpc.Metadata();
      metadata.set("authorization", "Bearer s3cret");
      const withToken = await turn(true, metadata, client);
      assert.ok(withToken.events.some((e) => e.kind === "turnDone"));
    } finally {
      await secured.stop();
    }
  });
});

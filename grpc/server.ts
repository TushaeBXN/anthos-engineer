/**
 * Forge as a gRPC service, for editors, web UIs and scripts. Each Session
 * stream is one conversation running the same agent loop as the terminal.
 * When the policy says "ask", the client gets an ApprovalRequest and the
 * turn waits for its answer; if the client goes away, the answer is no.
 *
 * Listens on 127.0.0.1 by default. Any other address needs a token.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { runTurn, type Agent } from "../agent/loop.js";
import { createAgent, type AgentIO } from "../agent/start.js";
import { statusLine } from "../agent/ui.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// From source the .proto sits next to this file; from dist/grpc/ it's back in the source folder.
export const PROTO_PATH = [path.join(here, "forge.proto"), path.join(here, "..", "..", "grpc", "forge.proto")].find((p) => fs.existsSync(p))!;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

type Event = Record<string, unknown>;
interface ClientMessage {
  kind?: "start" | "message" | "approval";
  start?: { cwd: string };
  message?: { text: string };
  approval?: { id: string; approved: boolean; always: boolean };
}
type Answer = "yes" | "no" | "always";

export interface ServeOptions {
  host?: string;
  port?: number;
  /** When set, clients must send "authorization: Bearer <token>". Required off localhost. */
  token?: string;
  /** Build the agent for a session. Tests pass a scripted one. */
  makeAgent?: (cwd: string, io: AgentIO) => Agent;
}

/** The generated service definition, shared by the server, tests and the example client. */
export function forgeService(): { Forge: grpc.ServiceClientConstructor } {
  const definition = protoLoader.loadSync(PROTO_PATH, { keepCase: false, defaults: true, oneofs: true });
  const pkg = grpc.loadPackageDefinition(definition) as unknown as { forge: { v1: { Forge: grpc.ServiceClientConstructor } } };
  return pkg.forge.v1;
}

export async function startServer(options: ServeOptions = {}): Promise<{ port: number; stop(): Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host) && !options.token) {
    throw new Error(`Listening on ${host} lets other machines drive Forge on this one. Set FORGE_GRPC_TOKEN to require a token.`);
  }

  const server = new grpc.Server();
  server.addService(forgeService().Forge.service, {
    Session: (call: grpc.ServerDuplexStream<ClientMessage, Event>) => session(call, options),
  });
  const address = host.includes(":") ? `[${host}]:${options.port ?? 50051}` : `${host}:${options.port ?? 50051}`;
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (err, bound) => (err ? reject(err) : resolve(bound))),
  );
  return {
    port,
    // Let open sessions finish for a moment, then close them.
    stop: () =>
      new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          server.forceShutdown();
          resolve();
        }, 1_000);
        server.tryShutdown(() => {
          clearTimeout(force);
          resolve();
        });
      }),
  };
}

function authorized(call: grpc.ServerDuplexStream<ClientMessage, Event>, token: string | undefined): boolean {
  if (!token) return true;
  const sent = Buffer.from(String(call.metadata.get("authorization")[0] ?? ""));
  const wanted = Buffer.from(`Bearer ${token}`);
  return sent.length === wanted.length && crypto.timingSafeEqual(sent, wanted);
}

function session(call: grpc.ServerDuplexStream<ClientMessage, Event>, options: ServeOptions): void {
  if (!authorized(call, options.token)) {
    call.emit("error", { code: grpc.status.UNAUTHENTICATED, details: "Missing or wrong token" });
    return;
  }

  let agent: Agent | undefined;
  let busy = false;
  let closed = false;
  const pending = new Map<string, (answer: Answer) => void>();

  const send = (event: Event) => {
    if (!closed) call.write(event);
  };
  const error = (message: string) => send({ error: { message } });

  const io: AgentIO = {
    screen: {
      say: (text) => send({ text: { text } }),
      activity: (label, detail, failed) => send({ activity: { label, detail: detail ?? "", failed: Boolean(failed) } }),
      note: (text) => send({ note: { text } }),
      working: (on) => send({ working: { on } }),
    },
    ask: (label, reason) =>
      new Promise<Answer>((resolve) => {
        if (closed) return resolve("no");
        const id = crypto.randomUUID();
        pending.set(id, resolve);
        send({ approvalRequest: { id, label, reason } });
      }),
  };

  call.on("data", (msg: ClientMessage) => {
    if (msg.kind === "start") {
      if (agent) return error("This session has already started.");
      const cwd = msg.start?.cwd || process.cwd();
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return error(`Not a folder: ${cwd}`);
      try {
        agent = (options.makeAgent ?? createAgent)(path.resolve(cwd), io);
      } catch (err) {
        return error((err as Error).message);
      }
      return send({ ready: { model: agent.usage.model.model, status: statusLine(agent.usage) } });
    }

    if (msg.kind === "message") {
      if (!agent) return error("Send Start before the first message.");
      if (busy) return error("A turn is already running. Wait for TurnDone.");
      busy = true;
      const current = agent;
      runTurn(msg.message?.text ?? "", current)
        .then((text) => send({ turnDone: { text, status: statusLine(current.usage) } }))
        .catch((err: Error) => error(err.message))
        .finally(() => (busy = false));
      return;
    }

    if (msg.kind === "approval") {
      const id = msg.approval?.id ?? "";
      const resolve = pending.get(id);
      if (!resolve) return error(`No approval request with id ${id}.`);
      pending.delete(id);
      return resolve(msg.approval!.always ? "always" : msg.approval!.approved ? "yes" : "no");
    }

    error("Unknown message.");
  });

  const close = () => {
    if (closed) return;
    closed = true;
    // Nobody is left to answer, so every open question is a no.
    for (const resolve of pending.values()) resolve("no");
    pending.clear();
  };
  call.on("end", () => {
    close();
    call.end();
  });
  call.on("cancelled", close);
  call.on("error", close);
}

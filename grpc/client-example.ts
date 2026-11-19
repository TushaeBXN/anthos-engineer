/**
 * A small client for `forge serve`: one question, events printed as they arrive.
 *
 *   npx tsx grpc/client-example.ts "what does agent/loop.ts do?" [--port 50051] [--cwd /path/to/project]
 *
 * Approval requests are asked in the terminal; with no terminal they are declined.
 * Set FORGE_GRPC_TOKEN if the server requires one.
 */
import readline from "node:readline/promises";
import * as grpc from "@grpc/grpc-js";
import { forgeService } from "./server.js";

type Event = { kind: string } & Record<string, Record<string, unknown>>;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const port = flag("--port") ?? "50051";
const cwd = flag("--cwd") ?? process.cwd();
const question = args.join(" ");
if (!question) {
  console.error('Usage: npx tsx grpc/client-example.ts "<question>" [--port N] [--cwd DIR]');
  process.exit(1);
}

const { Forge } = forgeService();
const client = new Forge(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
const metadata = new grpc.Metadata();
if (process.env["FORGE_GRPC_TOKEN"]) metadata.set("authorization", `Bearer ${process.env["FORGE_GRPC_TOKEN"]}`);

let streamed = false;
const stream = (client as unknown as { Session(m: grpc.Metadata): grpc.ClientDuplexStream<unknown, Event> }).Session(metadata);

stream.on("data", async (e: Event) => {
  switch (e.kind) {
    case "ready":
      console.log(`[ready] ${e.ready!.status}`);
      stream.write({ message: { text: question } });
      break;
    case "activity":
      console.log(`[tool] ${e.activity!.label}${e.activity!.detail ? `  ${e.activity!.detail}` : ""}`);
      break;
    case "textDelta":
      // Shown as it arrives; the full reply follows as "text".
      process.stdout.write(String(e.textDelta!.text));
      streamed = true;
      break;
    case "text":
      if (streamed) process.stdout.write("\n\n");
      else console.log(`\n${e.text!.text}\n`);
      streamed = false;
      break;
    case "note":
      console.log(`[note] ${e.note!.text}`);
      break;
    case "approvalRequest": {
      let approved = false;
      if (process.stdin.isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        approved = /^y/i.test(await rl.question(`[approve?] ${e.approvalRequest!.label} (y/n) `));
        rl.close();
      } else {
        console.log(`[approve?] ${e.approvalRequest!.label} -> declined (no terminal)`);
      }
      stream.write({ approval: { id: e.approvalRequest!.id, approved } });
      break;
    }
    case "turnDone":
      console.log(`[done] ${e.turnDone!.status}`);
      stream.end();
      break;
    case "error":
      console.error(`[error] ${e.error!.message}`);
      stream.end();
      break;
  }
});
stream.on("error", (err: grpc.ServiceError) => {
  console.error(`[connection] ${err.details || err.message}`);
  process.exitCode = 1;
});
stream.on("end", () => client.close());
stream.write({ start: { cwd } });

#!/usr/bin/env node
/**
 * The forge command.
 *
 *   forge                 Start a conversation
 *   forge "<request>"     Do one thing and exit
 *   forge doctor          Check the setup
 *   forge init            Index the project, for find_dependents
 *   forge query <name>    Show what depends on a function or module
 */
import { glob } from "glob";
import { runTurn } from "../agent/loop.js";
import { createAgent } from "../agent/start.js";
import { PROVIDERS, RC_PATH, detectContextWindow, resolveModel, writeRc } from "../agent/models.js";
import type { McpConnection } from "../agent/mcp.js";
import { confirm, printHeader, printStatus, prompt, statusLine, terminal } from "../agent/ui.js";
import { runCommand, type CommandContext } from "./commands.js";

const HELP = `
  forge                          Start a conversation
  forge "<request>"              Do one thing and exit
  forge doctor [--json]          Check the setup and say how to fix what's wrong
  forge providers                List providers and the key each needs
  forge serve [--port N]         Run Forge as a gRPC service (grpc/forge.proto)
  forge init                     Index the project
  forge query <name>             Show what depends on a function or module
  forge config set <key> <val>   Save a setting to ~/.forgerc
  forge config get               Show the current ~/.forgerc

  Keys: provider  model  baseUrl  budget  context  priceInput  priceOutput  repoMap  compactAt
  Example: forge config set provider ollama
           forge config set model forge-deepseek
`;

/** Start the MCP servers in ~/.forge/mcp.json and .forge/mcp.json, and say how each went. */
async function startMcp(): Promise<McpConnection> {
  const { connectMcp } = await import("../agent/mcp.js");
  const mcp = await connectMcp(process.cwd(), { trust: process.stdin.isTTY ? (q) => confirm(`${q}?`) : undefined });
  for (const s of mcp.servers) {
    terminal.note(`MCP ${s.name}: ${s.state === "connected" ? `${s.tools} tools` : `${s.state} — ${s.detail}`}`);
  }
  return mcp;
}

/** One request, then exit. */
async function once(request: string): Promise<void> {
  await detectContextWindow();
  const mcp = await startMcp();
  try {
    const agent = createAgent(process.cwd(), undefined, mcp.tools);
    await runTurn(request, agent);
    printStatus(agent.usage);
  } finally {
    await mcp.close();
  }
}

/** A conversation: read a line, run a turn, show the status line, repeat. */
async function chat(): Promise<void> {
  await detectContextWindow();
  const mcp = await startMcp();
  try {
    await conversation(mcp);
  } finally {
    await mcp.close();
  }
}

async function conversation(mcp: McpConnection): Promise<void> {
  let agent = createAgent(process.cwd(), undefined, mcp.tools);
  let lastText = "";

  const ctx: CommandContext = {
    get agent() { return agent; },
    reset() { agent = createAgent(process.cwd(), undefined, mcp.tools); lastText = ""; },
    lastText() { return lastText; },
  };

  printHeader(statusLine(agent.usage));

  while (true) {
    const line = await prompt();
    if (line === null || line.trim() === "exit" || line.trim() === "quit") break;
    if (line.trim() === "") continue;

    const { handled, result } = await runCommand(line, ctx);
    if (handled) {
      if (result?.exit) break;
      if (result?.refreshStatus) printStatus(agent.usage);
      if (!result?.inject) continue;
      // /compact injects a summary as the next user message.
      lastText = await runTurn(result.inject, agent);
      printStatus(agent.usage);
      continue;
    }

    lastText = await runTurn(line, agent);
    printStatus(agent.usage);
  }
}

async function init(): Promise<void> {
  const { resetDb } = await import("../model/events.js");
  const { resetGraph, getGraph } = await import("../model/graph.js");
  const { initFromFiles } = await import("../model/incremental.js");
  const { TypeScriptExtractor } = await import("../model/typescript/ts-extractor.js");

  resetDb();
  resetGraph();
  const files = await glob("**/*.{ts,tsx,mts,cts}", {
    ignore: ["node_modules/**", "dist/**", ".forge/**", "**/*.d.ts"],
  });
  if (files.length === 0) {
    console.log("\n  No TypeScript files found.\n");
    return;
  }

  await initFromFiles(files, new TypeScriptExtractor());
  const graph = getGraph();
  console.log(`\n  Indexed ${files.length} files: ${graph.nodeCount()} functions and modules, ${graph.edgeCount()} links.\n`);
}

/** forge serve [--port N] [--host H]: run Forge as a gRPC service. */
async function serve(args: string[]): Promise<void> {
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const { startServer } = await import("../grpc/server.js");
  const host = flag("--host") ?? "127.0.0.1";
  // Started once for the whole server. No one can approve a project's servers here, so only trusted ones start.
  const { connectMcp } = await import("../agent/mcp.js");
  await detectContextWindow();
  const mcp = await connectMcp(process.cwd());
  for (const s of mcp.servers) console.log(`  MCP ${s.name}: ${s.state === "connected" ? `${s.tools} tools` : `${s.state} — ${s.detail}`}`);
  const { port } = await startServer({ host, port: Number(flag("--port") ?? 50051), token: process.env["FORGE_GRPC_TOKEN"] || undefined, extraTools: mcp.tools });
  console.log(`\n  Forge gRPC server on ${host}:${port}${process.env["FORGE_GRPC_TOKEN"] ? " (token required)" : ""}`);
  console.log("  Protocol: grpc/forge.proto. Press Ctrl+C to stop.\n");
}

/** Every provider Forge knows, the key each needs, and whether that key is set. Keys are never printed. */
function providers(): void {
  let current = "";
  try {
    current = resolveModel().provider;
  } catch {
    // No model chosen yet; nothing to mark.
  }
  console.log("");
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const key = p.keyEnv ? `${p.keyEnv} ${process.env[p.keyEnv] ? "(set)" : "(not set)"}` : "no key needed";
    const mark = name === current ? "▶" : " ";
    console.log(`  ${mark} ${name.padEnd(11)} ${`${p.weights} · ${p.runs}`.padEnd(18)} ${key.padEnd(32)} ${p.note ?? ""}`);
  }
  console.log(`
  Any other OpenAI-compatible server:
    forge config set provider <name>   forge config set baseUrl <url>   export FORGE_API_KEY=...

  Switch:  forge config set provider openrouter
           forge config set model <model-name>
`);
}

/** forge doctor [--json] [--no-mcp]: check the setup. Exits 1 when something must be fixed. */
async function doctor(args: string[]): Promise<void> {
  const { runDoctor, formatChecks } = await import("../agent/doctor.js");
  const checks = await runDoctor({ cwd: process.cwd(), mcp: !args.includes("--no-mcp") });
  console.log(args.includes("--json") ? JSON.stringify(checks, null, 2) : formatChecks(checks));
  if (checks.some((c) => c.state === "fail")) process.exitCode = 1;
}

async function query(name: string): Promise<void> {
  const { findDependents } = await import("../tools/project.js");
  const result = await findDependents.run({ name }, process.cwd());
  console.log(`\n${result.output.replace(/^/gm, "  ")}\n`);
  if (result.isError) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === undefined) return chat();
  if (command === "help" || command === "--help" || command === "-h") return console.log(HELP);
  if (command === "init") return init();
  if (command === "providers") return providers();
  if (command === "doctor") return doctor(rest);
  if (command === "serve") return serve(rest);
  if (command === "config") {
    const [sub, key, ...vals] = rest;
    if (sub === "get" || sub === undefined) {
      const fs = await import("node:fs");
      const text = fs.default.existsSync(RC_PATH) ? fs.default.readFileSync(RC_PATH, "utf8") : "(no ~/.forgerc yet)";
      console.log(`\n  ${RC_PATH}\n\n${text.replace(/^/gm, "  ")}`);
      return;
    }
    if (sub === "set") {
      if (!key || vals.length === 0) throw new Error("Usage: forge config set <key> <value>");
      const val = vals.join(" ");
      const numKeys = new Set(["budget", "context", "priceInput", "priceOutput", "repoMap", "compactAt"]);
      writeRc({ [key]: numKeys.has(key) ? Number(val) : val });
      console.log(`\n  Saved ${key}=${val} to ${RC_PATH}\n`);
      return;
    }
    throw new Error(`Unknown config subcommand: ${sub}. Use "get" or "set".`);
  }
  if (command === "query") {
    if (rest.length === 0) throw new Error("Usage: forge query <name>");
    return query(rest.join(" "));
  }
  // "forge change <request>" is the old spelling of "forge <request>".
  const request = (command === "change" ? rest : [command, ...rest]).join(" ");
  if (request === "") throw new Error('Usage: forge "<request>"');
  return once(request);
}

main().catch((err) => {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exit(1);
});

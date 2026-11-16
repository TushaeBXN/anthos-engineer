#!/usr/bin/env node
/**
 * The forge command.
 *
 *   forge                 Start a conversation
 *   forge "<request>"     Do one thing and exit
 *   forge init            Index the project, for find_dependents
 *   forge query <name>    Show what depends on a function or module
 */
import { glob } from "glob";
import { runTurn } from "../agent/loop.js";
import { createAgent } from "../agent/start.js";
import { printHeader, printStatus, prompt, statusLine } from "../agent/ui.js";
import { runCommand, type CommandContext } from "./commands.js";

const HELP = `
  forge                 Start a conversation
  forge "<request>"     Do one thing and exit
  forge init            Index the project
  forge query <name>    Show what depends on a function or module

  Choose a model with FORGE_PROVIDER and FORGE_MODEL.
  Set a spending limit with FORGE_BUDGET_USD.
`;

/** One request, then exit. */
async function once(request: string): Promise<void> {
  const agent = createAgent();
  await runTurn(request, agent);
  printStatus(agent.usage);
}

/** A conversation: read a line, run a turn, show the status line, repeat. */
async function chat(): Promise<void> {
  let agent = createAgent();
  let lastText = "";

  const ctx: CommandContext = {
    get agent() { return agent; },
    reset() { agent = createAgent(); lastText = ""; },
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

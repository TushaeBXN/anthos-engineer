/**
 * Slash commands for the Forge REPL.
 *
 * Grouped by what they do:
 *
 *   Session    /clear /compact /exit
 *   Status     /status /cost /model /provider /budget
 *   History    /history /undo /files /diff
 *   Project    /init /query /tools /policy /audit
 *   Output     /copy /save /help
 *   Insight    /agents /mcp /repomap /telemetry
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { CreatedAgent } from "../agent/start.js";
import { printStatus } from "../agent/ui.js";
import type { UsageTracker } from "../agent/usage.js";

export interface CommandContext {
  agent: CreatedAgent;
  /** Reinitialize the session (for /clear and /compact). */
  reset(): void;
  /** Summary of the last reply, for /compact. */
  lastText(): string;
}

export interface CommandResult {
  /** If set, replace the next user message with this text (e.g. /compact). */
  inject?: string;
  /** If true, exit the REPL. */
  exit?: boolean;
  /** If true, the caller should re-print the status line. */
  refreshStatus?: boolean;
}

type Handler = (args: string, ctx: CommandContext) => Promise<CommandResult | void> | CommandResult | void;

interface Command {
  description: string;
  usage?: string;
  run: Handler;
}

const registry = new Map<string, Command>();

function cmd(name: string, def: Command): void {
  registry.set(name, def);
}

// ── Session ───────────────────────────────────────────────────────────────────

cmd("clear", {
  description: "Clear the conversation history and start fresh.",
  run(_args, ctx) {
    ctx.reset();
    console.log("\n  Conversation cleared.\n");
    return { refreshStatus: true };
  },
});

cmd("compact", {
  description: "Summarize the conversation now to free up context (Forge also does this on its own when it fills up).",
  async run(_args, ctx) {
    const { compact } = await import("../agent/loop.js");
    if (!ctx.agent.session.compact) {
      console.log("\n  This model's connection can't summarize the conversation.\n");
      return;
    }
    if (!(await compact(ctx.agent, undefined, ""))) {
      console.log("\n  Nothing to compact yet.\n");
      return;
    }
    return { refreshStatus: true };
  },
});

cmd("exit", {
  description: "Exit Forge.",
  run() {
    return { exit: true };
  },
});

// ── Status ────────────────────────────────────────────────────────────────────

cmd("status", {
  description: "Show token usage, cost, and lines changed.",
  run(_args, ctx) {
    printStatus(ctx.agent.usage);
  },
});

cmd("cost", {
  description: "Show estimated cost so far and remaining budget.",
  run(_args, ctx) {
    const u = ctx.agent.usage;
    const cost = u.costUsd;
    const parts: string[] = [];
    if (cost !== null) parts.push(`$${cost.toFixed(4)} used`);
    if (u.budgetUsd !== null) {
      const left = Math.max(0, u.budgetUsd - (cost ?? 0));
      parts.push(`$${left.toFixed(4)} left of $${u.budgetUsd.toFixed(2)} budget`);
    } else {
      parts.push("no budget set (FORGE_BUDGET_USD)");
    }
    if (u.model.runs === "local") parts.push("running locally — no API cost");
    console.log(`\n  ${parts.join("  ·  ")}\n`);
  },
});

cmd("model", {
  description: "Show the current model.",
  run(_args, ctx) {
    const { model } = ctx.agent.usage.model;
    const { weights, runs } = ctx.agent.usage.model;
    console.log(`\n  ${model}  ·  ${weights}  ·  ${runs}\n`);
  },
});

cmd("provider", {
  description: "Show the current provider.",
  run(_args, ctx) {
    const { provider } = ctx.agent.usage.model;
    console.log(`\n  ${provider}\n`);
  },
});

cmd("budget", {
  description: "Show or set the spending limit.",
  usage: "/budget [amount]",
  run(args, ctx) {
    if (args.trim()) {
      const n = parseFloat(args.trim().replace(/^\$/, ""));
      if (isNaN(n) || n <= 0) {
        console.log("\n  Usage: /budget <amount>  e.g. /budget 5\n");
        return;
      }
      (ctx.agent.usage as UsageTrackerInternal).budgetUsd = n;
      console.log(`\n  Budget set to $${n.toFixed(2)}\n`);
    } else {
      const b = ctx.agent.usage.budgetUsd;
      console.log(`\n  ${b !== null ? `$${b.toFixed(2)}` : "No budget set"}  (FORGE_BUDGET_USD)\n`);
    }
  },
});

// ── History ───────────────────────────────────────────────────────────────────

cmd("history", {
  description: "List files changed in this session, most recent first.",
  run(_args, ctx) {
    const snaps = ctx.agent.undo.all();
    if (snaps.length === 0) {
      console.log("\n  No file changes yet.\n");
      return;
    }
    console.log("");
    for (const s of snaps) {
      const when = s.at.toLocaleTimeString();
      const what = s.before === null ? "created" : "modified";
      console.log(`  ${when}  ${s.path}  (${what})`);
    }
    console.log("");
  },
});

cmd("undo", {
  description: "Undo the last file change.",
  async run(_args, ctx) {
    const snap = ctx.agent.undo.pop();
    if (!snap) {
      console.log("\n  Nothing to undo.\n");
      return;
    }
    if (snap.before === null) {
      await fs.unlink(snap.abs).catch(() => null);
      console.log(`\n  Deleted ${snap.path} (it was newly created).\n`);
    } else {
      await fs.writeFile(snap.abs, snap.before, "utf8");
      console.log(`\n  Restored ${snap.path} to its state before the last change.\n`);
    }
  },
});

cmd("files", {
  description: "List files changed in this session.",
  run(_args, ctx) {
    const files = ctx.agent.usage.changedFiles;
    if (files.length === 0) {
      console.log("\n  No files changed yet.\n");
      return;
    }
    console.log(`\n  ${files.join("\n  ")}\n`);
  },
});

cmd("diff", {
  description: "Show the git diff of changes in this session.",
  async run(_args, ctx) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    try {
      const { stdout } = await run("git", ["diff", "HEAD"], { cwd: ctx.agent.cwd });
      console.log(stdout || "\n  No changes tracked by git yet.\n");
    } catch {
      console.log("\n  Not a git repository or no commits yet.\n");
    }
  },
});

// ── Project ───────────────────────────────────────────────────────────────────

cmd("init", {
  description: "Index the project for find_dependents.",
  async run(_args, ctx) {
    const { resetDb } = await import("../model/events.js");
    const { resetGraph, getGraph } = await import("../model/graph.js");
    const { initFromFiles } = await import("../model/incremental.js");
    const { TypeScriptExtractor } = await import("../model/typescript/ts-extractor.js");
    const { glob: globFn } = await import("glob");
    resetDb();
    resetGraph();
    const files = await globFn("**/*.{ts,tsx,mts,cts}", {
      cwd: ctx.agent.cwd,
      ignore: ["node_modules/**", "dist/**", ".forge/**", "**/*.d.ts"],
    });
    if (files.length === 0) {
      console.log("\n  No TypeScript files found.\n");
      return;
    }
    await initFromFiles(files, new TypeScriptExtractor());
    const graph = getGraph();
    console.log(`\n  Indexed ${files.length} files: ${graph.nodeCount()} symbols, ${graph.edgeCount()} links.\n`);
  },
});

cmd("query", {
  description: "Show what depends on a symbol or module.",
  usage: "/query <name>",
  async run(args) {
    if (!args.trim()) {
      console.log("\n  Usage: /query <name>\n");
      return;
    }
    const { findDependents } = await import("../tools/project.js");
    const result = await findDependents.run({ name: args.trim() }, process.cwd());
    console.log(`\n${result.output.replace(/^/gm, "  ")}\n`);
  },
});

cmd("tools", {
  description: "List the tools available to the agent.",
  run(_args, ctx) {
    console.log("");
    for (const t of ctx.agent.tools) {
      console.log(`  ${t.name.padEnd(16)} ${t.description.split(".")[0]}`);
    }
    console.log("");
  },
});

cmd("policy", {
  description: "Show the current forge.policy.yaml.",
  async run(_args, ctx) {
    const file = path.join(ctx.agent.cwd, "forge.policy.yaml");
    const text = await fs.readFile(file, "utf8").catch(() => null);
    if (!text) {
      console.log("\n  No forge.policy.yaml found.\n");
      return;
    }
    console.log(`\n${text.replace(/^/gm, "  ")}`);
  },
});

cmd("audit", {
  description: "Show the last 20 entries in the audit log.",
  async run() {
    const { getAuditLog } = await import("../policy/audit.js");
    const rows = getAuditLog(20);
    if (rows.length === 0) {
      console.log("\n  No audit log entries yet.\n");
      return;
    }
    console.log("");
    for (const r of rows) {
      const mark = r.decision === "allow" ? "✓" : r.decision === "deny" ? "✗" : "?";
      console.log(`  ${mark} ${r.resource} ${r.operation} ${r.target}  — ${r.reason}`);
    }
    console.log("");
  },
});

cmd("mcp", {
  description: "Show MCP servers and how many tools each gave.",
  async run(_args, ctx) {
    const { mcpStatus } = await import("../agent/mcp.js");
    const servers = mcpStatus();
    console.log("");
    if (servers.length === 0) console.log("  No MCP servers. Add them to ~/.forge/mcp.json or .forge/mcp.json.");
    for (const s of servers) {
      const state = s.state === "connected" ? `${s.tools} tools` : `${s.state} — ${s.detail}`;
      console.log(`  ${s.name.padEnd(16)} ${s.source.padEnd(8)} ${state}`);
    }
    const names = ctx.agent.tools.filter((t) => t.name.startsWith("mcp__")).map((t) => t.name);
    if (names.length > 0) console.log(`\n  ${names.join("\n  ")}`);
    console.log("");
  },
});

cmd("agents", {
  description: "List the sub-agent types the task tool can use.",
  async run(_args, ctx) {
    const { loadAgentTypes } = await import("../agent/subagents.js");
    console.log("");
    for (const t of loadAgentTypes(ctx.agent.cwd)) {
      const tools = t.tools ? t.tools.join(", ") : "all tools";
      console.log(`  ${t.name.padEnd(12)} ${t.description}`);
      console.log(`  ${"".padEnd(12)} ${tools} · up to ${t.maxSteps} steps · ${t.source}`);
    }
    console.log("\n  Add your own as markdown files in .forge/agents/.\n");
  },
});

cmd("repomap", {
  description: "Show the project map the model sees in its instructions.",
  usage: "/repomap [tokens]",
  async run(args, ctx) {
    const { buildRepoMap } = await import("../agent/repomap.js");
    const { repoMapBudget } = await import("../agent/models.js");
    const budget = Number(args.trim()) || repoMapBudget() || 1024;
    const map = buildRepoMap(ctx.agent.cwd, budget);
    if (!map.text) {
      console.log("\n  No source files found to map.\n");
      return;
    }
    console.log(`\n${map.text.replace(/^/gm, "  ")}\n\n  ${map.shown} of ${map.files} files in ${budget} tokens.\n`);
  },
});

cmd("telemetry", {
  description: "Show tool call stats for this session.",
  async run() {
    const { telemetry } = await import("../agent/telemetry.js");
    console.log(telemetry.summary());
  },
});

// ── Output ────────────────────────────────────────────────────────────────────

cmd("copy", {
  description: "Copy the last reply to the clipboard.",
  async run(_args, ctx) {
    const text = ctx.lastText();
    if (!text) {
      console.log("\n  Nothing to copy yet.\n");
      return;
    }
    const { execSync } = await import("node:child_process");
    try {
      execSync("pbcopy", { input: text });
      console.log("\n  Copied to clipboard.\n");
    } catch {
      console.log("\n  pbcopy not available on this system.\n");
    }
  },
});

cmd("save", {
  description: "Save the last reply to a file.",
  usage: "/save [filename]",
  async run(args, ctx) {
    const text = ctx.lastText();
    if (!text) {
      console.log("\n  Nothing to save yet.\n");
      return;
    }
    const name = args.trim() || `forge-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    await fs.writeFile(name, text, "utf8");
    console.log(`\n  Saved to ${name}\n`);
  },
});

cmd("help", {
  description: "List all slash commands.",
  run() {
    console.log("\n  Slash commands:\n");
    for (const [name, def] of registry) {
      const usage = def.usage ?? `/${name}`;
      console.log(`  ${usage.padEnd(24)} ${def.description}`);
    }
    console.log("");
  },
});

// ── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * Try to run a slash command. Returns true when the input was a command,
 * false when it should be sent to the model instead.
 */
export async function runCommand(
  line: string,
  ctx: CommandContext,
): Promise<{ handled: boolean; result?: CommandResult }> {
  if (!line.startsWith("/")) return { handled: false };
  const [name, ...rest] = line.slice(1).trim().split(/\s+/);
  const command = registry.get(name ?? "");
  if (!command) {
    console.log(`\n  Unknown command: /${name}. Type /help for a list.\n`);
    return { handled: true };
  }
  const result = await command.run(rest.join(" "), ctx);
  return { handled: true, result: result ?? undefined };
}

// Needed for /budget to mutate the readonly field — cast away readonly internally.
interface UsageTrackerInternal {
  budgetUsd: number | null;
}

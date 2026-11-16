/**
 * Demo worker — runs as a subprocess.
 * Runs the same agent loop as the forge command, in a sandbox.
 * Receives: argv[2] = goal, argv[3] = sandboxDir
 * Emits JSON-line events to stdout, each prefixed with "EVENT:"
 * so the server can distinguish them from other Node.js output.
 */
import { glob } from "glob";
import { execSync } from "node:child_process";
import { resetDb, getLatestEventId, getEventsSince } from "../model/events.js";
import { resetGraph, getGraph } from "../model/graph.js";
import { initFromFiles, localInvalidation, rebuildGraph } from "../model/incremental.js";
import { TypeScriptExtractor } from "../model/typescript/ts-extractor.js";
import fs from "node:fs";
import path from "node:path";
import { runTurn } from "../agent/loop.js";
import { createAgent } from "../agent/start.js";
import { runVerificationChain } from "../verify/chain.js";
import { computeSemanticDiff } from "../diff/semantic.js";

const goal = process.argv[2] ?? "";
const sandboxDir = process.argv[3] ?? process.cwd();

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`EVENT:${JSON.stringify(event)}\n`);
}

process.chdir(sandboxDir);

async function run(): Promise<void> {
  // ── 1. Index the sandbox ──────────────────────────────────────────────────
  emit({ type: "status", message: "Indexing project…" });
  resetDb();
  resetGraph();

  const extractor = new TypeScriptExtractor();
  const files = await glob("**/*.{ts,tsx}", {
    cwd: sandboxDir,
    ignore: ["node_modules/**", "dist/**", ".forge/**", "**/*.d.ts"],
    absolute: false,
  });

  await initFromFiles(files, extractor);
  const graph = getGraph();
  const nodes = graph.getNodes();

  emit({
    type: "model",
    nodes: nodes.length,
    edges: graph.getEdges().length,
    modules: nodes.filter((n) => n.kind === "module").length,
    functions: nodes.filter((n) => n.kind === "function").length,
  });

  // ── 2. Run the agent loop, reporting each step to the page ────────────────
  const agent = createAgent(sandboxDir);
  emit({ type: "planning", provider: agent.usage.model.provider, model: agent.usage.model.model });

  let planShown = false;
  const showPlan = (text: string): void => {
    if (planShown) return;
    planShown = true;
    emit({ type: "plan", rationale: text, steps: [] });
  };

  agent.screen = {
    say(text) {
      if (planShown) emit({ type: "status", message: text });
      else showPlan(text);
    },
    activity(label, detail, failed) {
      const [verb, file] = label.split(" ");
      if (!failed && (verb === "Write" || verb === "Edit") && file) {
        const bytes = fs.statSync(path.join(sandboxDir, file)).size;
        emit({ type: "file-written", file, bytes });
      } else {
        emit({ type: "status", message: detail ? `${label} (${detail})` : label });
      }
    },
    note: (text) => emit({ type: "status", message: text }),
    working: () => {},
  };
  // Nobody is at a keyboard in the demo, so anything the policy does not allow outright is refused.
  agent.approve = async () => false;
  agent.audit = (record) => {
    if (record.request.resource === "filesystem" && record.request.operation === "read") return;
    showPlan("Working through the change step by step.");
    emit({
      type: "policy",
      file: record.request.resource === "filesystem" ? record.request.target : `${record.request.resource} ${record.request.operation}`,
      decision: record.decision,
      rule: record.matchedRuleId,
      reason: record.reason,
    });
  };

  await runTurn(goal, agent);
  emit({ type: "usage", parts: agent.usage.statusParts() });

  // ── 3. Update the index for the files that changed ────────────────────────
  rebuildGraph();
  const changeEvents: ReturnType<typeof getEventsSince> = [];
  for (const file of agent.usage.changedFiles) {
    const beforeId = getLatestEventId();
    try {
      await localInvalidation(file, extractor);
    } catch {
      // Non-fatal — semantic diff may be incomplete
    }
    changeEvents.push(...getEventsSince(beforeId));
  }

  // ── 4b. Capture git diff for UI ──────────────────────────────────────────
  try {
    const rawDiff = execSync("git diff HEAD", { cwd: sandboxDir, encoding: "utf-8" });
    if (rawDiff.trim()) emit({ type: "git-diff", diff: rawDiff });
  } catch { /* not in a git repo or no changes — non-fatal */ }

  // ── 5. Verification chain ─────────────────────────────────────────────────
  emit({ type: "verify-start" });
  const chainResult = await runVerificationChain(sandboxDir);

  for (const stage of chainResult.stages) {
    emit({
      type: "verify-stage",
      stage: stage.stage,
      passed: stage.passed,
      skipped: stage.skipped,
      durationMs: stage.durationMs,
      skipReason: stage.skipReason ?? null,
      output: stage.passed
        ? null
        : (stage.stderr || stage.stdout).slice(0, 600),
    });
  }
  emit({ type: "verify-done", passed: chainResult.passed });

  // ── 6. Semantic diff ──────────────────────────────────────────────────────
  const diff = computeSemanticDiff(changeEvents, getGraph());
  emit({
    type: "diff",
    groups: diff.groups.map((g) => ({
      category: g.category,
      changes: g.changes.map((c) => ({ kind: c.kind, name: c.name, file: c.filePath })),
    })),
    blastRadius: diff.blastRadius,
  });

  emit({ type: "done", success: chainResult.passed });
}

run().catch((err) => {
  emit({ type: "error", message: (err as Error).message });
  process.exit(1);
});

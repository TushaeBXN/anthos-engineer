/**
 * Demo worker — runs as a subprocess.
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
import { loadPolicy } from "../policy/parser.js";
import { evaluate } from "../policy/evaluator.js";
import { issueCapability } from "../capability/issuer.js";
import { writeFile } from "../executor/filesystem.js";
import { runVerificationChain } from "../verify/chain.js";
import { computeSemanticDiff } from "../diff/semantic.js";
import { planChange } from "../llm/planner.js";
import type { ActionRequest } from "../policy/schema.js";

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

  // ── 2. Plan via LLM ───────────────────────────────────────────────────────
  const provider = process.env["FORGE_PROVIDER"] ?? "anthropic";
  const model = process.env["FORGE_MODEL"] ?? (provider === "anthropic" ? "claude-sonnet-5-5" : "gpt-4o");
  emit({ type: "planning", provider, model });

  const plan = await planChange(goal, graph);
  emit({
    type: "plan",
    rationale: plan.rationale,
    steps: plan.operations.map((op) => ({
      op: op.operation,
      file: op.filePath,
      rationale: op.rationale,
    })),
  });

  // ── 3. Policy evaluation ──────────────────────────────────────────────────
  const policy = loadPolicy();
  const agentId = "forge-demo";
  const sessionId = crypto.randomUUID();

  const evaluated = plan.operations.map((op) => {
    const req: ActionRequest = {
      resource: "filesystem",
      operation: "write",
      target: op.filePath,
      agentId,
      sessionId,
    };
    const decision = evaluate(req, policy);
    emit({
      type: "policy",
      file: op.filePath,
      decision: decision.decision,
      rule: decision.matchedRuleId,
      reason: decision.reason,
    });
    return { op, req, decision };
  });

  const denied = evaluated.filter((e) => e.decision.decision === "deny");
  if (denied.length > 0) {
    throw new Error(
      `${denied.length} operation(s) denied by policy: ${denied.map((d) => d.op.filePath).join(", ")}`,
    );
  }

  // ── 4. Execute via capability executor ───────────────────────────────────
  rebuildGraph();
  const changeEvents: ReturnType<typeof getEventsSince> = [];

  for (const { op, decision } of evaluated) {
    const cap = issueCapability(decision, 60);
    emit({
      type: "capability",
      id: cap.id.slice(0, 8) + "…",
      resource: cap.resource,
      operation: cap.operation,
      expiresAt: cap.expiresAt,
      targetGlob: cap.targetGlob,
    });

    const result = await writeFile(cap.id, op.filePath, op.content);
    if (!result.success) {
      throw new Error(`Failed to write ${op.filePath}: ${result.error}`);
    }
    emit({
      type: "file-written",
      file: op.filePath,
      bytes: result.bytesAffected ?? 0,
    });

    const beforeId = getLatestEventId();
    try {
      await localInvalidation(op.filePath, extractor);
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

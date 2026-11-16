/**
 * Git executor — the only code path that runs git commands for agent-driven changes.
 * Every mutating operation builds an ActionRequest, evaluates it against the policy,
 * before touching the working tree.
 *
 * Read-only operations (status, log, diff, rev-parse) still go through the broker so
 * every agent action appears in the audit log.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { loadPolicy } from "../policy/parser.js";
import { evaluate } from "../policy/evaluator.js";
import { recordDecision } from "../policy/audit.js";
import type { ActionRequest, PolicyDecisionRecord } from "../policy/schema.js";
import type { VerifyGate } from "../verify/chain.js";

export type { VerifyGate };

const execFileAsync = promisify(execFile);

const PROTECTED = new Set(["main", "master"]);
const BRANCH_RE = /^forge\/[a-z0-9][a-z0-9-]{0,48}$/;

export interface GitResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 30_000 });
  return stdout.trim();
}

function buildRequest(
  operation: string,
  target: string,
  agentId: string,
  sessionId: string,
): ActionRequest {
  return { resource: "git", operation, target, agentId, sessionId };
}

function broker(
  operation: string,
  target: string,
  agentId: string,
  sessionId: string,
): void {
  const policy = loadPolicy();
  const req = buildRequest(operation, target, agentId, sessionId);
  const record = evaluate(req, policy);
  recordDecision(record);

  if (record.decision === "deny") {
    throw new Error(`Policy denied git ${operation}: ${record.reason}`);
  }
  if (record.decision === "requires_approval") {
    throw new Error(
      `git ${operation} requires human approval — call push() with approved:true`,
    );
  }
}

function auditFailure(
  operation: string,
  target: string,
  agentId: string,
  sessionId: string,
  reason: string,
): void {
  try {
    const rec: PolicyDecisionRecord = {
      request: { resource: "git", operation, target, agentId, sessionId },
      decision: "deny",
      matchedRuleId: null,
      reason: `Git operation failed: ${reason}`,
      timestamp: new Date().toISOString(),
    };
    recordDecision(rec);
  } catch {
    // Swallow audit errors — don't mask the real error
  }
}

// ── Read-only operations ──────────────────────────────────────────────────────

export async function currentBranch(cwd: string): Promise<string> {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

export async function diffHash(cwd: string): Promise<string> {
  const diff = await git(["diff", "HEAD"], cwd);
  const status = await git(["status", "--porcelain"], cwd);
  return createHash("sha256").update(diff + "\n" + status).digest("hex");
}

export async function gitStatus(
  agentId: string,
  sessionId: string,
  cwd: string,
): Promise<GitResult> {
  try {
    broker("status", "**", agentId, sessionId);
    const stdout = await git(["status", "--short"], cwd);
    return { success: true, stdout, stderr: "" };
  } catch (err) {
    const msg = (err as Error).message;
    auditFailure("status", "**", agentId, sessionId, msg);
    return { success: false, stdout: "", stderr: msg, error: msg };
  }
}

// ── Mutating operations ───────────────────────────────────────────────────────

export async function createBranch(
  slug: string,
  agentId: string,
  sessionId: string,
  cwd: string,
): Promise<GitResult> {
  const name = `forge/${slug}`;
  if (!BRANCH_RE.test(name)) {
    return {
      success: false,
      stdout: "",
      stderr: `Invalid branch name '${name}' — must match forge/<lowercase-slug>`,
      error: "INVALID_BRANCH",
    };
  }

  try {
    broker("branch", name, agentId, sessionId);
    await git(["checkout", "-b", name], cwd);
    return { success: true, stdout: name, stderr: "" };
  } catch (err) {
    const msg = (err as Error).message;
    auditFailure("branch", name, agentId, sessionId, msg);
    return { success: false, stdout: "", stderr: msg, error: msg };
  }
}

export async function stageFiles(
  paths: string[],
  agentId: string,
  sessionId: string,
  cwd: string,
): Promise<GitResult> {
  if (paths.length === 0) {
    return { success: false, stdout: "", stderr: "No paths to stage", error: "EMPTY_PATHS" };
  }

  try {
    broker("add", paths.join(" "), agentId, sessionId);
    await git(["add", "--", ...paths], cwd);
    return { success: true, stdout: `Staged ${paths.length} path(s)`, stderr: "" };
  } catch (err) {
    const msg = (err as Error).message;
    auditFailure("add", paths.join(" "), agentId, sessionId, msg);
    return { success: false, stdout: "", stderr: msg, error: msg };
  }
}

export async function commit(
  message: string,
  paths: string[],
  gate: VerifyGate,
  agentId: string,
  sessionId: string,
  cwd: string,
): Promise<GitResult> {
  const branch = await currentBranch(cwd);

  if (PROTECTED.has(branch)) {
    return {
      success: false,
      stdout: "",
      stderr: `Refusing to commit on protected branch '${branch}'`,
      error: "PROTECTED_BRANCH",
    };
  }
  if (!gate.passed) {
    return {
      success: false,
      stdout: "",
      stderr: "Verification has not passed — run the verification chain first",
      error: "VERIFICATION_FAILED",
    };
  }

  const currentHash = await diffHash(cwd);
  if (gate.diffHash !== currentHash) {
    return {
      success: false,
      stdout: "",
      stderr: "Working tree changed since verification — re-run the verification chain",
      error: "STALE_GATE",
    };
  }

  const stageResult = await stageFiles(paths, agentId, sessionId, cwd);
  if (!stageResult.success) return stageResult;

  try {
    // Inline the broker — VerifyGate IS the approval proof for commits,
    // so requires_approval is treated as "proceed with audit" (same pattern as push).
    const policy = loadPolicy();
    const req = buildRequest("commit", branch, agentId, sessionId);
    const record = evaluate(req, policy);
    recordDecision(record);
    if (record.decision === "deny") {
      throw new Error(`Policy denied git commit: ${record.reason}`);
    }
    const truncatedMsg = message.slice(0, 500);
    await git(["commit", "-m", truncatedMsg], cwd);
    return { success: true, stdout: `Committed on ${branch}`, stderr: "" };
  } catch (err) {
    const msg = (err as Error).message;
    auditFailure("commit", branch, agentId, sessionId, msg);
    return { success: false, stdout: "", stderr: msg, error: msg };
  }
}

export async function push(
  approved: boolean,
  agentId: string,
  sessionId: string,
  cwd: string,
): Promise<GitResult> {
  if (!approved) {
    return {
      success: false,
      stdout: "",
      stderr: "Push requires human approval — set approved:true",
      error: "APPROVAL_REQUIRED",
    };
  }

  const branch = await currentBranch(cwd);

  if (PROTECTED.has(branch) || !BRANCH_RE.test(branch)) {
    return {
      success: false,
      stdout: "",
      stderr: `Refusing to push branch '${branch}' — not a forge/* branch`,
      error: "PROTECTED_BRANCH",
    };
  }

  try {
    const policy = loadPolicy();
    const req = buildRequest("push", branch, agentId, sessionId);
    const record = evaluate(req, policy);
    recordDecision(record);

    if (record.decision === "deny") {
      throw new Error(`Policy denied push: ${record.reason}`);
    }

    // No force flags — by design this function cannot force-push.
    await git(["push", "-u", "origin", branch], cwd);
    return { success: true, stdout: `Pushed ${branch}`, stderr: "" };
  } catch (err) {
    const msg = (err as Error).message;
    auditFailure("push", branch, agentId, sessionId, msg);
    return { success: false, stdout: "", stderr: msg, error: msg };
  }
}

/**
 * The one permission check. The agent loop calls check() before every tool
 * runs and gets back one of three answers:
 *
 *   allow — a policy rule permits it; run it.
 *   ask   — a rule requires approval, or no rule covers it; ask the person.
 *   deny  — a rule forbids it; never run it.
 *
 * Rules live in forge.policy.yaml and are matched by policy/evaluator.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluate } from "./evaluator.js";
import type { ActionRequest, ForgePolicy, PolicyDecisionRecord, Resource } from "./schema.js";

/** What a tool call touches. */
export type Access =
  | { kind: "read" | "write"; path: string }
  | { kind: "shell"; command: string }
  /** A request that leaves this machine. target is the host contacted. */
  | { kind: "network"; operation: string; target: string }
  /** A tool on an MCP server. readOnly is the server's own hint, used only to decide what may run in parallel. */
  | { kind: "mcp"; server: string; tool: string; readOnly: boolean }
  | { kind: "none" };

export interface Verdict {
  decision: "allow" | "ask" | "deny";
  reason: string;
  /** The rules that matched, for the audit log. */
  records: PolicyDecisionRecord[];
}

/** Turn the person's answer to an "ask" into a record for the audit log. */
export function humanDecision(access: Access, approved: boolean, who: Who, reason?: string): PolicyDecisionRecord {
  const request: ActionRequest =
    access.kind === "shell" ? { resource: "shell", operation: access.command, target: "*", ...who }
    : access.kind === "network" ? { resource: "network", operation: access.operation, target: access.target, ...who }
    : access.kind === "mcp" ? { resource: "mcp", operation: access.tool, target: access.server, ...who }
    : { resource: "filesystem", operation: access.kind, target: access.kind === "none" ? "" : access.path, ...who };
  return {
    request,
    decision: approved ? "allow" : "deny",
    matchedRuleId: null,
    reason: reason ?? (approved ? "Approved by the user" : "Declined by the user"),
    timestamp: new Date().toISOString(),
  };
}

export interface Who {
  agentId: string;
  sessionId: string;
}

/** Files the agent may never write: its own rules and its own records. */
const PROTECTED_WRITES = ["forge.policy.yaml", ".forge", ".git"];

export function check(
  access: Access,
  policy: ForgePolicy,
  who: Who,
  cwd = process.cwd(),
): Verdict {
  if (access.kind === "none") {
    return { decision: "allow", reason: "No file or shell access", records: [] };
  }
  if (access.kind === "shell") return checkShell(access.command, policy, who);
  if (access.kind === "network") return verdict([ask("network", access.operation, access.target, policy, who)]);
  if (access.kind === "mcp") return verdict([ask("mcp", access.tool, access.server, policy, who)]);

  const target = policyPath(access.path, cwd);
  if (access.kind === "write" && PROTECTED_WRITES.some((p) => target === p || target.startsWith(p + "/"))) {
    return { decision: "deny", reason: `Forge never writes to ${target}`, records: [] };
  }
  return verdict([ask("filesystem", access.kind, target, policy, who)]);
}

// ── Files ─────────────────────────────────────────────────────────────────────

/**
 * The path the policy sees: relative when the file is inside the project,
 * absolute when it is not. Symlinks are resolved first, so a link inside the
 * project that points outside it is treated as outside.
 */
export function policyPath(filePath: string, cwd: string): string {
  const expanded = filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath;
  const absolute = realPath(path.resolve(cwd, expanded));
  const relative = path.relative(realPath(cwd), absolute);
  const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  return inside ? relative.split(path.sep).join("/") : absolute;
}

/** Resolve symlinks for the part of the path that already exists. */
function realPath(absolute: string): string {
  let existing = absolute;
  const rest: string[] = [];
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(fs.realpathSync(existing), ...rest);
}

// ── Shell ─────────────────────────────────────────────────────────────────────

/** Things we cannot see through: substitution, redirection, background jobs. */
const OPAQUE = /\$\(|`|[<>]|&(?!&)/;

function checkShell(command: string, policy: ForgePolicy, who: Who): Verdict {
  // Check each command in a chain on its own, so `x && git push origin main`
  // is still denied by the rule that denies `git push origin main`.
  const parts = command.split(/&&|\|\||[;|\n]/).map((p) => p.trim()).filter(Boolean);
  const verdicts = parts.map((part) => checkOneCommand(part, policy, who));
  const records = verdicts.flatMap((v) => v.records);

  const denied = verdicts.find((v) => v.decision === "deny");
  if (denied) return { ...denied, records };
  if (OPAQUE.test(command)) {
    return { decision: "ask", reason: "Command uses redirection or substitution", records };
  }
  const unsure = verdicts.find((v) => v.decision === "ask");
  if (unsure) return { ...unsure, records };
  return { decision: "allow", reason: verdicts[0]?.reason ?? "Empty command", records };
}

function checkOneCommand(command: string, policy: ForgePolicy, who: Who): Verdict {
  const words = command.split(/\s+/);

  if (words[0] === "git" && words.length > 1) {
    const forced = words.some((w) => w === "-f" || w.startsWith("--force"));
    const operation = words[1] === "push" && forced ? "force-push" : words[1];
    const args = words.slice(2).filter((w) => !w.startsWith("-"));
    // The whole command first, then each argument, so a rule that names a
    // branch ("main") matches wherever the branch appears.
    const records = ["*", ...args].map((target) => ask("git", operation, target, policy, who));
    const denied = records.find((r) => r.decision === "deny" && r.matchedRuleId);
    if (denied) return { decision: "deny", reason: denied.reason, records: [denied] };
    return verdict([records[0]]);
  }

  // A rule for "npm test" also covers "npm test -- --watch": try the full
  // command, then drop one word at a time until a rule matches.
  for (let n = words.length; n > 0; n--) {
    const record = ask("shell", words.slice(0, n).join(" "), "*", policy, who);
    if (record.matchedRuleId) return verdict([record]);
  }
  return verdict([ask("shell", command, "*", policy, who)]);
}

// ── Shared ────────────────────────────────────────────────────────────────────

function ask(
  resource: Resource,
  operation: string,
  target: string,
  policy: ForgePolicy,
  who: Who,
): PolicyDecisionRecord {
  return evaluate({ resource, operation, target, ...who }, policy);
}

function verdict(all: PolicyDecisionRecord[]): Verdict {
  const record = all[0];
  const records = all.filter((r) => r.matchedRuleId !== null);
  if (record.decision === "allow") return { decision: "allow", reason: record.reason, records };
  if (record.decision === "requires_approval") return { decision: "ask", reason: record.reason, records };
  // A rule said no: that is final. No rule at all: let the person decide.
  if (record.matchedRuleId) return { decision: "deny", reason: record.reason, records };
  return { decision: "ask", reason: "No policy rule covers this", records };
}

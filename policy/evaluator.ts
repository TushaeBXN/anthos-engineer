import os from "node:os";
import { minimatch } from "minimatch";
import type {
  ActionRequest,
  ForgePolicy,
  PolicyRule,
  PolicyDecision,
  PolicyDecisionRecord,
} from "./schema.js";

// ── Normalization ────────────────────────────────────────────────────────────
// Happens once, at the top of the pipeline.
// Key case: shell commands that are actually git commands route through the
// same decision path as a native git ActionRequest.

export function normalize(req: ActionRequest): ActionRequest {
  if (req.resource !== "shell") return req;

  const op = req.operation.trim();

  // "git <subcommand> [args]" → resource: git, operation: subcommand
  const gitMatch = op.match(/^git\s+(\S+)(?:\s+(.*))?$/);
  if (gitMatch) {
    return {
      ...req,
      resource: "git",
      operation: gitMatch[1],
      target: gitMatch[2]?.trim() || req.target,
    };
  }

  return req;
}

// ── Target glob matching ─────────────────────────────────────────────────────

function expandHome(p: string): string {
  return p.startsWith("~/") ? p.replace("~", os.homedir()) : p;
}

function targetMatches(ruleTarget: string, requestTarget: string): boolean {
  const pattern = expandHome(ruleTarget);
  const target = expandHome(requestTarget);
  // Exact match or glob
  return minimatch(target, pattern, { dot: true, matchBase: false });
}

// ── Rule matching ────────────────────────────────────────────────────────────

function ruleMatches(rule: PolicyRule, req: ActionRequest): boolean {
  const resourceMatch = rule.resource === "*" || rule.resource === req.resource;
  if (!resourceMatch) return false;

  const operationMatch =
    rule.operation === "*" || rule.operation === req.operation;
  if (!operationMatch) return false;

  return targetMatches(rule.target, req.target);
}

// ── Evaluation ───────────────────────────────────────────────────────────────
// Rules are checked in order. First match wins.
// Deny rules always short-circuit — no further checking.

export function evaluate(
  req: ActionRequest,
  policy: ForgePolicy,
): PolicyDecisionRecord {
  const normalized = normalize(req);
  const timestamp = new Date().toISOString();

  for (const rule of policy.rules) {
    if (!ruleMatches(rule, normalized)) continue;

    if (rule.effect === "deny") {
      return {
        request: normalized,
        decision: "deny",
        matchedRuleId: rule.id,
        reason: `Denied by rule '${rule.id}'`,
        timestamp,
      };
    }

    // effect === "allow"
    const decision: PolicyDecision = rule.requiresApproval
      ? "requires_approval"
      : "allow";

    return {
      request: normalized,
      decision,
      matchedRuleId: rule.id,
      reason: rule.requiresApproval
        ? `Allowed by rule '${rule.id}' — human approval required`
        : `Allowed by rule '${rule.id}'`,
      timestamp,
    };
  }

  // No rule matched — default
  const decision: PolicyDecision =
    policy.default === "allow" ? "allow" : "deny";

  return {
    request: normalized,
    decision,
    matchedRuleId: null,
    reason: `No matching rule — default ${policy.default}`,
    timestamp,
  };
}

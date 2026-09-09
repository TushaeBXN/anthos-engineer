/**
 * The ONLY code path that touches Node's fs module for agent-driven changes.
 * Every call must present a valid, unexpired capability token.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import { getCapability } from "../capability/issuer.js";
import { CapabilityError } from "../capability/schema.js";
import { recordDecision } from "../policy/audit.js";
import type { PolicyDecisionRecord } from "../policy/schema.js";

export interface FsResult {
  success: boolean;
  path: string;
  bytesAffected?: number;
  content?: string;
  error?: string;
}

function revalidate(
  capabilityId: string,
  requiredOperation: "read" | "write",
  filePath: string,
): void {
  const cap = getCapability(capabilityId); // throws NOT_FOUND if missing

  // Not expired
  if (new Date() > new Date(cap.expiresAt)) {
    throw new CapabilityError(
      `Capability '${capabilityId}' expired at ${cap.expiresAt}`,
      "EXPIRED",
    );
  }

  // Operation matches
  if (cap.operation !== requiredOperation && cap.operation !== "*") {
    throw new CapabilityError(
      `Capability grants '${cap.operation}', not '${requiredOperation}'`,
      "OPERATION_MISMATCH",
    );
  }

  // Target glob matches — always relative to cwd
  const relative = path.relative(process.cwd(), path.resolve(filePath));
  if (!minimatch(relative, cap.targetGlob, { dot: true })) {
    throw new CapabilityError(
      `Path '${relative}' is outside the granted glob '${cap.targetGlob}'`,
      "TARGET_MISMATCH",
    );
  }
}

export async function writeFile(
  capabilityId: string,
  filePath: string,
  content: string,
): Promise<FsResult> {
  try {
    revalidate(capabilityId, "write", filePath);
    const resolved = path.resolve(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf8");
    return { success: true, path: resolved, bytesAffected: content.length };
  } catch (err) {
    const msg = (err as Error).message;
    _auditFailure(capabilityId, "write", filePath, msg);
    return { success: false, path: filePath, error: msg };
  }
}

export async function readFile(
  capabilityId: string,
  filePath: string,
): Promise<FsResult> {
  try {
    revalidate(capabilityId, "read", filePath);
    const resolved = path.resolve(filePath);
    const content = await fs.readFile(resolved, "utf8");
    return { success: true, path: resolved, content, bytesAffected: content.length };
  } catch (err) {
    const msg = (err as Error).message;
    _auditFailure(capabilityId, "read", filePath, msg);
    return { success: false, path: filePath, error: msg };
  }
}

function _auditFailure(
  capabilityId: string,
  operation: string,
  target: string,
  reason: string,
): void {
  try {
    // Best-effort audit — don't let audit failure mask the real error
    const rec: PolicyDecisionRecord = {
      request: {
        resource: "filesystem",
        operation,
        target,
        agentId: "unknown",
        sessionId: capabilityId,
      },
      decision: "deny",
      matchedRuleId: null,
      reason: `Executor re-validation failed: ${reason}`,
      timestamp: new Date().toISOString(),
    };
    recordDecision(rec);
  } catch {
    // Swallow audit errors
  }
}

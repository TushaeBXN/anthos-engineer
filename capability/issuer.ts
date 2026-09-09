import crypto from "node:crypto";
import type { PolicyDecisionRecord } from "../policy/schema.js";
import { Capability, CapabilityError } from "./schema.js";

const DEFAULT_TTL_SECONDS = 60;

// In-memory store — capabilities are short-lived tokens (default 60s).
// A process restart invalidates all outstanding capabilities, which is correct:
// agents must re-request authorization rather than hold stale grants.
const _store = new Map<string, Capability>();

export function issueCapability(
  record: PolicyDecisionRecord,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Capability {
  if (record.decision !== "allow" && record.decision !== "requires_approval") {
    throw new Error(
      `Cannot issue capability for decision '${record.decision}'`,
    );
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  const cap: Capability = {
    id: crypto.randomUUID(),
    resource: record.request.resource,
    operation: record.request.operation,
    targetGlob: record.request.target,
    agentId: record.request.agentId,
    sessionId: record.request.sessionId,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  _store.set(cap.id, cap);
  return cap;
}

export function getCapability(id: string): Capability {
  const cap = _store.get(id);
  if (!cap) throw new CapabilityError(`Capability '${id}' not found`, "NOT_FOUND");
  return cap;
}

export function revokeCapability(id: string): void {
  _store.delete(id);
}

// Exposed for testing — issue a capability that is already expired.
export function issueExpiredCapability(record: PolicyDecisionRecord): Capability {
  return issueCapability(record, -1);
}

export function clearAllCapabilities(): void {
  _store.clear();
}

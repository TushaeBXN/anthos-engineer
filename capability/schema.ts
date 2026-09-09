import type { Resource } from "../policy/schema.js";

export interface Capability {
  id: string;
  resource: Resource;
  operation: string;
  targetGlob: string; // the glob pattern this capability grants access within
  agentId: string;
  sessionId: string;
  issuedAt: string; // ISO timestamp
  expiresAt: string; // ISO timestamp
}

export class CapabilityError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "EXPIRED"
      | "TARGET_MISMATCH"
      | "OPERATION_MISMATCH"
      | "NOT_FOUND"
      | "NOT_WHITELISTED",
  ) {
    super(message);
    this.name = "CapabilityError";
  }
}

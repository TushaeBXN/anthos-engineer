export type Resource = "filesystem" | "shell" | "git" | "aws";
export type Effect = "allow" | "deny";
export type PolicyDecision = "allow" | "deny" | "requires_approval";

export interface ActionRequest {
  resource: Resource;
  operation: string;
  target: string;
  parameters?: Record<string, unknown>;
  agentId: string;
  sessionId: string;
}

export interface PolicyRule {
  id: string;
  resource: Resource | "*";
  operation: string; // exact string or "*"
  target: string;    // minimatch glob
  effect: Effect;
  requiresApproval?: boolean;
}

export interface ForgePolicy {
  version: number;
  default: "deny" | "allow";
  rules: PolicyRule[];
}

export interface PolicyDecisionRecord {
  request: ActionRequest;
  decision: PolicyDecision;
  matchedRuleId: string | null;
  reason: string;
  timestamp: string;
}

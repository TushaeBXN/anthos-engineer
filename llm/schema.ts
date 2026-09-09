export type FileOperationKind = "create" | "modify";

export interface FileOperation {
  operation: FileOperationKind;
  filePath: string;
  content: string;
  rationale: string;
}

export interface Plan {
  rationale: string;
  operations: FileOperation[];
}

// JSON Schema for the propose_plan tool — shared across providers.
export const PLAN_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    rationale: {
      type: "string",
      description: "One or two sentences explaining the overall approach.",
    },
    operations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["create", "modify"] },
          filePath: { type: "string", description: "Relative path from project root" },
          content: { type: "string", description: "Complete file content" },
          rationale: { type: "string", description: "Why this file is touched" },
        },
        required: ["operation", "filePath", "content", "rationale"],
      },
      minItems: 1,
    },
  },
  required: ["rationale", "operations"],
};

export const SYSTEM_PROMPT = `You are Forge, an AI software engineering agent built by Anthos Intelligence.
You are given a description of an existing TypeScript codebase and a change goal.
Produce a minimal, focused plan: the fewest file creates/modifies needed to achieve
the goal without breaking existing functionality.

Rules:
- Only touch files directly required by the goal.
- Write complete, valid TypeScript for every file — no ellipses, no TODO comments.
- Prefer creating new files over modifying existing ones when a clean boundary exists.
- Never modify test files unless the goal explicitly says to.
- filePath values must be relative paths from the project root (e.g. "src/api/health.ts").`;

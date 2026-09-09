/**
 * LLM planner — builds a compact system model summary and asks Claude to
 * produce a structured change plan: which files to create/modify and why.
 * Uses tool_use so the response is always structured JSON, never free-form prose.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { SystemGraph } from "../model/graph.js";

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

const MODEL = process.env["ANTHROPIC_MODEL"] ?? "claude-opus-5";

// Build a compact text summary of the system model (not the full graph dump).
export function buildSystemSummary(graph: SystemGraph): string {
  const nodes = graph.getNodes();
  const edges = graph.getEdges();

  const modules = nodes.filter((n) => n.kind === "module");
  const functions = nodes.filter((n) => n.kind === "function");
  const deps = nodes.filter((n) => n.kind === "dependency");

  const lines: string[] = [
    `TypeScript project — ${nodes.length} nodes (${functions.length} functions, ${modules.length} modules, ${deps.length} external deps), ${edges.length} edges.`,
    "",
  ];

  if (modules.length > 0) {
    lines.push("Modules (source files):");
    for (const m of modules.slice(0, 40)) {
      lines.push(`  ${m.filePath}`);
    }
    if (modules.length > 40) lines.push(`  … and ${modules.length - 40} more`);
    lines.push("");
  }

  if (functions.length > 0) {
    lines.push("Key functions (first 60):");
    for (const f of functions.slice(0, 60)) {
      lines.push(`  ${f.name}  (${f.filePath})`);
    }
    if (functions.length > 60) lines.push(`  … and ${functions.length - 60} more`);
    lines.push("");
  }

  if (deps.length > 0) {
    lines.push(`External dependencies: ${deps.map((d) => d.name).join(", ")}`);
  }

  return lines.join("\n");
}

// Ask Claude for a structured change plan.
// Throws if ANTHROPIC_API_KEY is not set or the API call fails.
export async function planChange(goal: string, graph: SystemGraph): Promise<Plan> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Export it before running forge change.",
    );
  }

  const client = new Anthropic({ apiKey });
  const summary = buildSystemSummary(graph);

  const systemPrompt = `You are Forge, an AI software engineering agent built by Anthos Intelligence.
You are given a description of an existing TypeScript codebase (its structure, modules, and key functions)
and a change goal. Produce a minimal, focused plan: the fewest file creates/modifies needed to achieve
the goal without breaking existing functionality.

Rules:
- Only touch files directly required by the goal.
- Write complete, valid TypeScript for every file — no ellipses, no TODO comments.
- Prefer creating new files over modifying existing ones when a clean boundary exists.
- Never modify test files unless the goal explicitly says to.
- filePath values must be relative paths from the project root (e.g. "src/api/health.ts").`;

  const proposePlanTool: Anthropic.Tool = {
    name: "propose_plan",
    description: "Submit the structured change plan. Call this exactly once.",
    input_schema: {
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
    },
  };

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: systemPrompt,
    tools: [proposePlanTool],
    tool_choice: { type: "any" },
    messages: [
      {
        role: "user",
        content: `SYSTEM MODEL:\n${summary}\n\nGOAL: ${goal}`,
      },
    ],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not call propose_plan — unexpected response format.");
  }

  const input = toolUse.input as Plan;
  return input;
}

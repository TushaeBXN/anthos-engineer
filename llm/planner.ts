/**
 * Forge planner — model-agnostic LLM integration.
 *
 * Provider selection (FORGE_PROVIDER env var):
 *   anthropic        @anthropic-ai/sdk  (default)
 *   openai           OpenAI API
 *   ollama           Ollama local server  (OpenAI-compatible)
 *   <anything else>  Any OpenAI-compatible endpoint via FORGE_BASE_URL
 *
 * Model selection (FORGE_MODEL env var):
 *   Anthropic default:  claude-opus-5
 *   OpenAI default:     gpt-4o
 *   Ollama default:     llama3.1
 */
import type { SystemGraph } from "../model/graph.js";
import type { Plan } from "./schema.js";
import { planWithAnthropic } from "./providers/anthropic.js";
import { planWithOpenAICompatible } from "./providers/openai-compatible.js";

export type { Plan, FileOperation, FileOperationKind } from "./schema.js";

type Provider = "anthropic" | "openai" | "ollama" | string;

function resolveProvider(): Provider {
  const p = (process.env["FORGE_PROVIDER"] ?? "anthropic").toLowerCase();
  return p;
}

function resolveModel(provider: Provider): string {
  if (process.env["FORGE_MODEL"]) return process.env["FORGE_MODEL"];
  if (provider === "anthropic") return "claude-opus-5";
  if (provider === "openai") return "gpt-4o";
  if (provider === "ollama") return "llama3.1";
  return "gpt-4o"; // sensible default for other compatible endpoints
}

// Build a compact text summary of the system model — not a full graph dump.
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
    for (const m of modules.slice(0, 40)) lines.push(`  ${m.filePath}`);
    if (modules.length > 40) lines.push(`  … and ${modules.length - 40} more`);
    lines.push("");
  }

  if (functions.length > 0) {
    lines.push("Key functions (first 60):");
    for (const f of functions.slice(0, 60)) lines.push(`  ${f.name}  (${f.filePath})`);
    if (functions.length > 60) lines.push(`  … and ${functions.length - 60} more`);
    lines.push("");
  }

  if (deps.length > 0) {
    lines.push(`External dependencies: ${deps.map((d) => d.name).join(", ")}`);
  }

  return lines.join("\n");
}

// Ask the configured LLM for a structured change plan.
export async function planChange(goal: string, graph: SystemGraph): Promise<Plan> {
  const provider = resolveProvider();
  const model = resolveModel(provider);
  const summary = buildSystemSummary(graph);
  const userMessage = `SYSTEM MODEL:\n${summary}\n\nGOAL: ${goal}`;

  // Inject FORGE_BASE_URL for Ollama so the openai-compatible provider picks it up.
  if (provider === "ollama" && !process.env["FORGE_BASE_URL"]) {
    process.env["FORGE_BASE_URL"] = "http://localhost:11434/v1";
  }

  if (provider === "anthropic") {
    return planWithAnthropic(userMessage, model);
  }

  // openai, ollama, or any custom endpoint — all speak the same OpenAI API.
  return planWithOpenAICompatible(userMessage, model);
}

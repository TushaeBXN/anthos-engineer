/**
 * Engram memory tools — long-term recall and save via Engram's local HTTP API.
 *
 * Engram must be running: `engram serve` (starts at http://127.0.0.1:7742).
 * If the server is not reachable, both tools fail silently so Forge keeps working.
 *
 * recall  — search Engram for memories relevant to a query; inject results into context
 * remember — save a fact or note to Engram for future sessions
 */
import type { Tool } from "../agent/types.js";

const ENGRAM_BASE = "http://127.0.0.1:7742";
const TIMEOUT_MS = 5_000;

async function engram(endpoint: string, body: Record<string, unknown>): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`${ENGRAM_BASE}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    return typeof data.content === "string" ? data.content : JSON.stringify(data);
  } catch {
    return null;
  }
}

export const recall: Tool = {
  name: "recall",
  description:
    "Search long-term memory (Engram) for facts, decisions, or context from past sessions " +
    "that are relevant to the current task. Use this at the start of a task to surface " +
    "what was done before. Requires `engram serve` to be running.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for — a question or topic" },
      results: { type: "number", description: "Max number of memories to return (default 5)" },
    },
    required: ["query"],
  },
  access: () => ({ kind: "read", path: "(engram memory)" }),
  label: (input) => `Recall  ${input.query}`,
  async run(input) {
    const result = await engram("/v1/tools/engram_recall", {
      message: String(input.query),
      n_results: Number(input.results ?? 5),
    });
    if (!result) return { output: "Engram is not running. Start it with: engram serve", isError: true };
    return { output: result };
  },
};

export const remember: Tool = {
  name: "remember",
  description:
    "Save a fact, decision, or note to long-term memory (Engram) so it can be recalled " +
    "in future sessions. Use this to record key decisions, architectural choices, or " +
    "anything worth keeping beyond this conversation. Requires `engram serve` to be running.",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string", description: "The fact or note to save" },
      wing: { type: "string", description: "Wing (project or person name) — defaults to current directory name" },
    },
    required: ["content"],
  },
  access: () => ({ kind: "none" }),
  label: (input) => `Remember  ${String(input.content).slice(0, 60)}`,
  async run(input, cwd) {
    const wing = String(input.wing ?? cwd.split("/").pop() ?? "forge");
    const result = await engram("/v1/tools/engram_add_memory", {
      content: String(input.content),
      wing,
      source: "tool",
    });
    if (!result) return { output: "Engram is not running. Start it with: engram serve", isError: true };
    return { output: result };
  },
};

/**
 * What Forge knows about each model: who can see its weights, where it runs,
 * how much it can hold, and what it costs. APIs do not report most of this,
 * so it is kept here by hand. Update these tables when models change.
 *
 * Config precedence (highest to lowest):
 *   FORGE_* env vars  →  ~/.forgerc  →  built-in defaults
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ModelInfo {
  provider: string;
  model: string;
  /** open: the weights are published · closed: only the vendor has them */
  weights: "open" | "closed" | "unknown";
  /** local: runs on this machine · hosted: your code is sent to a server */
  runs: "local" | "hosted";
  /** Tokens the model can hold in one conversation, when known. */
  contextWindow: number | null;
  /** US dollars per million tokens, when known. */
  price: { input: number; output: number } | null;
  /** Where OpenAI-compatible requests are sent (unused for Anthropic). */
  baseUrl: string | undefined;
}

interface ProviderInfo {
  weights: ModelInfo["weights"];
  runs: ModelInfo["runs"];
  /** Used when FORGE_MODEL is not set. Without one, FORGE_MODEL is required. */
  defaultModel?: string;
  baseUrl?: string;
}

const PROVIDERS: Record<string, ProviderInfo> = {
  anthropic: { weights: "closed", runs: "hosted", defaultModel: "claude-opus-5-5" },
  openai: { weights: "closed", runs: "hosted", defaultModel: "gpt-4o" },
  ollama: { weights: "open", runs: "local", defaultModel: "llama3.1", baseUrl: "http://localhost:11434/v1" },
  lmstudio: { weights: "open", runs: "local", baseUrl: "http://localhost:1234/v1" },
  groq: { weights: "open", runs: "hosted", defaultModel: "llama-3.3-70b-versatile", baseUrl: "https://api.groq.com/openai/v1" },
  together: { weights: "open", runs: "hosted", baseUrl: "https://api.together.xyz/v1" },
};

/** Context window and price per million tokens. Anthropic figures as of 2026-11-03. */
const MODELS: Record<string, { contextWindow: number; price?: { input: number; output: number } }> = {
  "claude-fable-5-2": { contextWindow: 1_000_000, price: { input: 8, output: 40 } },
  "claude-opus-5-5": { contextWindow: 1_000_000, price: { input: 4, output: 20 } },
  "claude-opus-5": { contextWindow: 1_000_000, price: { input: 5, output: 25 } },
  "claude-sonnet-5-5": { contextWindow: 1_000_000, price: { input: 2, output: 10 } },
  "claude-sonnet-5": { contextWindow: 1_000_000, price: { input: 2, output: 10 } },
  "claude-haiku-5-5": { contextWindow: 1_000_000, price: { input: 0.1, output: 0.5 } },
  "claude-haiku-4-5": { contextWindow: 200_000, price: { input: 1, output: 5 } },
  // No price listed: set FORGE_PRICE_INPUT and FORGE_PRICE_OUTPUT to see cost.
  "gpt-4o": { contextWindow: 128_000 },
};

// ── Config file (~/.forgerc) ──────────────────────────────────────────────────

interface ForgeRc {
  provider?: string;
  model?: string;
  baseUrl?: string;
  budget?: number;
  context?: number;
  priceInput?: number;
  priceOutput?: number;
  /** Token budget for the repo map in the system prompt. 0 turns it off. */
  repoMap?: number;
}

const RC_PATH = process.env["FORGE_RC"] ?? path.join(os.homedir(), ".forgerc");

function readRc(): ForgeRc {
  try {
    return JSON.parse(fs.readFileSync(RC_PATH, "utf8")) as ForgeRc;
  } catch {
    return {};
  }
}

export function writeRc(updates: Partial<ForgeRc>): void {
  const current = readRc();
  fs.writeFileSync(RC_PATH, JSON.stringify({ ...current, ...updates }, null, 2) + "\n", "utf8");
}

export { RC_PATH };

/** How many tokens the repo map may use: FORGE_REPO_MAP, then ~/.forgerc, then 1024. */
export function repoMapBudget(env: Record<string, string | undefined> = process.env): number {
  return number(env["FORGE_REPO_MAP"]) ?? readRc().repoMap ?? 1024;
}

// ── Resolve ───────────────────────────────────────────────────────────────────

/** Work out which model to use, and what is known about it, from the environment. */
export function resolveModel(env: Record<string, string | undefined> = process.env): ModelInfo {
  const rc = readRc();
  const provider = (env["FORGE_PROVIDER"] ?? rc.provider ?? "anthropic").toLowerCase();
  const known = PROVIDERS[provider];
  const model = env["FORGE_MODEL"] ?? rc.model ?? known?.defaultModel;
  if (!model) throw new Error(`Set FORGE_MODEL to the model you want to use with "${provider}".`);
  const listed = MODELS[model];

  const runs = known?.runs ?? "hosted";
  const priceIn = number(env["FORGE_PRICE_INPUT"]) ?? rc.priceInput ?? null;
  const priceOut = number(env["FORGE_PRICE_OUTPUT"]) ?? rc.priceOutput ?? null;
  const price =
    priceIn !== null && priceOut !== null ? { input: priceIn, output: priceOut }
    : runs === "local" ? { input: 0, output: 0 }
    : listed?.price ?? null;

  return {
    provider,
    model,
    weights: known?.weights ?? "unknown",
    runs,
    contextWindow: number(env["FORGE_CONTEXT"]) ?? rc.context ?? listed?.contextWindow ?? null,
    price,
    baseUrl: env["FORGE_BASE_URL"] ?? rc.baseUrl ?? known?.baseUrl,
  };
}

function number(value: string | undefined): number | null {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) ? n : null;
}

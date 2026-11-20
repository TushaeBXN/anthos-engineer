/**
 * forge doctor: check the setup in one go and say how to fix what's wrong.
 *
 * Each check is ok, warn (Forge works, but something is missing or limited) or fail
 * (Forge can't do its job until it's fixed). Nothing here writes a file, and keys are never printed.
 * The model check makes one free request (list or look up models), never a paid one.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { RC_PATH, detectContextWindow, rcProblem, resolveModel, type ModelInfo } from "./models.js";
import { loadPolicy } from "../policy/parser.js";
import { sandboxStatus } from "./sandbox.js";

export type CheckState = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
  /** What to do about it, when there's something to do. */
  fix?: string;
}

export interface DoctorOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Start the MCP servers to see whether they connect. Default true. */
  mcp?: boolean;
  /** Where Engram is expected. */
  engramUrl?: string;
}

const MIN_NODE = 22;
/** Below this many tokens, Forge's system prompt, tools and a few files barely fit (a 4096 window fails outright). */
const SMALL_WINDOW = 16_384;
const RESOURCES = new Set(["filesystem", "shell", "git", "network", "mcp", "aws", "*"]);

export async function runDoctor(options: DoctorOptions): Promise<Check[]> {
  const env = options.env ?? process.env;
  const checks: Check[] = [node(), config()];

  let info: ModelInfo | null = null;
  try {
    info = resolveModel(env);
    checks.push({ name: "Model", state: "ok", detail: `${info.provider} / ${info.model} (${info.weights} weights, ${info.runs === "local" ? "runs on this machine" : "hosted: your code is sent to the provider"})` });
  } catch (err) {
    checks.push({ name: "Model", state: "fail", detail: (err as Error).message, fix: "forge providers  (then forge config set provider <name> and forge config set model <name>)" });
  }

  if (info) {
    const key = apiKey(info);
    checks.push(key);
    const server = key.state === "fail" ? null : await reachable(info);
    if (server) checks.push(server);
    // Without a working server there's no window to detect, and the problem is already reported.
    if (server?.state !== "fail") checks.push(await contextWindow(info, env));
  }

  checks.push(policy(options.cwd), sandbox(env), folder(options.cwd), git(options.cwd), index(options.cwd));
  if (options.mcp !== false) checks.push(...(await mcp(options.cwd)));
  checks.push(await engram(options.engramUrl ?? "http://127.0.0.1:7742"));
  return checks;
}

function node(): Check {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= MIN_NODE
    ? { name: "Node.js", state: "ok", detail: process.versions.node }
    : { name: "Node.js", state: "fail", detail: `${process.versions.node}; Forge needs ${MIN_NODE} or later`, fix: "Install Node.js 22 or later from https://nodejs.org" };
}

function config(): Check {
  const problem = rcProblem();
  if (problem) return { name: "Config", state: "fail", detail: `${RC_PATH} is ignored: ${problem}`, fix: `Fix or delete ${RC_PATH}, then run forge config set provider <name>` };
  return { name: "Config", state: "ok", detail: fs.existsSync(RC_PATH) ? RC_PATH : "no ~/.forgerc; using environment variables and defaults" };
}

function apiKey(info: ModelInfo): Check {
  if (!info.keyEnv) return { name: "API key", state: "ok", detail: "none needed" };
  if (info.apiKey) return { name: "API key", state: "ok", detail: `${info.keyEnv} is set` };
  return { name: "API key", state: "fail", detail: `${info.keyEnv} is not set`, fix: `export ${info.keyEnv}=...  (in your shell profile; Forge never stores keys in ~/.forgerc)` };
}

/** One free request: does the server answer, accept the key, and know the model? */
async function reachable(info: ModelInfo): Promise<Check> {
  const name = "Model server";
  const where = info.provider === "anthropic" ? "the Anthropic API" : (info.baseUrl ?? "the server");
  try {
    if (info.provider === "anthropic") {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: info.apiKey, baseURL: info.baseUrl, maxRetries: 0, timeout: 10_000 });
      await client.models.retrieve(info.model);
      return { name, state: "ok", detail: `${where} answered and knows ${info.model}` };
    }
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: info.apiKey ?? "not-needed", baseURL: info.baseUrl, maxRetries: 0, timeout: 10_000 });
    const ids = (await client.models.list()).data.map((m) => m.id);
    if (ids.some((id) => id === info.model || id === `${info.model}:latest`)) return { name, state: "ok", detail: `${where} answered and has ${info.model}` };
    // Local servers list everything they have; hosted lists are sometimes incomplete.
    return info.runs === "local"
      ? { name, state: "fail", detail: `${where} answered, but has no model named ${info.model}`, fix: info.provider === "ollama" ? `ollama pull ${info.model}  (or ollama list, then forge config set model <name>)` : "Load the model in the server, or forge config set model <name>" }
      : { name, state: "warn", detail: `${where} answered, but ${info.model} isn't in its model list; check the spelling` };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) return { name, state: "fail", detail: `${where} rejected the key (${status})`, fix: `Check ${info.keyEnv ?? "the key"}` };
    if (status === 404 && info.provider === "anthropic") return { name, state: "fail", detail: `the Anthropic API has no model named ${info.model}`, fix: "forge config set model claude-opus-5-5" };
    if (status !== undefined) return { name, state: "warn", detail: `${where} answered with ${status}; it may not support listing models, so this check couldn't confirm the model` };
    const fix =
      info.provider === "ollama" ? "Start Ollama: open the Ollama app, or run ollama serve"
      : info.provider === "lmstudio" ? "Open LM Studio and start its local server"
      : "Check your connection, or forge config set baseUrl <url>";
    return { name, state: "fail", detail: `couldn't reach ${where} (${(err as Error).message})`, fix };
  }
}

async function contextWindow(info: ModelInfo, env: Record<string, string | undefined>): Promise<Check> {
  const name = "Context window";
  const window = info.contextWindow ?? (await detectContextWindow(env));
  if (!window) return { name, state: "warn", detail: "unknown, so automatic compaction is off", fix: "forge config set context <tokens>" };
  const tokens = window.toLocaleString("en-US");
  if (window < SMALL_WINDOW) {
    const fix = info.provider === "ollama"
      ? "Give the model more room: PARAMETER num_ctx 32768 in its Modelfile, or OLLAMA_CONTEXT_LENGTH=32768 before starting Ollama"
      : "Use a model with a larger window";
    return { name, state: "warn", detail: `${tokens} tokens; too small for Forge's tools and a few files`, fix };
  }
  return { name, state: "ok", detail: `${tokens} tokens` };
}

function policy(cwd: string): Check {
  const name = "Policy";
  const file = path.join(cwd, "forge.policy.yaml");
  if (!fs.existsSync(file)) {
    return { name, state: "warn", detail: "no forge.policy.yaml here: Forge asks before every action, and refuses them all when no one is at the keyboard", fix: "forge policy use workspace-write  (or forge policy to see all three)" };
  }
  try {
    const p = loadPolicy(file);
    const odd = p.rules.filter((r) => !RESOURCES.has(r.resource) || (r.effect !== "allow" && r.effect !== "deny") || (r.operation !== "*" && r.operation.includes("*")));
    if (odd.length > 0) {
      return { name, state: "warn", detail: `rules that never match as written: ${odd.map((r) => r.id).join(", ")}`, fix: "resource is one of filesystem, shell, git, network, mcp, aws; effect is allow or deny; operation is an exact name or *, not a partial wildcard" };
    }
    return { name, state: "ok", detail: `${p.rules.length} rules, default ${p.default}` };
  } catch (err) {
    return { name, state: "fail", detail: `forge.policy.yaml can't be read: ${(err as Error).message}`, fix: "Fix the YAML; until then Forge won't start in this folder" };
  }
}

function sandbox(env: Record<string, string | undefined>): Check {
  const s = sandboxStatus(env);
  const name = "Sandbox";
  if (s.active) {
    const how = s.kind === "seatbelt" ? "macOS Seatbelt" : "bubblewrap";
    return { name, state: "ok", detail: `${how}: commands write only in the project and temp folders${s.network ? "" : ", no internet"}` };
  }
  if (s.inside) return { name, state: "ok", detail: "already inside Forge's sandbox" };
  if (s.mode === "off") return { name, state: "warn", detail: "off: an approved command can change anything your account can", fix: "forge config set sandbox auto" };
  return s.mode === "on"
    ? { name, state: "fail", detail: `required, but ${s.reason}; commands won't run`, fix: s.reason?.includes("bubblewrap") ? "Install bubblewrap" : "forge config set sandbox auto" }
    : { name, state: "warn", detail: `not available: ${s.reason}; commands run with your account's full access`, fix: s.reason?.includes("bubblewrap") ? "Install bubblewrap" : undefined };
}

function folder(cwd: string): Check {
  try {
    fs.accessSync(cwd, fs.constants.W_OK);
    return { name: "Project folder", state: "ok", detail: cwd };
  } catch {
    return { name: "Project folder", state: "fail", detail: `${cwd} isn't writable, so Forge can't edit files or keep its audit log`, fix: "Run Forge in a folder you own" };
  }
}

function git(cwd: string): Check {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "ignore" });
    return { name: "Git", state: "ok", detail: "this folder is a git repository" };
  } catch {
    return { name: "Git", state: "warn", detail: "not a git repository: no history to review or undo changes with", fix: "git init" };
  }
}

function index(cwd: string): Check {
  return fs.existsSync(path.join(cwd, ".forge", "events.db"))
    ? { name: "Project index", state: "ok", detail: "built; find_dependents can answer" }
    : { name: "Project index", state: "warn", detail: "not built, so find_dependents has nothing to search (TypeScript only)", fix: "forge init" };
}

async function mcp(cwd: string): Promise<Check[]> {
  const { connectMcp } = await import("./mcp.js");
  let connection;
  try {
    connection = await connectMcp(cwd);
  } catch (err) {
    return [{ name: "MCP", state: "fail", detail: `an mcp.json can't be read: ${(err as Error).message}`, fix: "Fix ~/.forge/mcp.json or .forge/mcp.json" }];
  }
  try {
    if (connection.servers.length === 0) return [{ name: "MCP", state: "ok", detail: "no servers configured" }];
    return connection.servers.map((s) =>
      s.state === "connected" ? { name: `MCP ${s.name}`, state: "ok" as const, detail: `${s.tools} tools` }
      : s.state === "skipped" ? { name: `MCP ${s.name}`, state: "warn" as const, detail: s.detail ?? "skipped", fix: s.source === "project" ? "Start forge in this folder and approve it" : undefined }
      : { name: `MCP ${s.name}`, state: "fail" as const, detail: s.detail ?? "failed to start", fix: "Check its command in mcp.json" },
    );
  } finally {
    await connection.close();
  }
}

async function engram(url: string): Promise<Check> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return { name: "Engram memory", state: "ok", detail: `running at ${url}` };
  } catch {
    return { name: "Engram memory", state: "warn", detail: "not running (optional: recall and remember won't work)", fix: "engram serve" };
  }
}

const MARK: Record<CheckState, string> = { ok: "✓", warn: "!", fail: "✗" };

/** Checks as lines for the terminal, with a summary at the end. */
export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  const lines = checks.flatMap((c) => [
    `  ${MARK[c.state]} ${c.name.padEnd(width)}  ${c.detail}`,
    ...(c.fix && c.state !== "ok" ? [`    ${" ".repeat(width)}  → ${c.fix}`] : []),
  ]);
  const fails = checks.filter((c) => c.state === "fail").length;
  const warns = checks.filter((c) => c.state === "warn").length;
  const summary =
    fails > 0 ? `${fails} problem${fails === 1 ? "" : "s"} to fix before Forge can work${warns ? `, ${warns} warning${warns === 1 ? "" : "s"}` : ""}.`
    : warns > 0 ? `Ready, with ${warns} warning${warns === 1 ? "" : "s"}.`
    : "Ready.";
  return `\n${lines.join("\n")}\n\n  ${summary}\n`;
}

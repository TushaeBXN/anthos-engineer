/**
 * The agent loop. This is the whole idea of Forge in one function:
 *
 *   1. Send the conversation to the model.
 *   2. If it asks for tools, check each against the policy, run it, and send
 *      the results back.
 *   3. Repeat until the model answers without asking for a tool.
 *
 * Everything else in this folder exists to serve this loop.
 */
import { check, humanDecision, type Access, type Verdict, type Who } from "../policy/check.js";
import type { ForgePolicy, PolicyDecisionRecord } from "../policy/schema.js";
import type { Reply, Session, Tool, ToolCall, ToolResult, ToolSpec } from "./types.js";
import type { Screen } from "./ui.js";
import type { UsageTracker } from "./usage.js";
import { telemetry } from "./telemetry.js";
import { CONTINUE, estimateTokens, shouldCompact } from "./compaction.js";
import { compactAt } from "./models.js";
import { tokens } from "./usage.js";

const ENGRAM_BASE = "http://127.0.0.1:7742";

/** Pull relevant memories from Engram before the first model call. Silent if offline. */
async function autoRecall(message: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3_000);
    const res = await fetch(`${ENGRAM_BASE}/v1/tools/engram_recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, n_results: 3 }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    const content = typeof data.content === "string" ? data.content.trim() : null;
    return content && content.length > 10 ? content : null;
  } catch {
    return null;
  }
}

/** Tool output beyond this is cut, so one huge result cannot fill the context. */
const MAX_OUTPUT_CHARS = 30_000;

export interface Agent {
  session: Session;
  tools: Tool[];
  policy: ForgePolicy;
  usage: UsageTracker;
  screen: Screen;
  who: Who;
  cwd: string;
  /** Ask the person whether a tool call may run. Called only when the policy says "ask". */
  approve(label: string, reason: string, access: Access): Promise<boolean>;
  /** False when nobody is at the keyboard: every "ask" is refused without asking. Default true. */
  interactive?: boolean;
  /** Write policy decisions to the audit log. */
  audit(record: PolicyDecisionRecord): void;
  /** Stop after this many model requests in one turn (default 50). */
  maxSteps?: number;
}

/** Run one turn: from the person's message to the model's final answer. */
export async function runTurn(message: string, agent: Agent): Promise<string> {
  // Prepend relevant memories from Engram if available.
  const memories = await autoRecall(message);
  let input: string | ToolResult[] = memories
    ? `[Relevant memories from past sessions]\n${memories}\n\n[User message]\n${message}`
    : message;

  let askedForAnswer = false;
  for (let step = 0; step < (agent.maxSteps ?? 50); step++) {
    if (agent.usage.overBudget) {
      agent.screen.note("Budget reached. Raise FORGE_BUDGET_USD to continue.");
      return "";
    }

    // About to outgrow the context window: replace the conversation with a summary, then carry on.
    let compacted = false;
    const window = agent.usage.model.contextWindow;
    if (agent.session.compact && shouldCompact(agent.usage.contextUsed, input, window, compactAt(), agent.usage.contextFloor)) {
      compacted = await compact(agent, input, message);
      if (compacted) input = CONTINUE;
    }

    // Text is shown as the model writes it when the screen can stream; otherwise all at once.
    agent.screen.working(true);
    let streamed = false;
    const stream = agent.screen.stream?.bind(agent.screen);
    const onText = stream
      ? (delta: string) => {
          if (!streamed) {
            streamed = true;
            agent.screen.working(false);
          }
          stream(delta);
        }
      : undefined;
    let reply: Reply;
    try {
      reply = await agent.session.send(input, onText);
    } finally {
      agent.screen.working(false);
      // A reply that broke off mid-stream still has its line ended.
      if (streamed) agent.screen.endStream?.(reply! ? reply.text : "");
    }
    agent.usage.addReply(reply.usage);
    if (compacted) agent.usage.contextFloor = reply.usage.inputTokens + reply.usage.cachedTokens;
    if (!streamed && reply.text.trim()) agent.screen.say(reply.text);

    if (reply.stopped === "refused") {
      agent.screen.note("The model declined this request.");
      return reply.text;
    }

    if (reply.toolCalls.length === 0) {
      // An empty reply would end the turn in silence. Ask once for the answer, then say what happened.
      if (reply.stopped === "done" && !reply.text.trim()) {
        if (!askedForAnswer) {
          askedForAnswer = true;
          input = `You ended without replying. Answer the user's request now, using what you have found:\n${message}`;
          continue;
        }
        agent.screen.note("The model ended without an answer.");
        return "";
      }
      if (reply.stopped === "done") return reply.text;
      input = "Your reply was cut off at the output limit. Continue from where you stopped.";
      continue;
    }

    // Every tool call gets an answer, or the next request is invalid.
    // Reads and shell calls run in parallel; writes serialize to avoid conflicts.
    if (reply.stopped === "cut_off") {
      input = reply.toolCalls.map((call) =>
        failed(call, "Not run: your reply was cut off at the output limit. Use smaller steps, and edit instead of rewriting whole files."),
      );
    } else {
      input = await runToolsParallel(reply.toolCalls, agent);
    }
  }

  agent.screen.note("Stopped: too many steps in one turn.");
  return "";
}

/** Summarize the conversation to free context. True when it was replaced (pending input is now in the summary). */
export async function compact(agent: Agent, pending: string | ToolResult[] | undefined, latestRequest: string): Promise<boolean> {
  const window = agent.usage.model.contextWindow;
  const before = agent.usage.contextUsed + estimateTokens(pending);
  agent.screen.note(`Context ${tokens(before)}${window ? ` of ${tokens(window)}` : ""}: summarizing the conversation to make room.`);
  agent.screen.working(true);
  const result = await agent.session.compact!(pending, latestRequest).finally(() => agent.screen.working(false));
  if (!result) return false;
  agent.usage.addReply(result.usage);
  // The next request starts from the summary; until it reports its real size, count the summary.
  agent.usage.contextUsed = estimateTokens(result.carried);
  agent.screen.note(
    result.fallback
      ? "Summarizing failed, so the earlier conversation was cleared. Your latest request was kept."
      : `Summarized: ${tokens(before)} → about ${tokens(agent.usage.contextUsed)}.`,
  );
  return true;
}

/**
 * Run tool calls with smart parallelism: reads and shell calls run concurrently;
 * writes serialize so two agents don't clobber the same file.
 */
async function runToolsParallel(calls: ToolCall[], agent: Agent): Promise<ToolResult[]> {
  if (calls.length === 1) return [await runTool(calls[0]!, agent)];

  // Split into waves: reads/shell first (parallel), then writes (sequential).
  const reads: { idx: number; call: ToolCall }[] = [];
  const writes: { idx: number; call: ToolCall }[] = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    const tool = agent.tools.find((t) => t.name === call.name);
    const access = tool ? tool.access(call.input) : { kind: "none" as const };
    // MCP tools can do anything; only those the server marks read-only run in parallel.
    if (access.kind === "write" || (access.kind === "mcp" && !access.readOnly)) writes.push({ idx: i, call });
    else reads.push({ idx: i, call });
  }

  const results: ToolResult[] = new Array(calls.length);
  await Promise.all(reads.map(async ({ idx, call }) => { results[idx] = await runTool(call, agent); }));
  for (const { idx, call } of writes) results[idx] = await runTool(call, agent);
  return results;
}

/** Check one tool call against the policy, run it if allowed, and report what happened. */
async function runTool(call: ToolCall, agent: Agent): Promise<ToolResult> {
  const tool = agent.tools.find((t) => t.name === call.name);
  if (!tool) return failed(call, `There is no tool named "${call.name}".`);

  const problem = checkInput(tool.inputSchema, call.input);
  if (problem) return failed(call, `${problem} Call ${tool.name} again with corrected input.`);

  const label = tool.label(call.input);
  const access = tool.access(call.input);
  const verdict: Verdict = check(access, agent.policy, agent.who, agent.cwd);
  verdict.records.forEach(agent.audit);

  if (verdict.decision === "deny") {
    agent.screen.activity(label, "not allowed", true);
    telemetry.record(call.name, false, 0, "denied by policy");
    return failed(
      call,
      `Not allowed by policy: ${verdict.reason}. Do not retry or work around it with another tool or address. ` +
        "Tell the user it was blocked, and do not answer as if it had run.",
    );
  }
  if (verdict.decision === "ask" && agent.interactive === false) {
    agent.audit(humanDecision(access, false, agent.who, "Refused: no one was there to approve it"));
    agent.screen.activity(label, "needs approval, no one to ask", true);
    telemetry.record(call.name, false, 0, "unattended");
    return failed(
      call,
      `This needs the user's approval (${verdict.reason}), and no one is available to give it, so it was not run. ` +
        "Do not try to get around this with a different tool or address; say what you could not do.",
    );
  }
  if (verdict.decision === "ask") {
    const approved = await agent.approve(label, verdict.reason, access);
    agent.audit(humanDecision(access, approved, agent.who));
    if (!approved) {
      agent.screen.activity(label, "declined", true);
      telemetry.record(call.name, false, 0, "declined by user");
      return failed(call, "The user declined this action. Ask them how they would like to proceed.");
    }
  }

  // Circuit breaker: if this tool has failed too many times in a row, stop trying.
  if (telemetry.isTripped(call.name)) {
    agent.screen.activity(label, "circuit tripped", true);
    return failed(call, `Tool "${call.name}" has failed repeatedly. Try a different approach.`);
  }

  const t0 = Date.now();
  try {
    const result = await tool.run(call.input, agent.cwd);
    const durationMs = Date.now() - t0;
    telemetry.record(call.name, !result.isError, durationMs, result.isError ? result.output : undefined);
    if (result.lines) agent.usage.addLines(result.lines.file, result.lines.added, result.lines.removed);
    const detail = result.isError ? "failed" : result.lines ? `+${result.lines.added} −${result.lines.removed}` : undefined;
    agent.screen.activity(label, detail, result.isError);
    return { id: call.id, output: shorten(result.output), isError: result.isError ?? false };
  } catch (err) {
    telemetry.record(call.name, false, Date.now() - t0, (err as Error).message);
    agent.screen.activity(label, "failed", true);
    return failed(call, (err as Error).message);
  }
}

/**
 * Check a tool's input against its schema before it runs: required fields, top-level types and
 * allowed values. Models, small local ones especially, send wrong types, and streamed tool inputs
 * are not validated by the provider. Returns what is wrong, or null.
 */
export function checkInput(schema: ToolSpec["inputSchema"], input: Record<string, unknown>): string | null {
  const missing = schema.required.filter((key) => input[key] === undefined);
  if (missing.length > 0) return `Missing required input: ${missing.join(", ")}.`;
  for (const [key, value] of Object.entries(input)) {
    const spec = schema.properties[key];
    if (!spec || value === undefined) continue;
    const types = spec.type === undefined ? [] : Array.isArray(spec.type) ? spec.type : [spec.type];
    if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
      return `Input "${key}" should be ${types.join(" or ")}, not ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}.`;
    }
    if (Array.isArray(spec["enum"]) && !(spec["enum"] as unknown[]).includes(value)) {
      return `Input "${key}" must be one of: ${(spec["enum"] as unknown[]).map((v) => JSON.stringify(v)).join(", ")}.`;
    }
  }
  return null;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "null": return value === null;
    default: return true;
  }
}

function failed(call: ToolCall, message: string): ToolResult {
  return { id: call.id, output: message, isError: true };
}

function shorten(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n(output cut: ${output.length - MAX_OUTPUT_CHARS} more characters)`;
}

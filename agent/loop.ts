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
import type { Session, Tool, ToolCall, ToolResult } from "./types.js";
import type { Screen } from "./ui.js";
import type { UsageTracker } from "./usage.js";
import { telemetry } from "./telemetry.js";

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
  /** Write policy decisions to the audit log. */
  audit(record: PolicyDecisionRecord): void;
  /** Stop after this many model requests in one turn (default 50). */
  maxSteps?: number;
}

/** Run one turn: from the person's message to the model's final answer. */
export async function runTurn(message: string, agent: Agent): Promise<string> {
  let input: string | ToolResult[] = message;

  for (let step = 0; step < (agent.maxSteps ?? 50); step++) {
    if (agent.usage.overBudget) {
      agent.screen.note("Budget reached. Raise FORGE_BUDGET_USD to continue.");
      return "";
    }

    agent.screen.working(true);
    const reply = await agent.session.send(input).finally(() => agent.screen.working(false));
    agent.usage.addReply(reply.usage);
    if (reply.text) agent.screen.say(reply.text);

    if (reply.stopped === "refused") {
      agent.screen.note("The model declined this request.");
      return reply.text;
    }

    if (reply.toolCalls.length === 0) {
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
    if (access.kind === "write") writes.push({ idx: i, call });
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

  const missing = tool.inputSchema.required.filter((key) => call.input[key] === undefined);
  if (missing.length > 0) return failed(call, `Missing required input: ${missing.join(", ")}.`);

  const label = tool.label(call.input);
  const access = tool.access(call.input);
  const verdict: Verdict = check(access, agent.policy, agent.who, agent.cwd);
  verdict.records.forEach(agent.audit);

  if (verdict.decision === "deny") {
    agent.screen.activity(label, "not allowed", true);
    telemetry.record(call.name, false, 0, "denied by policy");
    return failed(call, `Not allowed by policy: ${verdict.reason}. Do not retry; find another way or tell the user.`);
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

function failed(call: ToolCall, message: string): ToolResult {
  return { id: call.id, output: message, isError: true };
}

function shorten(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n(output cut: ${output.length - MAX_OUTPUT_CHARS} more characters)`;
}

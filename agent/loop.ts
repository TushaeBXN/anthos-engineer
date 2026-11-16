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
    const results: ToolResult[] = [];
    for (const call of reply.toolCalls) {
      results.push(
        reply.stopped === "cut_off"
          ? failed(call, "Not run: your reply was cut off at the output limit. Use smaller steps, and edit instead of rewriting whole files.")
          : await runTool(call, agent),
      );
    }
    input = results;
  }

  agent.screen.note("Stopped: too many steps in one turn.");
  return "";
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
    return failed(call, `Not allowed by policy: ${verdict.reason}. Do not retry; find another way or tell the user.`);
  }
  if (verdict.decision === "ask") {
    const approved = await agent.approve(label, verdict.reason, access);
    agent.audit(humanDecision(access, approved, agent.who));
    if (!approved) {
      agent.screen.activity(label, "declined", true);
      return failed(call, "The user declined this action. Ask them how they would like to proceed.");
    }
  }

  try {
    const result = await tool.run(call.input, agent.cwd);
    if (result.lines) agent.usage.addLines(result.lines.file, result.lines.added, result.lines.removed);
    const detail = result.isError ? "failed" : result.lines ? `+${result.lines.added} −${result.lines.removed}` : undefined;
    agent.screen.activity(label, detail, result.isError);
    return { id: call.id, output: shorten(result.output), isError: result.isError ?? false };
  } catch (err) {
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

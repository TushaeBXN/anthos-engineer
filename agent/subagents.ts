/**
 * Sub-agents: the `task` tool hands one self-contained job to a child agent.
 *
 * The child runs the same loop with its own conversation and returns only its
 * final report, so the parent's context stays small. What does not change:
 * the same policy checks every child tool call, approvals still come to the
 * person, usage and budget are shared, and children cannot start children.
 *
 * Agent types: the built-ins below, plus markdown files in .forge/agents/:
 *
 *   ---
 *   name: reviewer
 *   description: Reviews a diff for bugs
 *   tools: read, grep, glob
 *   maxSteps: 15
 *   model: some-other-model     (optional; same provider)
 *   ---
 *   Instructions for this agent.
 */
import fs from "node:fs";
import path from "node:path";
import { runTurn, type Agent } from "./loop.js";
import type { Session, Tool, ToolSpec } from "./types.js";
import type { Screen } from "./ui.js";

export interface AgentType {
  name: string;
  description: string;
  /** Tool names this agent may use; null means all of the parent's tools. */
  tools: string[] | null;
  maxSteps: number;
  model?: string;
  instructions: string;
  source: string;
}

const DEFAULT_STEPS = 30;
const READ_ONLY = ["read", "glob", "grep", "find_dependents", "web_search", "web_fetch", "recall"];

export const BUILT_IN: AgentType[] = [
  {
    name: "general",
    description: "Any multi-step job: research, edits, running commands.",
    tools: null,
    maxSteps: DEFAULT_STEPS,
    instructions: "",
    source: "built-in",
  },
  {
    name: "explore",
    description: "Read-only: find code and answer questions about the project. Cannot change files or run commands.",
    tools: READ_ONLY,
    maxSteps: 20,
    instructions: "Only look; do not try to change anything. Give file paths and line numbers for what you found.",
    source: "built-in",
  },
];

const CHILD_PROMPT = `You are a Forge sub-agent. Another Forge agent gave you one task. Do it with your tools, then end with a complete report in plain text. The other agent sees only your final message, not your tool calls, so include the file paths, line numbers and details it needs to act on. If something was blocked or failed, say so plainly.`;

/** Built-in agent types, then any in .forge/agents/ (a custom type replaces a built-in with the same name). */
export function loadAgentTypes(cwd: string): AgentType[] {
  const types = new Map(BUILT_IN.map((t) => [t.name, t]));
  const dir = path.join(cwd, ".forge", "agents");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [...types.values()];
  }
  for (const file of files) {
    const type = parseAgentFile(fs.readFileSync(path.join(dir, file), "utf8"), `.forge/agents/${file}`);
    if (type) types.set(type.name, type);
  }
  return [...types.values()];
}

/** Read one agent file. Returns null when it has no frontmatter or no name. */
export function parseAgentFile(text: string, source: string): AgentType | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/);
    if (kv) fields.set(kv[1]!, kv[2]!.replace(/^["']|["']$/g, ""));
  }
  const name = fields.get("name");
  if (!name || !/^[\w-]+$/.test(name)) return null;
  const steps = Number(fields.get("maxSteps"));
  const tools = fields.get("tools");
  return {
    name,
    description: fields.get("description") || "Custom agent.",
    tools: tools ? tools.split(",").map((t) => t.trim()).filter(Boolean) : null,
    maxSteps: Number.isInteger(steps) && steps > 0 ? steps : DEFAULT_STEPS,
    model: fields.get("model") || undefined,
    instructions: match[2]!.trim(),
    source,
  };
}

export interface TaskDeps {
  /** The agent that owns this tool (read when the tool runs, since it is built after the tool). */
  parent: () => Agent;
  /** A new conversation with the given instructions and tools; model overrides the parent's model name. */
  newSession(system: string, tools: ToolSpec[], model?: string): Session;
  /** The parent's own system prompt: Forge's rules, project instructions and repo map. */
  basePrompt: string;
  types: AgentType[];
}

export function makeTaskTool(deps: TaskDeps): Tool {
  const list = deps.types.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  return {
    name: "task",
    description:
      "Hand a self-contained job to a sub-agent, which works on its own and returns only a final report. " +
      "Use it for broad searches or separate pieces of work, to keep this conversation short. " +
      "Several task calls in one reply run at the same time. The sub-agent knows nothing about this conversation: " +
      `put everything it needs in the prompt.\n\nAgents:\n${list}`,
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "A short label for the job, 3 to 6 words" },
        prompt: { type: "string", description: "Complete instructions for the sub-agent" },
        agent: { type: "string", description: `Which agent: ${deps.types.map((t) => t.name).join(", ")} (default general)` },
      },
      required: ["description", "prompt"],
    },
    // The task itself touches nothing; every tool call the sub-agent makes is checked on its own.
    access: () => ({ kind: "none" }),
    label: (input) => `Task  [${input.agent ?? "general"}] ${input.description}`,
    async run(input) {
      const parent = deps.parent();
      const name = String(input.agent ?? "general");
      const type = deps.types.find((t) => t.name === name);
      if (!type) {
        return { output: `No agent named "${name}". Agents: ${deps.types.map((t) => t.name).join(", ")}.`, isError: true };
      }

      // Children never get the task tool, so they cannot start children of their own.
      const tools = parent.tools.filter((t) => t.name !== "task" && (type.tools === null || type.tools.includes(t.name)));
      const system = [CHILD_PROMPT, type.instructions, deps.basePrompt].filter(Boolean).join("\n\n");
      const child: Agent = {
        ...parent,
        session: deps.newSession(system, tools, type.model),
        tools,
        usage: parent.usage.child(),
        screen: childScreen(parent.screen, name),
        who: { ...parent.who, agentId: `${parent.who.agentId}/${name}` },
        maxSteps: type.maxSteps,
      };

      const report = (await runTurn(String(input.prompt), child)).trim();
      if (!report) {
        return { output: "The sub-agent stopped without a report (step limit, budget, or the model declined).", isError: true };
      }
      return { output: report };
    },
  };
}

/** A child's tool calls show under the parent's, tagged with the agent's name. Its report goes back to the parent, not the screen. */
function childScreen(parent: Screen, name: string): Screen {
  return {
    say: () => {},
    activity: (label, detail, failed) => parent.activity(`${name} · ${label}`, detail, failed),
    note: (text) => parent.note(`${name}: ${text}`),
    working: (on) => parent.working(on),
  };
}

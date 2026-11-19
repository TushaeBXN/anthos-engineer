/** Puts the pieces together: model, tools, policy, usage and screen. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { recordDecision } from "../policy/audit.js";
import type { Access } from "../policy/check.js";
import { loadPolicy } from "../policy/parser.js";
import { makeTools } from "../tools/index.js";
import { UndoStack } from "./undo.js";
import type { Agent } from "./loop.js";
import { repoMapBudget, resolveModel, type ModelInfo } from "./models.js";
import { buildRepoMap } from "./repomap.js";
import { loadAgentTypes, makeTaskTool } from "./subagents.js";
import { anthropicSession } from "./providers/anthropic.js";
import { openaiSession } from "./providers/openai.js";
import type { Session, Tool, ToolSpec } from "./types.js";
import { confirm, terminal, type Screen } from "./ui.js";
import { UsageTracker } from "./usage.js";

const SYSTEM_PROMPT = `You are Forge, a software engineering agent built by Anthos Intelligence. You work in the user's project through tools.

How to work:
- Look before you change. Use glob and grep to find code, and read a file before you edit it.
- Make the smallest change that does the job. Use edit for existing files; use write only for new files.
- After changing code, run verify and fix what it reports.
- Some actions need the user's approval, and some are forbidden by the project's policy. If an action is declined or not allowed, do not try to get around it; say what happened.
- When you finish, say what you changed in a few plain sentences.`;

/** Files that hold a project's own instructions for agents. The first one found is used. */
const INSTRUCTION_FILES = ["FORGE.md", "AGENTS.md", "CLAUDE.md"];

export interface CreatedAgent extends Agent {
  undo: UndoStack;
}

/** Where output goes and who answers approval questions. Defaults to the terminal. */
export interface AgentIO {
  screen: Screen;
  ask(label: string, reason: string): Promise<"yes" | "no" | "always">;
}

/** extraTools: tools from outside Forge, such as MCP servers, added after Forge's own. */
export function createAgent(cwd = process.cwd(), io?: AgentIO, extraTools: Tool[] = []): CreatedAgent {
  const model = resolveModel();
  const budget = Number(process.env["FORGE_BUDGET_USD"]);
  const alwaysAllowed = new Set<string>();
  const undo = new UndoStack();
  const tools = [...makeTools(undo), ...extraTools];
  const system = systemPrompt(cwd);
  // Sub-agents can run in parallel; their approval questions still go to the person one at a time.
  let approvals: Promise<unknown> = Promise.resolve();

  let agent: CreatedAgent;
  tools.push(
    makeTaskTool({
      parent: () => agent,
      newSession: (prompt, specs, name) => createSession(name ? { ...model, model: name } : model, prompt, specs),
      basePrompt: system,
      types: loadAgentTypes(cwd),
    }),
  );

  agent = {
    session: createSession(model, system, tools),
    tools,
    undo,
    policy: loadPolicy(path.join(cwd, "forge.policy.yaml")),
    usage: new UsageTracker(model, budget > 0 ? budget : null),
    screen: io?.screen ?? terminal,
    who: { agentId: "forge", sessionId: crypto.randomUUID() },
    cwd,
    interactive: io ? true : Boolean(process.stdin.isTTY),
    approve(label, reason, access) {
      const ask = approvals.then(async () => {
        const kind = approvalKind(access);
        if (alwaysAllowed.has(kind)) return true;
        const answer = io ? await io.ask(label, reason) : await confirm(`${label}?`);
        if (answer === "always") alwaysAllowed.add(kind);
        return answer !== "no";
      });
      approvals = ask.catch(() => {});
      return ask;
    },
    audit(record) {
      try {
        recordDecision(record);
      } catch {
        // The audit log must never stop the work.
      }
    },
  };
  return agent;
}

function createSession(model: ModelInfo, system: string, specs: ToolSpec[]): Session {
  if (model.keyEnv && !model.apiKey && model.keyEnv !== "FORGE_API_KEY") {
    throw new Error(`Set ${model.keyEnv} to use ${model.provider}:\n\n    export ${model.keyEnv}=...\n\n  Run "forge providers" to see every provider and the key it needs.`);
  }
  return model.provider === "anthropic"
    ? anthropicSession(model.model, system, specs)
    : openaiSession(model.model, system, specs, model.baseUrl, model.apiKey);
}

/** "Always" covers all file reads, all file writes, one exact command, or one network operation on one host. */
function approvalKind(access: Access): string {
  if (access.kind === "shell") return `shell:${access.command}`;
  if (access.kind === "network") return `network:${access.operation}:${access.target}`;
  if (access.kind === "mcp") return `mcp:${access.server}:${access.tool}`;
  return access.kind;
}

function systemPrompt(cwd: string): string {
  let prompt = SYSTEM_PROMPT;
  for (const name of INSTRUCTION_FILES) {
    const file = path.join(cwd, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8").slice(0, 20_000);
    prompt += `\n\nThe project's own instructions (${name}):\n\n${text}`;
    break;
  }
  const map = buildRepoMap(cwd, repoMapBudget());
  if (map.text) {
    prompt += `\n\nA map of the project: source files, most depended-on first, with the names each defines. Read a file before relying on it.\n\n${map.text}`;
  }
  return prompt;
}

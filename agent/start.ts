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
import { resolveModel, type ModelInfo } from "./models.js";
import { anthropicSession } from "./providers/anthropic.js";
import { openaiSession } from "./providers/openai.js";
import type { Session, ToolSpec } from "./types.js";
import { confirm, terminal } from "./ui.js";
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

export function createAgent(cwd = process.cwd()): CreatedAgent {
  const model = resolveModel();
  const budget = Number(process.env["FORGE_BUDGET_USD"]);
  const alwaysAllowed = new Set<string>();
  const undo = new UndoStack();
  const tools = makeTools(undo);

  return {
    session: createSession(model, systemPrompt(cwd), tools),
    tools,
    undo,
    policy: loadPolicy(path.join(cwd, "forge.policy.yaml")),
    usage: new UsageTracker(model, budget > 0 ? budget : null),
    screen: terminal,
    who: { agentId: "forge", sessionId: crypto.randomUUID() },
    cwd,
    async approve(label, _reason, access) {
      const kind = approvalKind(access);
      if (alwaysAllowed.has(kind)) return true;
      const answer = await confirm(`${label}?`);
      if (answer === "always") alwaysAllowed.add(kind);
      return answer !== "no";
    },
    audit(record) {
      try {
        recordDecision(record);
      } catch {
        // The audit log must never stop the work.
      }
    },
  };
}

function createSession(model: ModelInfo, system: string, specs: ToolSpec[]): Session {
  return model.provider === "anthropic"
    ? anthropicSession(model.model, system, specs)
    : openaiSession(model.model, system, specs, model.baseUrl);
}

/** "Always" covers all file reads, all file writes, one exact command, or one network operation on one host. */
function approvalKind(access: Access): string {
  if (access.kind === "shell") return `shell:${access.command}`;
  if (access.kind === "network") return `network:${access.operation}:${access.target}`;
  return access.kind;
}

function systemPrompt(cwd: string): string {
  for (const name of INSTRUCTION_FILES) {
    const file = path.join(cwd, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8").slice(0, 20_000);
    return `${SYSTEM_PROMPT}\n\nThe project's own instructions (${name}):\n\n${text}`;
  }
  return SYSTEM_PROMPT;
}

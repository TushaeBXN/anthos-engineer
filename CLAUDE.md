# Forge by Anthos Intelligence — Developer Guide

## Setup

```bash
npm install
npx tsx cli/index.ts                 # start a conversation
npx tsx cli/index.ts "<request>"     # do one thing and exit
npx tsx cli/index.ts init            # index the repo for find_dependents
npx tsx cli/index.ts doctor          # check the setup
```

Requires Node.js 22+. Choose a model once with `npx tsx cli/index.ts config set provider <name>` and `config set model <name>` (saved to `~/.forgerc`); `forge providers` lists the options. Keys stay in environment variables, never in `~/.forgerc`.

## How it works

`agent/loop.ts` is the whole design: send the conversation to the model; if it asks for tools, check each with `policy/check.ts`, run it, send the results back; repeat until it answers without a tool call.

## Rules to keep

- **Every tool call goes through `check()` in the loop.** Tools do not check policy themselves, and nothing runs a tool except the loop.
- **A tool is one object in `tools/`**: a description, an input schema, `access()` (what it touches, for the policy), `label()` (one line for the screen) and `run()`. Add it to `tools/index.ts`.
- **Providers translate, nothing more.** `agent/providers/*` turn the shared types in `agent/types.ts` into one API's format and back. The loop and tools never import an SDK.
- **Everything printed goes through a `Screen`.** In the terminal that is `agent/ui.ts` (one header panel at startup, `⎿` lines for tool calls, a spinner while working, a status line after each turn). The gRPC server and sub-agents supply their own `Screen`; nothing else writes to the console during a turn. A `Screen` with `stream()` gets the reply as it is written, then `endStream()`; one without it gets `say()` once.
- **Model facts live in `agent/models.ts`**: open or closed, local or hosted, context size, price. Do not guess a price; leave it out.
- **Anything that leaves the machine is `{ kind: "network" }` access**, checked per host. No tool fetches a URL without going through the policy.
- **Each provider reads only its own key** (`keyEnv` in `agent/models.ts`). Never fall back to another provider's key.
- **Sub-agents are agents, not shortcuts.** They run `runTurn` with the parent's policy, approver and audit; they never get the `task` tool.
- **A tool that runs commands reports them as `{ kind: "shell" }` access**, even when it isn't `bash` (`verify` reports the type check, tests and lint), so the policy sees what will run.
- **Every command Forge runs goes through `sandboxed()` in `agent/sandbox.ts`** (bash, verify), and calls the launch's `after()` once it finishes. Don't call `execFile` for a model-chosen command without them.
- **Every tool input is checked against its schema (`checkInput` in `agent/loop.ts`) before the policy check.** Streamed tool inputs are not validated by the provider.
- **When no one can answer an "ask", the answer is no**, and the audit log says so truthfully.
- **MCP tools are `{ kind: "mcp" }` access.** A project's servers start only after the person trusts them; nothing writes to `.forge/`.
- **Nothing writes to the dependency graph directly.** Changes go through an event in `model/events.ts`; `model/graph.ts` applies events.

## Module map

| Module | Responsibility |
|---|---|
| `agent/loop.ts` | The agent loop |
| `agent/start.ts` | Build an agent: model, tools, policy, approvals, system prompt |
| `agent/types.ts` | Shared shapes: ToolCall, ToolResult, Reply, Session, Tool |
| `agent/models.ts` | Provider and model lookup tables |
| `agent/usage.ts` | Token, cost and line counts; status line |
| `agent/ui.ts` | Terminal output and prompts |
| `agent/undo.ts` | File snapshots for `/undo` |
| `agent/telemetry.ts` | Per-tool logging and circuit breaker |
| `agent/repomap.ts` | Ranked project outline for the system prompt |
| `agent/compaction.ts` | When and how to summarize the conversation to free context |
| `agent/subagents.ts` | The `task` tool, agent types, `.forge/agents/` loader |
| `agent/mcp.ts` | MCP servers: config, project trust, connect, wrap tools |
| `agent/version.ts` | Forge's version, read from package.json (the only place it's set) |
| `agent/sandbox.ts` | Runs commands in the OS sandbox: macOS Seatbelt, Linux bubblewrap; sets aside protected paths a command created |
| `agent/doctor.ts` | `forge doctor`: setup checks, each with a fix; writes nothing, never prints a key |
| `agent/providers/anthropic.ts` | Anthropic SDK |
| `agent/providers/openai.ts` | Every OpenAI-compatible provider (OpenAI, Gemini, OpenRouter, Groq, Ollama, …) |
| `tools/files.ts` | read, write, edit |
| `tools/search.ts` | glob, grep |
| `tools/bash.ts` | bash |
| `tools/project.ts` | find_dependents, verify |
| `tools/web.ts` | web_search, web_fetch |
| `tools/memory.ts` | recall, remember (Engram) |
| `policy/check.ts` | allow / ask / deny for one tool call |
| `policy/evaluator.ts` | Match a request against the rules |
| `policy/parser.ts` | Load forge.policy.yaml |
| `policy/presets.ts` | Ready-made policies for `forge policy use` |
| `policy/audit.ts` | Audit log (`.forge/audit.db`) |
| `model/*` | Dependency index (`.forge/events.db`) |
| `verify/chain.ts` | Type check → tests → lint |
| `executor/git.ts` | Guarded git helpers |
| `diff/semantic.ts` | Group index changes by area (demo) |
| `demo/*` | Web demo running the same loop in a sandbox |
| `cli/index.ts` | The forge command: chat, one-shot, config, providers, doctor, serve |
| `cli/commands.ts` | Slash commands |
| `grpc/*` | `forge.proto`, the gRPC server, an example client |
| `vscode-extension/*` | VS Code extension (plain JS, no build step); `tests/vscode-real/run.mjs` runs it in real VS Code |

## Build and test

```bash
npm run build              # tsc → dist/
npm test
./node_modules/.bin/tsc --noEmit
```

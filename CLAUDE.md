# Forge by Anthos Intelligence — Developer Guide

## Setup

```bash
npm install
npx tsx cli/index.ts                 # start a conversation
npx tsx cli/index.ts "<request>"     # do one thing and exit
npx tsx cli/index.ts init            # index the repo for find_dependents
```

Requires Node.js 22+. Choose a model with `FORGE_PROVIDER` and `FORGE_MODEL`; see the README.

## How it works

`agent/loop.ts` is the whole design: send the conversation to the model; if it asks for tools, check each with `policy/check.ts`, run it, send the results back; repeat until it answers without a tool call.

## Rules to keep

- **Every tool call goes through `check()` in the loop.** Tools do not check policy themselves, and nothing runs a tool except the loop.
- **A tool is one object in `tools/`**: a description, an input schema, `access()` (what it touches, for the policy), `label()` (one line for the screen) and `run()`. Add it to `tools/index.ts`.
- **Providers translate, nothing more.** `agent/providers/*` turn the shared types in `agent/types.ts` into one API's format and back. The loop and tools never import an SDK.
- **Everything printed goes through `agent/ui.ts`.** Model text at full strength; everything Forge adds is dim and indented. No banners, boxes or progress bars.
- **Model facts live in `agent/models.ts`**: open or closed, local or hosted, context size, price. Do not guess a price; leave it out.
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
| `agent/providers/anthropic.ts` | Anthropic SDK |
| `agent/providers/openai.ts` | OpenAI-compatible APIs (OpenAI, Ollama, LM Studio, Groq, Together) |
| `tools/files.ts` | read, write, edit |
| `tools/search.ts` | glob, grep |
| `tools/bash.ts` | bash |
| `tools/project.ts` | find_dependents, verify |
| `policy/check.ts` | allow / ask / deny for one tool call |
| `policy/evaluator.ts` | Match a request against the rules |
| `policy/parser.ts` | Load forge.policy.yaml |
| `policy/audit.ts` | Audit log (`.forge/audit.db`) |
| `model/*` | Dependency index (`.forge/events.db`) |
| `verify/chain.ts` | Type check → tests → lint |
| `executor/git.ts` | Guarded git helpers |
| `diff/semantic.ts` | Group index changes by area (demo) |
| `demo/*` | Web demo running the same loop in a sandbox |
| `cli/index.ts` | The forge command |

## Build and test

```bash
npm run build              # tsc → dist/
npm test
./node_modules/.bin/tsc --noEmit
```

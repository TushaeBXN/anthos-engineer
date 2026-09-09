# Forge by Anthos Intelligence — Developer Guide

## Setup

```bash
npm install
npx tsx cli/index.ts init                              # index the repo
npx tsx cli/index.ts query X                           # query dependents of X

# Anthropic (default)
export FORGE_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-...
# OpenAI
export FORGE_PROVIDER=openai OPENAI_API_KEY=sk-...
# Ollama (local, no key needed)
export FORGE_PROVIDER=ollama FORGE_MODEL=llama3.1:70b

npx tsx cli/index.ts change "add a health endpoint"    # LLM-driven change
```

Requires: Node.js 22+, npm. For `forge change`: set `FORGE_PROVIDER` and the matching API key (Ollama needs no key).

## Architecture Invariants

- **No code path outside `executor/` may touch `fs` or `shell` for agent-driven changes.** The executor re-validates the capability token before every operation.
- **Nothing writes to the materialized graph directly.** Every mutation goes through an event in `events.ts` first; `graph.ts` applies events. This keeps "why does Forge think X" answerable by log lookup.
- **Normalization happens once.** `policy/evaluator.ts` normalizes an ActionRequest before matching rules. Resource-specific checks are constraint validators that plug in after the generic match — not separate per-resource logic.
- **`forge change` flow**: LLM plan → Permission Broker (evaluate) → user approval → Capability Executor (writeFile) → localInvalidation → Verification Chain → Semantic Diff.

## Module Map

| Module | Responsibility |
|---|---|
| `model/schema.ts` | Core types: SystemNode, SystemEdge, ForgeEventPayload |
| `model/events.ts` | Append-only SQLite event log |
| `model/graph.ts` | In-memory materialized view + transitive dependent lookup |
| `model/extractor.ts` | Extractor interface |
| `model/typescript/ts-extractor.ts` | ts-morph extraction |
| `model/incremental.ts` | localInvalidation, dependencyInvalidation, initFromFiles |
| `policy/parser.ts` | Load forge.policy.yaml (deny-by-default) |
| `policy/evaluator.ts` | evaluate() + normalize() |
| `policy/audit.ts` | Append-only decision audit log |
| `capability/issuer.ts` | Issue / revoke short-lived capability tokens (60s TTL) |
| `executor/filesystem.ts` | The ONLY code path that calls fs for agent writes |
| `executor/shell.ts` | Whitelisted shell commands via capability token |
| `verify/chain.ts` | tsc → test → lint pipeline, all stages run even on failure |
| `diff/semantic.ts` | Graph events → human-readable grouped diff + blast radius |
| `llm/schema.ts` | Shared Plan types + JSON Schema for propose_plan tool |
| `llm/planner.ts` | Provider selection (FORGE_PROVIDER), system summary, dispatch to provider |
| `llm/providers/anthropic.ts` | Anthropic SDK provider |
| `llm/providers/openai-compatible.ts` | OpenAI-compatible provider (OpenAI, Ollama, Groq, Together, LM Studio, …) |
| `cli/index.ts` | forge init / forge query / forge change |

## Event store location

`.forge/events.db` in the working directory. Delete to reset.

## Build

```bash
npm run build   # tsc → dist/
npm test        # 40 tests across policy, executor, verify, diff suites
```

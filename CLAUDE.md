# Forge by Anthos Intelligence — Developer Guide

## Setup

```bash
npm install
npx tsx cli/index.ts init      # index the repo
npx tsx cli/index.ts query X   # query dependents of X
```

Requires: Node.js 22+, npm

## Architecture Invariants

- **No code path outside `executor/` may touch `fs` or `shell` for agent-driven changes.** The executor re-validates the capability token before every operation.
- **Nothing writes to the materialized graph directly.** Every mutation goes through an event in `events.ts` first; `graph.ts` applies events. This keeps "why does Forge think X" answerable by log lookup.
- **Normalization happens once.** `policy/evaluator.ts` (Step 2) normalizes an ActionRequest before matching rules. Resource-specific checks are constraint validators that plug in after the generic match — not separate per-resource logic.

## Module Map

| Module | Responsibility |
|---|---|
| `model/schema.ts` | Core types: SystemNode, SystemEdge, ForgeEventPayload |
| `model/events.ts` | Append-only SQLite event log |
| `model/graph.ts` | In-memory materialized view + transitive dependent lookup |
| `model/extractor.ts` | Extractor interface |
| `model/typescript/ts-extractor.ts` | ts-morph extraction |
| `model/incremental.ts` | localInvalidation, dependencyInvalidation, initFromFiles |
| `cli/index.ts` | forge init / forge query |

## Event store location

`.forge/events.db` in the working directory. Delete to reset.

## Build

```bash
npm run build   # tsc → dist/
```

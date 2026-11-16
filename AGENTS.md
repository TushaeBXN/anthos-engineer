# Forge by Anthos Intelligence — Developer Guide

## Setup

```bash
npm install
npx tsx cli/index.ts           # start a conversation
npx tsx cli/index.ts init      # index the repo
npx tsx cli/index.ts query X   # query dependents of X
```

Requires: Node.js 22+, npm

## Architecture Invariants

- **Every tool call goes through `check()` in `agent/loop.ts` before it runs.** Tools do not check policy themselves, and nothing runs a tool except the loop.
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
| `agent/loop.ts` | The agent loop |
| `tools/*` | read, write, edit, glob, grep, bash, find_dependents, verify |
| `policy/check.ts` | allow / ask / deny for one tool call |
| `cli/index.ts` | The forge command |

## Event store location

`.forge/events.db` in the working directory. Delete to reset.

## Build

```bash
npm run build   # tsc → dist/
```

## Git workflow (follow in order)

1. Check the current branch. Never work on `main` or `master`.
2. Create a branch named `forge/<short-description>` (lowercase, hyphens only).
3. Make the smallest change that solves the goal. Touch only files listed in your plan.
4. Verification must pass (`tsc`, tests, lint) before you commit. If it fails,
   fix it. After 3 failed attempts, stop and report what failed.
5. Review your own diff. Remove debug logging, commented-out code, and unrelated edits.
6. Commit with a message: a short summary line (what), then a sentence on why.
   Stage only the files you wrote — never `git add -A`.
7. Push the branch only. Pushing requires human approval.
8. Open a PR describing the change, how it was verified, and its blast radius.

**Never:** force-push, push to `main`/`master`, commit secrets or `.env` files,
edit `.git/`, merge your own PR, or skip verification.

If you are unsure, stop and ask. Stopping is always acceptable; guessing is not.

Git commands run through the `bash` tool and are checked against
`forge.policy.yaml` first, which denies force-pushes and pushes to `main`/`master`.

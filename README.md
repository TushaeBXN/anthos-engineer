<div align="center">

# Forge by Anthos Intelligence

**Staged TypeScript software engineering agent — event-sourced system model, deny-by-default permission broker, capability executor, verification chain, and LLM-driven change planning.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6.svg?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22+-339933.svg?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)

</div>

---

## What It Is

Forge is a software engineering agent where the LLM is a planning component, not the runtime. The durable platform beneath it enforces security, auditability, and correctness regardless of which model you use.

Four invariants hold across every change:

1. **Event-sourced System Model** — the codebase is represented as an append-only graph of functions, modules, and dependencies. Nothing writes to the graph directly; everything goes through events first.
2. **Deny-by-default Permission Broker** — every agent action is normalized into one shape (`ActionRequest`) and matched against a policy file before anything happens. `git push` and `shell: "git push"` hit the same decision path.
3. **Capability Executor** — the only component allowed to touch the real filesystem or shell. Agents never get raw handles; they get short-lived, scoped capability tokens (60-second TTL, re-validated before every operation).
4. **Verification Chain** — every change runs `tsc --noEmit → test → lint` before being considered done. All stages run even if an earlier one fails, so you get the full picture.

---

## Quick Start

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...

# Index the repo
npx tsx cli/index.ts init

# Ask Forge to make a change
npx tsx cli/index.ts change "add a health check endpoint"

# Query what depends on something
npx tsx cli/index.ts query getHealth
```

Or install globally after building:

```bash
npm run build && npm link
forge init
forge change "add a health check endpoint"
```

---

## How `forge change` Works

```
Goal: "add a health check endpoint"
        │
        ▼
  LLM (Claude API)
  ──────────────────────────────────────────
  Receives compact system model summary
  Returns structured plan via tool_use:
    CREATE src/api/health.ts   — health handler
    MODIFY src/index.ts        — wire the route
        │
        ▼
  Permission Broker
  ──────────────────────────────────────────
  evaluate(ActionRequest, policy) → allow | deny | requires_approval
  Hard deny: ~/.ssh/**, ~/.aws/**
  Requires approval: git push
        │
        ▼
  User Approval Prompt  [y/N]
        │
        ▼
  Capability Executor
  ──────────────────────────────────────────
  issueCapability(decision, 60s TTL)
  writeFile(capabilityId, path, content)
  Re-validates before every write
        │
        ▼
  Verification Chain
  ──────────────────────────────────────────
  tsc --noEmit → npm test → eslint
  All stages run even on failure
        │
        ▼
  Semantic Diff
  ──────────────────────────────────────────
  Grouped by category (API / Tests / Database / …)
  Blast-radius count from transitive dependents
```

---

## Commands

| Command | Description |
|---|---|
| `forge init` | Index the repo — extract all TS nodes/edges into the event log |
| `forge query <name>` | Show transitive dependents of a function or module |
| `forge change "<goal>"` | Plan, approve, and execute a change via LLM |

---

## Project Structure

```
model/
├── schema.ts              # SystemNode, SystemEdge, event union types
├── events.ts              # append-only SQLite event log (.forge/events.db)
├── graph.ts               # in-memory materialized view; rebuilt by replaying events
├── extractor.ts           # Extractor interface
├── typescript/
│   └── ts-extractor.ts    # ts-morph: functions, modules, imports, calls + confidence
└── incremental.ts         # localInvalidation, dependencyInvalidation (lazy + cached)

policy/
├── schema.ts              # ActionRequest, PolicyRule, PolicyDecision types
├── parser.ts              # load forge.policy.yaml
├── evaluator.ts           # normalize → match → decide
└── audit.ts               # append-only decision log (.forge/audit.db)

capability/
├── schema.ts              # Capability, CapabilityError
└── issuer.ts              # issue / revoke short-lived tokens (60s default TTL)

executor/
├── filesystem.ts          # THE ONLY FILE allowed to call Node's fs for agent writes
└── shell.ts               # whitelisted shell commands (npm test, tsc, eslint)

verify/
└── chain.ts               # tsc → test → lint; all stages run on failure

diff/
└── semantic.ts            # graph events → grouped human-readable diff + blast radius

llm/
└── planner.ts             # build system summary; call Claude API via tool_use

cli/
└── index.ts               # forge init | forge query | forge change
```

---

## Policy File (`forge.policy.yaml`)

```yaml
version: 1
default: deny

rules:
  - id: deny-ssh
    resource: filesystem
    operation: "*"
    target: "~/.ssh/**"
    effect: deny

  - id: deny-aws
    resource: filesystem
    operation: "*"
    target: "~/.aws/**"
    effect: deny

  - id: allow-reads
    resource: filesystem
    operation: read
    target: "**"
    effect: allow

  - id: allow-src-writes
    resource: filesystem
    operation: write
    target: "src/**"
    effect: allow

  - id: git-push-approval
    resource: git
    operation: push
    target: "*"
    effect: allow
    requires_approval: true
```

---

## Test Suite

```
npm test   # 40 tests — policy, executor, verification chain, semantic diff
```

| Suite | Tests | What it covers |
|---|---|---|
| Policy | 13 | deny-by-default, glob rules, hard-deny, requires_approval, normalize |
| Executor | 8 | valid write/read, path outside glob, expired token, unknown id, op mismatch |
| Verify | 5 | tsc pass/fail, all stages run on failure, test/lint skip conditions |
| Diff | 14 | category inference, NodeAdded/Removed grouping, blast-radius computation |

---

## MVP Build Order — Complete

- [x] **Step 1** — System Model (`model/`)
- [x] **Step 2** — Permission Broker (`policy/`)
- [x] **Step 3** — Capabilities + Executor (`capability/`, `executor/`)
- [x] **Step 4** — Verification Chain (`verify/chain.ts`)
- [x] **Step 5** — Semantic Diff (`diff/semantic.ts`)
- [x] **Step 6** — LLM Integration (`forge change "<goal>"`)

---

## License

MIT — Brian Tushae Thomas / Anthos Intelligence

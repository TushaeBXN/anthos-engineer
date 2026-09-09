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

## How Forge Differs from Claude Code and OpenAI Codex

Claude Code and Codex are excellent at generating code. Forge is built around a different question: **what happens after the LLM produces a plan?**

| | Claude Code / Codex | Forge |
|---|---|---|
| **Codebase understanding** | Reads files on demand | Maintains a persistent, event-sourced graph of every function, module, import, and call relationship — queryable for transitive dependencies and blast radius before any change is made |
| **Permission model** | Runs with the permissions of the current user | Deny-by-default policy broker — every action is normalized into one shape and evaluated against a YAML policy before it reaches the filesystem or shell |
| **Filesystem access** | LLM tools call `fs` / shell directly | Agents never get raw handles — only `executor/filesystem.ts` may write files, and only after re-validating a scoped, 60-second capability token on every operation |
| **Audit trail** | Session logs | Append-only SQLite audit log of every policy decision (allow / deny / requires_approval) with matched rule, agent id, and timestamp — immutable by design |
| **Verification** | Optional, triggered by the user | Mandatory after every change — `tsc --noEmit → test → lint` all run before a change is considered done, even if an earlier stage fails |
| **Blast-radius awareness** | None | Before and after every change, Forge knows exactly which nodes transitively depend on the affected functions — the semantic diff includes a blast-radius count |
| **LLM role** | Plans and executes | Plans only — a deterministic executor runs the plan, re-validates permissions at every step, and the LLM never directly touches the filesystem or shell |
| **Model lock-in** | Claude (Claude Code) / OpenAI (Codex) | Model-agnostic — drop in any provider via `FORGE_PROVIDER`; the permission, execution, and verification layers are independent of which LLM planned the change |
| **Policy ownership** | Controlled by the tool vendor | A `forge.policy.yaml` you own and version-control alongside your code |

### The core difference in one sentence

Claude Code and Codex trust the LLM to make safe decisions. Forge treats the LLM as an untrusted planner and enforces safety at the execution layer — the same way you would enforce it for any other untrusted process on your system.

---

## Quick Start

```bash
npm install

# Index the repo
npx tsx cli/index.ts init

# Ask Forge to make a change (uses whichever provider you configure — see below)
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

## Choosing Your LLM

Forge works with any model that supports function calling / tool use. Set two env vars and you're done — the permission broker, executor, verification chain, and semantic diff all run identically no matter which model planned the change.

| Provider | `FORGE_PROVIDER` | Key env var | `FORGE_BASE_URL` |
|---|---|---|---|
| **Anthropic** (default) | `anthropic` | `ANTHROPIC_API_KEY` | — |
| **OpenAI** | `openai` | `OPENAI_API_KEY` | — |
| **Ollama** (local) | `ollama` | — | auto-set to `http://localhost:11434/v1` |
| **Groq** | `groq` | `OPENAI_API_KEY` | `https://api.groq.com/openai/v1` |
| **Together AI** | `together` | `OPENAI_API_KEY` | `https://api.together.xyz/v1` |
| **LM Studio** | `lmstudio` | — | `http://localhost:1234/v1` |
| **Any OpenAI-compatible** | any string | `OPENAI_API_KEY` | your endpoint URL |

Override the model name with `FORGE_MODEL`:

```bash
# Anthropic
export FORGE_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
export FORGE_MODEL=claude-sonnet-5   # default: claude-opus-5

# OpenAI
export FORGE_PROVIDER=openai
export OPENAI_API_KEY=sk-...
export FORGE_MODEL=gpt-4o            # default: gpt-4o

# Ollama — no API key needed; pull the model first
export FORGE_PROVIDER=ollama
export FORGE_MODEL=llama3.1:70b
ollama pull llama3.1:70b

# Groq (fast hosted inference)
export FORGE_PROVIDER=groq
export OPENAI_API_KEY=gsk_...
export FORGE_BASE_URL=https://api.groq.com/openai/v1
export FORGE_MODEL=llama-3.3-70b-versatile

# LM Studio
export FORGE_PROVIDER=lmstudio
export FORGE_BASE_URL=http://localhost:1234/v1
export FORGE_MODEL=your-loaded-model
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

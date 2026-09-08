<div align="center">

# Forge by Anthos Intelligence

**Software engineering agent architecture — event-sourced system model, deny-by-default permission broker, capability executor, verification chain.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6.svg?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22+-339933.svg?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)

</div>

---

## Architecture

The LLM is replaceable. The durable platform is four things:

1. **System Model** — event-sourced graph of the codebase (functions, modules, endpoints, dependencies, call/import relationships)
2. **Permission Broker** — deny-by-default policy pipeline that normalizes every agent action into one shape before evaluating it
3. **Capability Executor** — the only component allowed to touch the real filesystem/shell/git; agents never get raw handles
4. **Verification Chain** — every change is checked (types, tests, lint) before being considered "done"

---

## Quick Start

```bash
npm install
npx tsx cli/index.ts init
```

Or install globally after building:

```bash
npm run build
npm link
forge init
```

---

## Commands

| Command | Description |
|---|---|
| `forge init` | Index the repo — extract all TS nodes/edges into the event log |
| `forge query <name>` | Show transitive dependents of a function or module |

---

## Build Order (MVP)

- [x] **Step 1** — System Model core (`model/schema.ts`, `events.ts`, `graph.ts`, `ts-extractor.ts`, `incremental.ts`)
- [ ] **Step 2** — Permission Broker (`policy/` — deny-by-default, glob rules, audit log)
- [ ] **Step 3** — Capabilities + Executor (`capability/`, `executor/`)
- [ ] **Step 4** — Verification Chain (`verify/chain.ts`)
- [ ] **Step 5** — Semantic Diff (`diff/semantic.ts`)
- [ ] **Step 6** — LLM integration (`forge change "<goal>"`)

---

## Project Structure

```
model/
├── schema.ts          # SystemNode, SystemEdge, event types
├── events.ts          # append-only SQLite event log
├── graph.ts           # materialized view rebuilt from events
├── extractor.ts       # extractor interface
├── typescript/
│   └── ts-extractor.ts  # ts-morph extraction for functions/modules/imports/calls
└── incremental.ts     # localInvalidation + dependencyInvalidation (lazy, cached)

policy/                # Step 2 (pending)
capability/            # Step 3 (pending)
executor/              # Step 3 (pending)
diff/                  # Step 5 (pending)
verify/                # Step 4 (pending)

cli/
└── index.ts           # forge init | forge query
```

---

## License

MIT — Brian Tushae Thomas / Anthos Intelligence

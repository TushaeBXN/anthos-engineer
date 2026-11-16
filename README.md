<div align="center">

# Forge by Anthos Intelligence

**A software engineering agent for your terminal. It reads, edits and runs your code one step at a time, checks every step against a policy you own, and works with open or closed models.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6.svg?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22+-339933.svg?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)

</div>

---

## What it is

Forge is one loop:

1. Send the conversation to the model.
2. If the model asks for a tool, check it against your policy, run it, and send the result back.
3. Repeat until the model answers without asking for a tool.

Everything else serves that loop.

```
agent/loop.ts      the loop
tools/             what the model can do: read, write, edit, glob, grep, bash, find_dependents, verify
policy/check.ts    the one permission check, run before every tool call
agent/usage.ts     the status line
```

---

## Quick start

Requires Node.js 22 or later and [Ollama](https://ollama.com) or an API key.

### Local model (free, no API key)

```bash
# 1. Pull the model once (~4.7 GB)
ollama pull hf.co/Melvin56/Qwen2.5-Coder-7B-Instruct-abliterated-Q4_K_M-GGUF:Q4_K_M

# 2. Clone and install
git clone https://github.com/TushaeBXN/anthos-engineer.git
cd anthos-engineer
npm install
npm install-scripts approve better-sqlite3 esbuild fsevents
npm rebuild better-sqlite3

# 3. Run
export FORGE_PROVIDER=ollama
export FORGE_MODEL=hf.co/Melvin56/Qwen2.5-Coder-7B-Instruct-abliterated-Q4_K_M-GGUF:Q4_K_M
npx tsx cli/index.ts
```

### Anthropic (hosted)

```bash
git clone https://github.com/TushaeBXN/anthos-engineer.git
cd anthos-engineer
npm install
npm install-scripts approve better-sqlite3 esbuild fsevents
npm rebuild better-sqlite3

export ANTHROPIC_API_KEY=sk-ant-...
npx tsx cli/index.ts
```

```
  Forge

  claude-opus-5-5 · closed · hosted    0 used, 1M left    $0.00 used

› add a health check endpoint
  Find src/**/*.ts
  Read src/api.ts
  Edit src/api.ts  +9 −0
  Verify

I added GET /health to src/api.ts. Type check and tests pass.

  claude-opus-5-5 · closed · hosted    14k used, 986k left    $0.07 used    +9 −0 in 1 file
```

| Command | What it does |
|---|---|
| `forge` | Start a conversation |
| `forge "<request>"` | Do one thing and exit |
| `forge init` | Index the project, so `find_dependents` works |
| `forge query <name>` | Show what depends on a function or module |

To install the `forge` command itself: `npm run build && npm link`.

---

## The status line

After every turn Forge prints one line that answers three questions.

| Part | Example | Meaning |
|---|---|---|
| What am I running? | `gemma · open · local` | The model; whether its weights are **open** or **closed**; whether it runs on this machine (**local**) or your code is sent to a server (**hosted**) |
| How much have I used, and how much is left? | `61k used, 939k left` | Tokens in the conversation, against the model's limit |
| | `$0.84 used, $4.16 left` | Estimated cost, against the budget you set |
| How much code changed? | `+124 −31 in 4 files` | Lines the agent added and removed |

Parts that are not known are left out rather than guessed. A local model shows `free`. A model with no listed price shows no cost.

| Setting | Effect |
|---|---|
| `FORGE_BUDGET_USD=5` | Shows dollars left, and stops the agent when the budget is spent |
| `FORGE_CONTEXT=8192` | The model's context size, when Forge does not know it (most local models) |
| `FORGE_PRICE_INPUT`, `FORGE_PRICE_OUTPUT` | Dollars per million tokens, when Forge does not know the price |

Two limits to know about. No provider reports your account balance through its API, so "left" is always measured against the model's context size or your own budget. And cost is an estimate from token counts and the price table in `agent/models.ts`, which needs updating when prices change.

---

## Choosing a model

| Provider | `FORGE_PROVIDER` | Weights | Runs | Needs |
|---|---|---|---|---|
| Anthropic (default) | `anthropic` | closed | hosted | `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | closed | hosted | `OPENAI_API_KEY` |
| Ollama | `ollama` | open | local | `ollama pull <model>` |
| LM Studio | `lmstudio` | open | local | `FORGE_MODEL` |
| Groq | `groq` | open | hosted | `OPENAI_API_KEY` |
| Together AI | `together` | open | hosted | `OPENAI_API_KEY`, `FORGE_MODEL` |
| Any OpenAI-compatible server | any name | unknown | hosted | `FORGE_BASE_URL`, `FORGE_MODEL` |

```bash
# A local open model
export FORGE_PROVIDER=ollama FORGE_MODEL=llama3.1 FORGE_CONTEXT=8192

# A different Claude model (default: claude-opus-5-5)
export FORGE_MODEL=claude-sonnet-5-5
```

The model must support tool calling. On the Claude models that support it, Forge turns on server-side fallback, so a request one model declines is retried on another inside the same call.

---

## Permissions

Before any tool runs, `policy/check.ts` gives one of three answers.

| Answer | When | What happens |
|---|---|---|
| **allow** | A rule in `forge.policy.yaml` permits it | It runs |
| **ask** | A rule requires approval, or no rule covers it | Forge asks you: yes, no, or always for this session |
| **deny** | A rule forbids it | It never runs, and you are not asked |

When nobody is at the keyboard (a script, the demo), every **ask** is refused.

```yaml
version: 1
default: deny

rules:
  - id: allow-src-writes
    resource: filesystem
    operation: write
    target: "src/**"
    effect: allow

  - id: allow-test-runner
    resource: shell
    operation: npm test        # also covers "npm test -- --watch"
    target: "*"
    effect: allow

  - id: deny-push-main
    resource: git
    operation: push
    target: "main"
    effect: deny
```

What the check does beyond matching rules:

- Paths are resolved first, symlinks included, so `src/../../x` or a link that leaves the project is not treated as inside `src/`.
- Each command in a chain is checked on its own, so `npm test && git push origin main` is still denied.
- Commands that use redirection or substitution always ask.
- Forge never writes to `forge.policy.yaml`, `.forge/` or `.git/`.
- Every rule match, and every answer you give, is recorded in `.forge/audit.db`.

The shell check reads the command text; it is not a sandbox. A command you approve can do anything your user account can.

---

## How Forge compares to Claude Code

Forge follows the same design as Claude Code: a model in a loop with file, search and shell tools, and a permission check before each call. Claude Code is far more complete (streaming, context compaction, subagents, hooks, sandboxing, MCP, IDE integrations).

What Forge adds:

| | Forge |
|---|---|
| **Any model** | Runs on open models through Ollama, LM Studio, Groq or Together, as well as Claude and OpenAI models |
| **Open or closed, local or hosted** | Always on screen, so you know whether your code is leaving your machine |
| **Dependency graph** | `forge init` builds an index of functions, modules and calls; the model can ask what depends on something before changing it |
| **Audit log** | Every policy decision is kept in a local SQLite file |
| **Small enough to read** | The loop is about 120 lines; each tool is one short function |

---

## Project structure

```
agent/
├── loop.ts              # the agent loop
├── start.ts             # builds an agent from the environment
├── types.ts             # the shapes shared by loop, tools and providers
├── models.ts            # what is known about each model: open/closed, context, price
├── usage.ts             # token, cost and line counts; the status line
├── ui.ts                # everything Forge prints
└── providers/
    ├── anthropic.ts     # Claude, through the Anthropic SDK
    └── openai.ts        # anything that speaks the OpenAI chat API

tools/
├── files.ts             # read, write, edit
├── search.ts            # glob, grep
├── bash.ts              # bash
├── project.ts           # find_dependents, verify
└── index.ts             # the list of tools

policy/
├── check.ts             # allow / ask / deny for one tool call
├── evaluator.ts         # match a request against the rules
├── parser.ts            # load forge.policy.yaml
└── audit.ts             # the audit log (.forge/audit.db)

model/                   # the dependency index behind find_dependents (.forge/events.db)
verify/chain.ts          # type check → tests → lint, behind the verify tool
executor/git.ts          # guarded git helpers: forge/* branches, no push to main
diff/semantic.ts         # groups index changes by area; used by the demo
demo/                    # a web page that runs the same loop in a sandbox
cli/index.ts             # the forge command
```

---

## Tests

```bash
npm test
```

| Suite | Covers |
|---|---|
| Loop | Tool calls and results, deny / ask / approve, cut-off replies, step and budget limits |
| Check | Path escapes, symlinks, chained commands, git rules, protected files |
| Tools | read, write, edit, glob, grep, bash, line counting |
| Usage | Model lookup, status line, cost, budget |
| Policy | Rule matching, deny-by-default, approval rules |
| Git | Branch names, protected branches, verification gate |
| Verify | Stages, skip conditions |
| Diff | Category grouping, blast radius |

---

## License

MIT — Brian Tushae Thomas / Anthos Intelligence

<div align="center">

# Forge by Anthos Intelligence

**A software engineering agent for your terminal. It reads, edits and runs your code one step at a time, checks every step against a policy you own, and works with any model — open, closed, local, or hosted.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6.svg?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22+-339933.svg?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)

</div>

---

## Quick start

Requires Node.js 22+ and either [Ollama](https://ollama.com) (free, local) or an API key.

### Local model — free, runs on your machine

```bash
# 1. Pull a model once (~9 GB — good quality, works well for coding)
ollama pull hf.co/bartowski/Qwen2.5-Coder-14B-Instruct-abliterated-GGUF:Q4_K_M
```

```bash
# 2. Clone and install
git clone https://github.com/TushaeBXN/anthos-engineer.git
cd anthos-engineer
npm install
npm install-scripts approve better-sqlite3 esbuild fsevents
npm rebuild better-sqlite3
```

```bash
# 3. Save your model settings once — survives terminal restarts
npx tsx cli/index.ts config set provider ollama
npx tsx cli/index.ts config set model hf.co/bartowski/Qwen2.5-Coder-14B-Instruct-abliterated-GGUF:Q4_K_M
```

```bash
# 4. Run from any terminal
cd anthos-engineer && npx tsx cli/index.ts
```

### Anthropic (Claude)

```bash
git clone https://github.com/TushaeBXN/anthos-engineer.git
cd anthos-engineer
npm install
npm install-scripts approve better-sqlite3 esbuild fsevents
npm rebuild better-sqlite3

npx tsx cli/index.ts config set provider anthropic
# Then set your key:
export ANTHROPIC_API_KEY=sk-ant-...
npx tsx cli/index.ts
```

### Install the `forge` command globally

```bash
npm run build && npm link
```

Then run `forge` from any directory.

---

## What it looks like

```
╭────────────────────────────────────────────────────────────────────────╮
│  ▶  FORGE  by Anthos Intelligence                                       │
│     qwen2.5-coder:14b · open · local  ·  0 used  ·  free               │
╰────────────────────────────────────────────────────────────────────────╯

> add a health check endpoint

⠹
⎿ Read src/api.ts
⎿ Edit src/api.ts  +9 −0
⎿ Bash  npx tsc --noEmit

I added GET /health to src/api.ts. Type check passes.

─────────────────────────────────────────────────────────────────────────
qwen2.5-coder:14b  ·  open · local  ·  14k used  ·  free  ·  +9 −0 in 1 file

>
```

---

## Commands

### Chat commands

| Command | What it does |
|---|---|
| `forge` | Start a conversation |
| `forge "<request>"` | Do one thing and exit |
| `forge init` | Index the project for `find_dependents` |
| `forge query <name>` | Show what depends on a function or module |

### Config commands

```bash
forge config set provider ollama          # save your provider
forge config set model <model-name>       # save your model
forge config get                          # show ~/.forgerc
```

Settings are saved to `~/.forgerc` and survive terminal restarts — no need to `export` env vars every time.

### Slash commands (inside a conversation)

Type any of these at the `>` prompt:

| Command | What it does |
|---|---|
| `/clear` | Reset the conversation and start fresh |
| `/compact` | Summarize and compress the conversation |
| `/exit` | Exit Forge |
| `/status` | Show current model, tokens, cost |
| `/cost` | Show this session's cost breakdown |
| `/model` | Show the active model |
| `/provider` | Show the active provider |
| `/budget [amount]` | Set or show spending budget |
| `/history` | List files changed this session (undo stack) |
| `/undo` | Restore the last file to its previous version |
| `/files` | List all files touched this session |
| `/diff` | Show git diff of changes |
| `/init` | Index the project |
| `/query <name>` | Show dependents for a function or module |
| `/tools` | List available tools |
| `/policy` | Show the current policy rules |
| `/audit` | Show recent policy decisions |
| `/copy` | Copy last response to clipboard |
| `/save [file]` | Save last response to a file |
| `/help` | Show all commands |

---

## Configuration

### Setting your model (recommended way)

```bash
# Save once — no env vars needed after this
forge config set provider ollama
forge config set model hf.co/bartowski/Qwen2.5-Coder-14B-Instruct-abliterated-GGUF:Q4_K_M

# Check what's saved
forge config get
```

### Environment variables (alternative, overrides ~/.forgerc)

| Variable | Effect |
|---|---|
| `FORGE_PROVIDER` | Provider: `anthropic`, `ollama`, `openai`, `lmstudio`, `groq`, `together` |
| `FORGE_MODEL` | Model name |
| `FORGE_BASE_URL` | Base URL for OpenAI-compatible servers |
| `FORGE_BUDGET_USD` | Stop the agent when this many dollars are spent |
| `FORGE_CONTEXT` | Context window size (tokens), for models Forge doesn't know |
| `FORGE_PRICE_INPUT` | Input price per million tokens |
| `FORGE_PRICE_OUTPUT` | Output price per million tokens |

---

## Choosing a model

| Provider | `provider` value | Weights | Runs | Needs |
|---|---|---|---|---|
| Anthropic (Claude) | `anthropic` | closed | hosted | `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | closed | hosted | `OPENAI_API_KEY` |
| Ollama | `ollama` | open | local | `ollama pull <model>` |
| LM Studio | `lmstudio` | open | local | model running in LM Studio |
| Groq | `groq` | open | hosted | `OPENAI_API_KEY` |
| Together AI | `together` | open | hosted | `OPENAI_API_KEY`, `FORGE_MODEL` |
| Any OpenAI-compatible | any name | unknown | hosted | `FORGE_BASE_URL`, `FORGE_MODEL` |

**Recommended local models** (via Ollama):

| Model | Size | Good for |
|---|---|---|
| `hf.co/bartowski/Qwen2.5-Coder-14B-Instruct-abliterated-GGUF:Q4_K_M` | ~9 GB | Best local coding quality |
| `llama3.1` | ~4.7 GB | General tasks, faster |

The model must support tool calling.

---

## How it works

Forge is one loop:

1. Send the conversation to the model.
2. If the model asks for a tool, check it against your policy, run it, send the result back.
3. Repeat until the model answers without asking for a tool.

**Parallel tool calls** — when the model asks for multiple tools at once, reads run in parallel; writes serialize to prevent conflicts.

**File undo** — every write and edit is snapshotted before it happens. Use `/undo` to restore, `/history` to see what's changed.

**Status line** — after every turn, Forge prints: model name · open/closed · local/hosted · tokens used · cost · lines changed.

---

## Permissions

Before any tool runs, `policy/check.ts` gives one of three answers.

| Answer | When | What happens |
|---|---|---|
| **allow** | A rule in `forge.policy.yaml` permits it | It runs |
| **ask** | A rule requires approval, or no rule covers it | Forge asks: yes, no, or always for this session |
| **deny** | A rule forbids it | It never runs, and you are not asked |

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
    operation: npm test
    target: "*"
    effect: allow

  - id: deny-push-main
    resource: git
    operation: push
    target: "main"
    effect: deny
```

Every policy decision is logged to `.forge/audit.db`. Use `/audit` to review recent decisions.

---

## Project structure

```
agent/
├── loop.ts              # the agent loop (send → tools → repeat)
├── start.ts             # builds an agent (model, tools, policy, undo)
├── types.ts             # shared shapes: ToolCall, ToolResult, Reply, Session, Tool
├── models.ts            # provider + model tables; reads ~/.forgerc
├── usage.ts             # token, cost and line counts; status line
├── ui.ts                # terminal output: panel header, spinner, ⎿ hooks, prompt
├── undo.ts              # file snapshot stack for /undo
└── providers/
    ├── anthropic.ts     # Claude via Anthropic SDK
    └── openai.ts        # OpenAI-compatible APIs (Ollama, LM Studio, Groq, Together)

tools/
├── files.ts             # read, write, edit (write/edit capture undo snapshots)
├── search.ts            # glob, grep
├── bash.ts              # bash
├── project.ts           # find_dependents, verify
└── index.ts             # the tool list

policy/
├── check.ts             # allow / ask / deny for one tool call
├── evaluator.ts         # match a request against the rules
├── parser.ts            # load forge.policy.yaml
└── audit.ts             # audit log (.forge/audit.db)

cli/
├── index.ts             # the forge command + forge config set/get
└── commands.ts          # 20 slash commands

model/                   # dependency index (.forge/events.db)
verify/chain.ts          # type check → tests → lint
executor/git.ts          # guarded git helpers
diff/semantic.ts         # semantic diff grouping
```

---

## Tests

```bash
npm test
```

---

## License

MIT — Brian Tushae Thomas / Anthos Intelligence

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
# 1. Pull the model once (~7.6 GB)
ollama pull hf.co/mradermacher/DeepSeek-V4-Pro-Qwen3.5-9B-UNCENSORED-heretic-i1-GGUF:i1-Q6_K
```

```bash
# 2. Create it with a larger context window (required — default 4k is too small)
echo 'FROM hf.co/mradermacher/DeepSeek-V4-Pro-Qwen3.5-9B-UNCENSORED-heretic-i1-GGUF:i1-Q6_K
PARAMETER num_ctx 32768' > /tmp/Modelfile

ollama create forge-deepseek -f /tmp/Modelfile
```

```bash
# 3. Clone and install
git clone https://github.com/TushaeBXN/anthos-engineer.git
cd anthos-engineer
npm install
npm install-scripts approve better-sqlite3 esbuild fsevents
npm rebuild better-sqlite3
```

```bash
# 4. Save your model settings once — survives terminal restarts
npx tsx cli/index.ts config set provider ollama
npx tsx cli/index.ts config set model forge-deepseek
```

```bash
# 5. Run from any terminal
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

## Why this exists

Coding agents are powerful, but most of them make a trade you don't control: your code gets sent to a server, a closed model you can't inspect makes decisions about your files, and when it runs a shell command it has the same access to your machine that you do — with nothing between the model's output and your filesystem except the agent's own judgment.

The problem I wanted to solve was: **how do you give an AI agent real coding capability without giving it unchecked access to everything?**

The answer Forge is built around is a permission layer that runs before every single tool call — not just dangerous ones. Every read, every write, every shell command goes through `policy/check.ts` first. You write rules in a YAML file you own. If no rule covers something, Forge asks you. If you're not at the keyboard, it refuses. Every decision is logged.

That's a lot of safety machinery for a coding agent. It's intentional.

**The cost angle matters too.** Most hosted coding agents charge per token. Run Forge on a local model and the marginal cost of an hour of agentic work is zero — no API bill, no usage cap, no "you've hit your limit for today." For heavy use — running an agent across a large codebase, iterating on a long-running task, or just leaving it running overnight — that's not a minor concern. The local-first path isn't only about trust or privacy; it's about economics.

**Why it matters:** A model that hallucinates a shell command shouldn't be able to run it silently. A write to a path outside your project shouldn't be able to sneak through via a symlink. A chained command like `npm test && git push origin main` shouldn't bypass a push rule just because the first part is allowed. Forge checks all of these.

**What I'd do to make it better:**

The biggest remaining gap is that the shell check reads command text — it is not a sandbox. A command you approve can do anything your user account can. The right fix is to run each session in an isolated container, the way tools like [Cloudroom](https://github.com/davidondrej/cloudroom) do: the model works inside a VM, sees a copy of your project, and changes only come back to your machine after you review a diff. That's the v2 target.

Beyond that: streaming output so you see the model think in real time, context compaction so long sessions don't hit the token limit, and tighter tool-calling support for more local models.

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

**Recommended local model** (via Ollama):

| Model | Size | Notes |
|---|---|---|
| `forge-deepseek` (see quickstart) | ~7.6 GB | DeepSeek-V4-Pro-Qwen3.5-9B, needs 32k context wrapper |
| `llama3.1` | ~4.7 GB | Smaller, native tool calling, general tasks |

> **Important:** Not all GGUF models support Ollama's tool-calling protocol. If Forge prints raw JSON instead of executing tools, the model doesn't support tool calling. Use `forge-deepseek` or `llama3.1` to avoid this.
>
> Always create local models with `num_ctx 32768` via a Modelfile — the default 4096 token context is too small for real coding tasks.

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

## What works, what doesn't

**Working well:**
- Proper agent loop — model → tools → model → repeat, not one-shot
- Tool calling actually executes (reads files, writes, runs bash)
- Policy check before every tool — allow / ask / deny
- Parallel reads, sequential writes
- File undo (`/undo`) — every write snapshotted before it happens
- Tool telemetry — logs every call to `.forge/telemetry.ndjson`; `/telemetry` shows session stats
- Circuit breaker — blocks a tool after 3 consecutive failures so the model can't thrash
- 20 slash commands
- Persistent config via `~/.forgerc` — no env vars every session
- Claude Code-style terminal UI (panel header, braille spinner, `⎿` hooks)
- Works with local models for free, no API key needed

**Current limitations vs Claude Code:**
- Local models are capable but less reliable — may try several wrong commands before getting it right
- No streaming output — you wait for the full response before seeing anything
- No context compaction — long sessions will eventually hit the model's context limit
- No MCP, no IDE integration, no subagents
- The 32k context wrapper (`num_ctx` Modelfile) is a manual workaround, not built-in
- Policy rules are the only thing protecting your filesystem — no sandbox isolation yet (planned for v2)

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

## Telemetry and circuit breaker

Every tool call is recorded to `.forge/telemetry.ndjson` with the tool name, success or failure, duration, and any error message. Use `/telemetry` inside a conversation to see a live summary:

```
  Tool telemetry — 12 calls, 83% success
  ────────────────────────────────────────────────────────────
  read                    8 calls   100% ok    42ms avg
  bash                    3 calls    67% ok   180ms avg
  write                   1 calls   100% ok    12ms avg
```

The circuit breaker watches each tool across the session. After **3 consecutive failures** of the same tool, it trips — the tool is blocked for the rest of the session and the model gets a clear message to try a different approach. This prevents the model from retrying the same broken call in a loop.

The breaker resets on the first success, and trips per tool name (not per exact arguments), so one bad file path doesn't block all reads.

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
├── telemetry.ts         # per-tool call logging and circuit breaker
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

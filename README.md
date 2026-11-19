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

Beyond that: tighter tool-calling support for more local models.

---

## What it looks like

A real session on the local `forge-deepseek` model, using a sub-agent:

```
╭────────────────────────────────────────────────────────────────────────╮
│ ▶  FORGE  by Anthos Intelligence                                       │
│ forge-deepseek · open · local  ·  0 used  ·  free                      │
╰────────────────────────────────────────────────────────────────────────╯

> find which file defines the circuit breaker and how many failures trip it

⎿ explore · Search consecutive.*fail|fail.*consecutive
⎿ explore · Search failure.*threshold|threshold.*failure
⎿ explore · Search circuit.*breaker|breaker.*circuit
⎿ explore · Read agent/telemetry.ts
⎿ Task  [explore] Find circuit breaker file

The circuit breaker is defined in `agent/telemetry.ts` and trips after 3 consecutive failures.

────────────────────────────────────────────────────────────
forge-deepseek · open · local  ·  4.2k used  ·  free
```

Every `⎿` line is a tool call that passed the policy check. Lines starting with a name (`explore ·`) come from a sub-agent.

---

## Commands

### Chat commands

| Command | What it does |
|---|---|
| `forge` | Start a conversation |
| `forge "<request>"` | Do one thing and exit |
| `forge init` | Build the [project index](#project-index) for `forge query` and `find_dependents` |
| `forge query <name>` | Show what depends on a function or module |
| `forge providers` | List providers and whether each key is set |
| `forge serve [--port N]` | Run Forge as a gRPC service for editors, UIs and scripts |

### Config commands

```bash
forge config set provider ollama          # save your provider
forge config set model <model-name>       # save your model
forge config get                          # show ~/.forgerc
forge providers                           # every provider, and whether its key is set
```

Settings are saved to `~/.forgerc` and survive terminal restarts — no need to `export` env vars every time.

### Slash commands (inside a conversation)

Type any of these at the `>` prompt:

| Command | What it does |
|---|---|
| `/clear` | Reset the conversation and start fresh |
| `/compact` | Summarize the conversation now to free context (Forge also does this on its own) |
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
| `/agents` | List the sub-agent types |
| `/mcp` | Show MCP servers and their tools |
| `/repomap [tokens]` | Show the project map the model sees |
| `/telemetry` | Show tool call stats for this session |
| `/help` | Show all commands |

---

## Configuration

### Setting your model (recommended way)

```bash
# Save once — no env vars needed after this
forge config set provider ollama
forge config set model forge-deepseek

# Check what's saved
forge config get
```

### Environment variables (alternative, overrides ~/.forgerc)

| Variable | Effect |
|---|---|
| `FORGE_PROVIDER` | Provider name — run `forge providers` for the list |
| `FORGE_MODEL` | Model name |
| `FORGE_BASE_URL` | Base URL for OpenAI-compatible servers |
| `FORGE_API_KEY` | Key for an OpenAI-compatible server Forge doesn't list |
| `FORGE_BUDGET_USD` | Stop the agent when this many dollars are spent |
| `FORGE_CONTEXT` | Context window size (tokens), for models Forge doesn't know. Ollama's is detected on its own |
| `FORGE_COMPACT_AT` | Summarize the conversation when it passes this share of the window (default `0.7`; `0` turns it off). Also `forge config set compactAt <n>` |
| `FORGE_PRICE_INPUT` | Input price per million tokens |
| `FORGE_PRICE_OUTPUT` | Output price per million tokens |
| `FORGE_REPO_MAP` | Token budget for the repo map (default 1024; `0` turns it off). Also `forge config set repoMap <n>` |

---

## Choosing a model

Run `forge providers` to see this list with which keys you already have set.

| Provider | `provider` value | Weights | Runs | Key |
|---|---|---|---|---|
| Anthropic (Claude) | `anthropic` | closed | hosted | `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | closed | hosted | `OPENAI_API_KEY` |
| Google Gemini | `gemini` | closed | hosted | `GEMINI_API_KEY` |
| xAI (Grok) | `xai` | closed | hosted | `XAI_API_KEY` |
| Mistral | `mistral` | unknown | hosted | `MISTRAL_API_KEY` |
| DeepSeek | `deepseek` | open | hosted | `DEEPSEEK_API_KEY` |
| OpenRouter | `openrouter` | unknown | hosted | `OPENROUTER_API_KEY` |
| Groq | `groq` | open | hosted | `GROQ_API_KEY` |
| Together AI | `together` | open | hosted | `TOGETHER_API_KEY` |
| Fireworks AI | `fireworks` | open | hosted | `FIREWORKS_API_KEY` |
| Cerebras | `cerebras` | open | hosted | `CEREBRAS_API_KEY` |
| Ollama | `ollama` | open | local | none |
| LM Studio | `lmstudio` | open | local | none |
| Any OpenAI-compatible server | any name | unknown | hosted | `FORGE_API_KEY` (optional) + `baseUrl` |

Switching is two commands, and the key goes in your shell, never in `~/.forgerc` (that file is plain text):

```bash
export OPENROUTER_API_KEY=sk-or-...
forge config set provider openrouter
forge config set model <model id from openrouter.ai/models>
```

Each provider reads only its own key, so your OpenAI key is never sent to OpenRouter, Groq, or anyone else. If the key is missing, Forge stops before sending anything and tells you which variable to set. Most providers have no default model: pick one from the provider's model list.

"Weights" is shown as `unknown` where one API serves both open and closed models (Mistral, OpenRouter).

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

**Streaming** — the model's reply appears as it is written, in the terminal and over gRPC, with every provider. Tool inputs are checked against each tool's schema before they run (required fields, types, allowed values), since streamed inputs aren't validated by the provider.

**Automatic compaction** — when the conversation is about to outgrow the model's context window, Forge has the model summarize it and carries on from the summary, even in the middle of a task. See [Context compaction](#context-compaction).

**Status line** — after every turn, Forge prints: model name · open/closed · local/hosted · tokens used · cost · lines changed.

**What the model starts with** — Forge's own rules, your project's instructions (the first of `FORGE.md`, `AGENTS.md` or `CLAUDE.md`), the [repo map](#repo-map), and, if [Engram](#engram-memory-integration) is running, up to 3 relevant memories before each message.

**Tools** — `read`, `write`, `edit`, `glob`, `grep`, `bash`, `find_dependents`, `verify`, `web_search`, `web_fetch`, `recall`, `remember`, `task` (sub-agents), and any tools from your [MCP servers](#mcp-servers). Every one goes through the policy check before it runs.

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
- Engram integration — long-term memory across sessions; auto-recall before every turn (optional, local)
- Web search and fetch — `web_search` (DuckDuckGo, no API key) and `web_fetch` (pages as readable markdown); network access goes through the policy like everything else
- Repo map — a ranked outline of the project in the model's instructions, so it knows where things live before reading anything
- Project index — `forge init` records which functions and methods call which, across files, so `find_dependents` can show what a change could break
- VS Code extension — Forge in the terminal panel, plus "Ask About Selection" from the editor
- Sub-agents — the `task` tool hands a job to a child agent with its own context; same policy, shared budget
- gRPC server — `forge serve` lets editors, web UIs and scripts drive Forge, with approvals sent to the client
- MCP — tools from any MCP server, checked by the policy like Forge's own; a project's servers need your OK before they start
- 24 slash commands
- Persistent config via `~/.forgerc` — no env vars every session
- Automatic context compaction — long tasks are summarized before they outgrow the model's context window, even mid-task
- Claude Code-style terminal UI (panel header, braille spinner, `⎿` hooks), with replies streamed as they are written
- 13 providers: Anthropic, OpenAI, Gemini, xAI, Mistral, DeepSeek, OpenRouter, Groq, Together, Fireworks, Cerebras, Ollama, LM Studio — plus any OpenAI-compatible server
- Works with local models for free, no API key needed

**Current limitations:**
- Local models are capable but less reliable — they may try several wrong commands before getting it right
- When a tool is blocked, a small local model may answer from memory as if it had run. Forge still prints the `⎿ … not allowed` line and logs the block, so what actually happened is always visible
- Two `general` sub-agents running in parallel can edit the same file; use parallel tasks for separate files or read-only work
- The 32k context wrapper (`num_ctx` Modelfile) is a manual step, not built in
- Policy rules are the only thing protecting your filesystem — no sandbox isolation yet (planned for v2)

---

## How Forge compares

Forge started as a one-shot planner and was rebuilt to work like Claude Code: a model in a loop with tools and a permission check before every call. [OpenClaude](https://github.com/Twigpine/openclaude), a community fork of Claude Code's codebase with many providers, was the checklist for the next round of features.

| | Claude Code | OpenClaude | Forge |
|---|---|---|---|
| Agent loop with file, search and shell tools | Yes | Yes | Yes |
| Permission check before every tool call | Yes | Yes | Yes — user-owned YAML, deny-by-default, every decision in a local audit log |
| Network access as its own policy resource | — | — | Yes — per host, asks by default |
| Open and local models | No | Yes | Yes |
| Providers | Anthropic | 30+ | 13, plus any OpenAI-compatible server |
| Open/closed and local/hosted shown on screen | — | — | Yes |
| Web search and fetch | Yes | Yes | Yes |
| Repo map | — | Yes | Yes |
| Sub-agents | Yes | Yes | Yes — same policy, shared budget |
| VS Code | Yes | Yes | Yes — terminal panel + ask about selection |
| Headless server | — | gRPC | gRPC |
| Long-term memory | — | — | Yes, with [Engram](https://github.com/TushaeBXN/engram) |
| File undo | Yes | — | Yes |
| Telemetry and circuit breaker | — | — | Yes |
| Streaming output | Yes | Yes | Yes — terminal and gRPC |
| Automatic context compaction | Yes | — | Yes — mid-task, with Ollama's window detected |
| MCP | Yes | Yes | Yes — every MCP tool call goes through the policy; a project's servers need your OK |
| Sandbox | Yes | — | No (v2) |

A dash means I haven't confirmed it either way. Claude Code and OpenClaude are far larger projects; Forge's focus is the part they share least: an agent you can govern and audit, running on whatever model you choose.

### What has been tested, and how

| Feature | Tests | Run for real |
|---|---|---|
| Agent loop, policy, audit, undo | Yes | Yes, on `forge-deepseek` |
| Web search and fetch | Yes, including a local server for redirects | Yes — live search, live fetch, and a deny rule blocking a host |
| Repo map | Yes | Yes — answered a code question from the map alone |
| Project index | Yes — imports of every kind, methods, constructors, interfaces, name clashes | Yes — indexed Forge itself: 30 methods, 236 call links, none pointing at nothing |
| Sub-agents | Yes, including two in parallel | Yes — `explore` found the right file and line |
| gRPC server | Yes, over a real connection | Yes — `forge serve` + the example client |
| 13 providers | Key handling and addresses | Each hosted address answered; **no real conversation yet** (needs each provider's key) |
| VS Code extension | Yes, against a stand-in VS Code API; packages with `vsce` | **Not yet run in VS Code** |
| Context compaction | Yes — trigger, carry-over, both providers' summary requests, fallback | Yes on `forge-deepseek`: compacted once mid-task (7.8k → 1.7k) and still answered correctly |
| Streaming | Yes — local servers speaking the OpenAI and Anthropic stream formats | Yes on `forge-deepseek`: a reply arrived in 77 pieces over 6 s, and a turn with a tool call streamed too. **Anthropic not yet run live** (no key here) |
| MCP | Yes, against a real MCP server (`tests/fixtures/mcp-server.ts`) | Yes — `forge-deepseek` used a server's tool; a tool with no rule was refused |

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

Anything that leaves your machine is the `network` resource. `web_search` is operation `search` on target `duckduckgo.com`; `web_fetch` is operation `fetch` on the host it contacts (for example `docs.python.org`). With no rule Forge asks first. `web_fetch` follows redirects only on the same host — a redirect to another host is handed back to the model, so that host gets its own check. To allow searches without asking, or to block all network access:

```yaml
  - id: allow-web-search
    resource: network
    operation: search
    target: "*"
    effect: allow

  - id: no-network
    resource: network
    operation: "*"
    target: "*"
    effect: deny
```

Every policy decision is logged to `.forge/audit.db`. Use `/audit` to review recent decisions.

---

## VS Code

The extension runs Forge in VS Code's terminal panel, so you get the same agent, approvals, policy and status line as in a shell, and it adds ways to point Forge at the code you're looking at.

| Command | What it does |
|---|---|
| **Forge: Start** (status bar `Forge` button, or `Cmd+Alt+F`) | Opens Forge in the workspace folder, or shows it if it's already open |
| **Forge: Ask About Selection** (`Cmd+Alt+F` with a selection, or right-click) | Asks you a question, then sends Forge "Look at `src/a.ts` lines 10-20: your question" |
| **Forge: Ask About This File** (right-click) | Same, for the whole file |
| **Forge: Show Repo Map** | Runs `/repomap` |
| **Forge: Undo Last Change** | Runs `/undo` |

On Windows and Linux, `Cmd+Alt+F` is `Ctrl+Alt+F`. Forge reads files from disk, so save the file before asking about it.

**Install:**

```bash
npm run build && npm link          # puts the forge command on your PATH
cd vscode-extension
npx @vscode/vsce package
code --install-extension forge-vscode-0.1.0.vsix
```

If you'd rather not link the command, set **Forge: Command** in VS Code's settings to the full command, for example `npx tsx /path/to/anthos-engineer/cli/index.ts`.

---

## MCP servers

Forge can use tools from any [MCP](https://modelcontextprotocol.io) server, such as GitHub, databases or browsers. List servers in the same format Claude Code uses:

| File | Whose | Trusted |
|---|---|---|
| `~/.forge/mcp.json` | Yours | Yes |
| `.forge/mcp.json` in a project | The project's | Only after you say yes |

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
    }
  }
}
```

`"command"` starts a local server; `"url"` connects to a remote one. `${VAR}` is read from your environment, so tokens stay out of the file. A local server gets only the environment variables you list, not your whole environment.

Each server's tools appear as `mcp__<server>__<tool>`. `/mcp` shows every server and how many tools it gave; a server that fails to start is reported and the rest still work.

**Policy:** every MCP tool call goes through the same check as everything else, as resource `mcp`, operation = the tool's name, target = the server's name. With no rule, Forge asks.

```yaml
  - id: github-reads
    resource: mcp
    operation: get_issue
    target: github
    effect: allow

  - id: no-new-issues
    resource: mcp
    operation: create_issue
    target: github
    effect: deny

  - id: block-a-server
    resource: mcp
    operation: "*"
    target: some-server
    effect: deny
```

`operation` is an exact tool name or `*`; `/mcp` lists each server's tool names.

Tools the server marks read-only run in parallel; all others run one at a time.

**A project's servers need your OK.** A `.forge/mcp.json` in a project starts commands on your machine, so a repository you clone can't run code just because you opened Forge in it. The first time, Forge shows the exact command and asks; "always" remembers it in `~/.forge/trusted-mcp.json` until that server's config changes. With no one at the keyboard (one-shot scripts, `forge serve`), untrusted project servers are skipped. A project can't replace one of your own servers by using the same name. Forge never writes to `.forge/`, so the model can't add servers either.

MCP tools return text written by whoever runs the server. Treat it like any web page: it can contain instructions aimed at the model, which is one more reason the policy, not the model, decides what runs.

---

## gRPC server

`forge serve` runs Forge without a terminal, for editors, web UIs and scripts. Each `Session` call is one conversation over a two-way stream ([grpc/forge.proto](grpc/forge.proto)):

| Client sends | Server streams back |
|---|---|
| `Start { cwd }` once | `Ready { model, status }` |
| `UserMessage { text }` for each turn | `TextDelta` (the reply as it is written), `Text` (the whole reply), `Activity` (each tool call), `Note`, `Working` |
| `Approval { id, approved, always }` | `ApprovalRequest { id, label, reason }` when the policy says "ask" |
| | `TurnDone { text, status }` at the end of each turn, or `Error { message }` |

`TextDelta` events carry the reply piece by piece for live display; the complete reply always follows as one `Text`, so a client that doesn't want streaming can ignore `TextDelta`. It's the same agent as the terminal: policy, audit log, sub-agents, budget and memory all work unchanged. When the policy says "ask", the client receives an `ApprovalRequest` and the turn waits for its answer. If the client disconnects, every open question is answered no.

```bash
forge serve --port 50051
npx tsx grpc/client-example.ts "what does agent/undo.ts do?" --port 50051
```

**Security:** the server listens on `127.0.0.1` only. To listen on another address you must set `FORGE_GRPC_TOKEN`, and clients then send `authorization: Bearer <token>`. The connection is not encrypted, so to reach Forge from another machine, use an SSH tunnel rather than exposing the port.

---

## Sub-agents

The `task` tool lets Forge hand a self-contained job to a sub-agent: "find every place we parse dates", "review this diff", "work out why this test fails". The sub-agent works with its own conversation and sends back only its final report, so the main conversation stays short. Several tasks in one reply run at the same time.

What stays the same inside a sub-agent:

- **The same policy.** Every tool call a sub-agent makes goes through `check()`, and is recorded in the audit log under its own name (for example `forge/explore`).
- **Approvals still come to you**, one question at a time even when sub-agents run in parallel.
- **One budget.** Sub-agents' tokens and cost count toward the status line and `FORGE_BUDGET_USD`.
- **No nesting.** A sub-agent cannot start sub-agents of its own.

Built-in types:

| Agent | Tools | Use it for |
|---|---|---|
| `general` | all | Any multi-step job |
| `explore` | read, glob, grep, find_dependents, web_search, web_fetch, recall | Finding code and answering questions — it cannot change files or run commands |

Add your own as markdown files in `.forge/agents/` (Forge never writes to `.forge/`, so the model can't create or change these itself):

```markdown
---
name: reviewer
description: Reviews a change for bugs and missing tests
tools: read, grep, glob, bash
maxSteps: 15
---
Read the changed files and their callers. Report bugs with file and line,
most serious first. Do not edit anything.
```

`tools` limits what the agent can use (leave it out for all tools), `maxSteps` caps how long it works (default 30), and `model` picks a different model on the same provider. `/agents` lists every type.

---

## Context compaction

Every model can only hold so much text at once: its context window. On a long task, file contents and command output fill it, and the next request would fail. Forge watches for this and, before it happens, has the model write a summary of the conversation so far, then replaces the conversation with that summary and carries on.

```
⎿ Read agent/undo.ts
⎿ Read agent/telemetry.ts
⎿ Read agent/compaction.ts
⎿ Read policy/check.ts
  Context 7.8k of 32.8k: summarizing the conversation to make room.
  Summarized: 7.8k → about 1.7k.
```

That's a real run on `forge-deepseek` with the threshold lowered for the test: after the summary it re-read one file it still needed, then answered the question about the first two files correctly.

- **When:** before each request, if the conversation plus what's about to be sent would pass 70% of the window. The rest is left for the summary itself. Change it with `forge config set compactAt 0.8`; `0` turns it off.
- **Mid-task:** it can happen between tool calls. The results of the tool calls just made go into the summary request, so nothing from the latest step is lost, and the model is then told to continue without redoing finished work.
- **What replaces the conversation:** the model's summary (what's been done, decisions, errors, the next step), plus your latest request and the latest tool results, word for word. Forge adds those two itself rather than trusting the summary, because small models write thin summaries: in testing, a 9B model's 75-token summary dropped the question entirely, and the model wandered off task.
- **No compacting over and over:** the system prompt and tool definitions take up space a summary can't remove. After a compaction, Forge waits until the conversation has grown by 15% of the window before compacting again.
- **If summarizing fails** (for example the summary request itself is too large), the conversation is cleared anyway and your latest request is kept, rather than failing on the next request.
- **`/compact`** does the same thing on demand.
- **The cost** of the summary request counts toward the status line and your budget.

**Knowing the window:** for hosted models Forge knows the size. For Ollama it asks Ollama at startup for the window the model actually runs with: the Modelfile's `num_ctx`, else `OLLAMA_CONTEXT_LENGTH`, else Ollama's default of 4096. That is often far smaller than the model's advertised maximum. For other local servers, set it with `forge config set context 32768`. With no known window, Forge can't tell when to compact, and doesn't.

---

## Project index

`forge init` builds an index of your TypeScript code: every file, every top-level function, every class method (named `Class.method`), which files import which, and which functions and methods call which, including calls into other files. `forge query` and the model's `find_dependents` tool read it to answer "what could break if I change this?"

```
$ forge init
  Indexed 61 files: 306 functions and modules, 745 links.

$ forge query parseAgentFile
  18 things depend on parseAgentFile:
    module subagents.ts (agent/subagents.ts)
    function loadAgentTypes (agent/subagents.ts)
    function createAgent (agent/start.ts)
    function session (grpc/server.ts)
    function once (cli/index.ts)
    ...
```

The list is everything that depends on it directly or indirectly: `loadAgentTypes` calls `parseAgentFile`, `createAgent` calls `loadAgentTypes`, and so on out to the places that start Forge. A name that matches several things gets a list to choose from. Methods can be asked for by their short name: `forge query isTripped` finds `Telemetry.isTripped`.

How calls are linked:

- Every call is resolved by the TypeScript type checker, so it links to what actually runs: a function imported from another file (including renamed imports `import { a as b }` and namespace imports `mod.a()`), a method called on an object (`store.save()`, `this.flush()`, `Store.create()`), or a constructor (`new Store()`).
- A call is never linked by name alone when the type checker knows better: `xs.join(",")` on an array is not linked to some unrelated function of yours called `join`.
- Only calls into your own code are linked. Calls into libraries (`path.join`, `String`, a package's functions) are left out, since they aren't part of what you're changing.

**Limits:**

- **TypeScript only.** The [repo map](#repo-map) covers other languages, but only as an outline.
- **What's indexed:** top-level functions (`function f` or `const f = () => …`) and the methods, constructors and arrow-function properties of top-level classes. Functions nested inside other functions, getters and setters are not.
- **Calls through an interface aren't linked.** If a function takes a `Saver` interface and calls `s.save()`, the index can't know which class will run, so it records nothing rather than guess.
- **Run `forge init` (or `/init` inside a conversation) again after big changes.** The index reflects the code as it was at the last index; Forge's own edits don't update it.

**The index vs the repo map:** the repo map is built automatically for every language and gives the model a quick outline at the start. The index needs `forge init`, covers TypeScript, and answers a precise question: what depends on this function?

---

## Repo map

When Forge starts, it builds a short map of the project and puts it in the model's instructions. The model knows which files matter and what they define before it reads anything, which saves tool calls and context — especially on local models.

How it ranks files:

1. Find the names each source file defines (functions, classes, types) — TypeScript/JavaScript, Python, Go, Rust, Java/Kotlin/C#, Ruby.
2. A file that uses a name defined in another file points at that file.
3. PageRank over those links: files that many others depend on come first. Tests go last.
4. Files and their names are listed, best first, until the token budget is spent.

No index or `forge init` needed, and it takes about 30 ms on a project Forge's size. Use `/repomap` to see exactly what the model sees. The default budget is 1024 tokens; change it with `forge config set repoMap 2048`, or turn it off with `forge config set repoMap 0`.

```
agent/types.ts: ToolCall, ToolResult, Usage, Reply, Session, ToolSpec, ToolOutput, Tool
policy/schema.ts: Resource, Effect, PolicyDecision, ActionRequest, PolicyRule, ForgePolicy
policy/check.ts: Access, Verdict, humanDecision, Who, check, policyPath, ...
...
```

---

## Engram memory integration

Forge integrates with [Engram](https://github.com/TushaeBXN/engram) — a local, private long-term memory system — to give the agent memory across sessions.

**Setup:** Install Engram, then start the server before running Forge:

```bash
pip install engram-chateau
engram serve          # starts at http://127.0.0.1:7742
```

Then run Forge normally. No config needed — it detects Engram automatically.

**What it does:**

- **Auto-recall** — before every turn, Forge silently queries Engram for up to 3 memories relevant to your message and prepends them as context. The model sees what it did in past sessions without you having to ask.
- **`recall` tool** — the model can search memory directly: "what did we decide about the database schema?" pulls matching memories from past sessions.
- **`remember` tool** — the model can save anything worth keeping: "remember that this project uses row-level security" stores it for future sessions.

If Engram is not running, Forge works exactly as before — the integration is fully passive and fails silently.

Engram stores everything locally (`~/.engram/`). No cloud, no API key, no data leaves your machine.

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
├── repomap.ts           # ranked project outline for the system prompt
├── compaction.ts        # when and how to summarize the conversation
├── subagents.ts         # the task tool, agent types, .forge/agents loader
├── mcp.ts               # MCP servers: config, trust, connect, tools
└── providers/
    ├── anthropic.ts     # Claude via Anthropic SDK
    └── openai.ts        # every OpenAI-compatible provider (OpenAI, Gemini, OpenRouter, Ollama, ...)

tools/
├── files.ts             # read, write, edit (write/edit capture undo snapshots)
├── search.ts            # glob, grep
├── bash.ts              # bash
├── project.ts           # find_dependents, verify
├── memory.ts            # recall and remember (Engram integration)
├── web.ts               # web_search (DuckDuckGo, no key), web_fetch
└── index.ts             # the tool list

policy/
├── check.ts             # allow / ask / deny for one tool call
├── evaluator.ts         # match a request against the rules
├── parser.ts            # load forge.policy.yaml
└── audit.ts             # audit log (.forge/audit.db)

vscode-extension/       # VS Code: Forge in the terminal panel, ask about a selection
grpc/                   # forge.proto, the gRPC server, and an example client

cli/
├── index.ts             # the forge command + forge config set/get
└── commands.ts          # 24 slash commands

model/                   # the project index behind forge init and find_dependents (.forge/events.db)
verify/chain.ts          # type check → tests → lint
executor/git.ts          # guarded git helpers
diff/semantic.ts         # semantic diff grouping
```

---

## Tests

```bash
npm test               # 196 tests
```

`npm audit` reports no known vulnerabilities in Forge's dependencies (as of 2026-11-18). This matters more than usual for an agent: the `glob` tool passes model-written patterns to `glob` and `minimatch`, so a denial-of-service bug in either could let text the model has read hang Forge.

| Suite | Tests | Covers |
|---|---|---|
| `loop` | 18 | Tool calls and results, deny / ask / approve, unattended refusals, cut-off and empty replies, step and budget limits |
| `check` | 18 | Path escapes, symlinks, chained commands, git rules, protected files |
| `policy` | 13 | Rule matching, deny-by-default, approval rules |
| `tools` | 20 | read, write, edit, glob, grep, bash, line counting |
| `web` | 16 | Search parsing, HTML to text, redirects, binary refusal, network policy |
| `subagents` | 8 | Agent files, read-only `explore`, policy and audit inside children, shared usage |
| `repomap` | 6 | Definitions per language, ranking, budget |
| `streaming` | 9 | Both providers' stream formats, tool calls rebuilt from pieces, usage, tool input checks |
| `compaction` | 11 | When to compact, no repeat compacting, what's carried over, mid-task with pending tool results, both providers' summary requests, the fallback |
| `grpc` | 5 | A full turn over a real connection, streamed text, approvals, token check |
| `mcp` | 8 | A real MCP server: calls, errors, policy, project trust, a server that fails to start |
| `extractor` | 4 | The project indexer: functions and methods, calls across files, constructors, interfaces, never library files |
| `vscode` | 8 | Message formatting, every command, unsaved files |
| `usage` | 14 | Model lookup, provider keys, status line, cost, budget |
| `git-executor` | 19 | Branch names, protected branches, verification gate |
| `diff` | 14 | Category grouping, blast radius |
| `verify` | 5 | Stages, skip conditions |

Tests never read your `~/.forgerc`, so they give the same result on any machine.

---

## License

MIT — Brian Tushae Thomas / Anthos Intelligence

### Acknowledgment

This repository began as a copy of [Free Claude Code](https://github.com/Alishahryar1/free-claude-code) by Ali Khokhar, an MIT-licensed proxy that lets Claude Code use other model providers. Forge has since been rewritten from scratch and none of that code remains in the current files, but its history is still in this repository's git log. Thanks to Ali Khokhar and its contributors for the starting point.

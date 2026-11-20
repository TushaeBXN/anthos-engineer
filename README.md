<div align="center">

# Forge by Anthos Intelligence

**A software engineering agent for your terminal. It reads, edits and runs your code one step at a time, checks every step against a policy you own, and works with any model — open, closed, local, or hosted.**

[![npm](https://img.shields.io/npm/v/forge-anthos-intelligence?style=for-the-badge&logo=npm&color=cb3837)](https://www.npmjs.com/package/forge-anthos-intelligence)
[![Release](https://img.shields.io/github/v/release/TushaeBXN/anthos-engineer?style=for-the-badge&logo=github)](https://github.com/TushaeBXN/anthos-engineer/releases/latest)
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
# 3. Install Forge
npm install -g forge-anthos-intelligence
```

```bash
# 4. Save your model settings once — survives terminal restarts
forge config set provider ollama
forge config set model forge-deepseek
```

```bash
# 5. In your project folder, choose how much Forge may do without asking (see Ready-made policies)
forge policy use workspace-write
```

```bash
# 6. Run it
forge
```

### Anthropic (Claude)

```bash
npm install -g forge-anthos-intelligence
forge config set provider anthropic
export ANTHROPIC_API_KEY=sk-ant-...
forge policy use workspace-write    # in your project folder
forge
```

Any other provider works the same way: `forge providers` lists them all and the key each one needs.

If something doesn't work, run `forge doctor`: it checks the setup and says how to fix each problem. See [Checking your setup](#checking-your-setup).

### From source

To work on Forge itself, or to run the newest unreleased code:

```bash
git clone https://github.com/TushaeBXN/anthos-engineer.git
cd anthos-engineer
npm install
npm run build && npm link
```

`npm link` puts the `forge` command on your PATH from this folder. Run `npm run build` again after pulling changes.

---

## Why this exists

Coding agents are powerful, but most of them make a trade you don't control: your code gets sent to a server, a closed model you can't inspect makes decisions about your files, and when it runs a shell command it has the same access to your machine that you do — with nothing between the model's output and your filesystem except the agent's own judgment.

The problem I wanted to solve was: **how do you give an AI agent real coding capability without giving it unchecked access to everything?**

The answer Forge is built around is a permission layer that runs before every single tool call — not just dangerous ones. Every read, every write, every shell command goes through `policy/check.ts` first. You write rules in a YAML file you own. If no rule covers something, Forge asks you. If you're not at the keyboard, it refuses. Every decision is logged.

That's a lot of safety machinery for a coding agent. It's intentional.

**The cost angle matters too.** Most hosted coding agents charge per token. Run Forge on a local model and the marginal cost of an hour of agentic work is zero — no API bill, no usage cap, no "you've hit your limit for today." For heavy use — running an agent across a large codebase, iterating on a long-running task, or just leaving it running overnight — that's not a minor concern. The local-first path isn't only about trust or privacy; it's about economics.

**Why it matters:** A model that hallucinates a shell command shouldn't be able to run it silently. A write to a path outside your project shouldn't be able to sneak through via a symlink. A chained command like `npm test && git push origin main` shouldn't bypass a push rule just because the first part is allowed. Forge checks all of these.

**What I'd do to make it better:**

The shell check reads command text; it can't see what a command will actually do. The [sandbox](#sandbox) now closes the worst of that gap: commands Forge runs can only write inside the project, even ones you approve. The rest of the v2 target is to run each session in an isolated container or VM, keep Forge's check on every action, and bring changes back to your files only after you review a diff. [Cloudroom](https://github.com/davidondrej/cloudroom) shows the isolation half: it runs coding agents in a sandbox per thread, but with no approval prompts, and changes come back through a Git branch. Forge would add the per-action checks and the diff review on top.

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
| `forge policy` | List the [ready-made policies](#ready-made-policies) |
| `forge policy use <name>` | Write one to `forge.policy.yaml` in this folder (`--force` replaces an existing one, keeping it as `.bak`) |
| `forge doctor [--json]` | [Check the setup](#checking-your-setup) and say how to fix what's wrong |
| `forge serve [--port N]` | Run Forge as a gRPC service for editors, UIs and scripts |

### Config commands

```bash
forge config set provider ollama          # save your provider
forge config set model <model-name>       # save your model
forge config get                          # show ~/.forgerc
forge providers                           # every provider, and whether its key is set
forge --version                           # the installed version
```

Settings are saved to `~/.forgerc` and survive terminal restarts — no need to `export` env vars every time.

### Checking your setup

`forge doctor` checks everything Forge needs, in the folder you run it from, and says how to fix each problem:

```
$ forge doctor

  ✓ Node.js         26.13.1
  ✓ Config          /Users/you/.forgerc
  ✓ Model           ollama / forge-deepseek (open weights, runs on this machine)
  ✓ API key         none needed
  ✓ Model server    http://localhost:11434/v1 answered and has forge-deepseek
  ✓ Context window  32,768 tokens
  ✓ Policy          18 rules, default deny
  ✓ Project folder  /Users/you/my-project
  ✓ Git             this folder is a git repository
  ✓ Project index   built; find_dependents can answer
  ✓ MCP             no servers configured
  ! Engram memory   not running (optional: recall and remember won't work)
                    → engram serve

  Ready, with 1 warning.
```

| Check | Fails or warns when |
|---|---|
| Node.js | Older than 22 |
| Config | `~/.forgerc` isn't valid JSON. Forge ignores a broken file and falls back to defaults, so this is the only place you'd find out |
| Model, API key | No model chosen, or the provider's key isn't set. The key itself is never printed |
| Model server | The server can't be reached, rejects the key, or doesn't have the model (with the `ollama pull` command to get it). This is one free request that lists or looks up models; it never runs the model |
| Context window | Unknown (automatic compaction is then off) or under 16k tokens, which is too small for Forge's tools; for Ollama it says how to raise `num_ctx` |
| Policy | No `forge.policy.yaml` (every action then needs your OK), a file that can't be read, or rules that can never match, such as a partial wildcard like `npm *` |
| Project folder, Git, Project index | The folder isn't writable, isn't a git repository, or hasn't been indexed with `forge init` |
| MCP | A server in `mcp.json` doesn't start. It starts each one to find out; `--no-mcp` skips this |
| Sandbox | Off, or not available on this machine (a warning), or required with `sandbox on` but not available (a failure) |
| Engram memory | Not running. It's optional, so this is only a warning |

✗ means Forge can't work until it's fixed, and the command then exits with code 1; ! is a warning. `forge doctor --json` gives the same checks as JSON, for scripts.

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
| `FORGE_PROVIDER` | Provider name — run `forge providers` for the list. If it differs from the provider in `~/.forgerc`, that file's model, address, context and prices are ignored and the provider's default model is used |
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
> Always create local models with `num_ctx 32768` via a Modelfile — the default 4096 token context is too small for real coding tasks. Forge reads that window from Ollama at startup, so the status line shows how much is left and [context compaction](#context-compaction) knows when to step in.

The model must support tool calling.

---

## How it works

Forge is one loop:

1. Send the conversation to the model.
2. If the model asks for a tool, check it against your policy, run it, send the result back.
3. Repeat until the model answers without asking for a tool.

**Parallel tool calls** — when the model asks for several tools at once, they run in the order it gave. Reads, searches, web requests and sub-agents next to each other run together; an edit or a command waits for the calls before it and runs alone, so "edit, then run the tests" tests the edited file.

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
- Ready-made policies — `forge policy use read-only`, `workspace-write` or `full-access`
- `forge doctor` — checks the setup (model server, key, context window, policy, MCP) and says how to fix each problem
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
- Xcode — Apple's MCP bridge (`xcrun mcpbridge`) gives Forge Xcode's build, test and preview tools; the repo map reads Swift
- 24 slash commands
- Persistent config via `~/.forgerc` — no env vars every session
- Automatic context compaction — long tasks are summarized before they outgrow the model's context window, even mid-task
- Claude Code-style terminal UI (panel header, braille spinner, `⎿` hooks), with replies streamed as they are written
- Every tool input checked against the tool's schema (required fields, types, allowed values) before the policy check
- 13 providers: Anthropic, OpenAI, Gemini, xAI, Mistral, DeepSeek, OpenRouter, Groq, Together, Fireworks, Cerebras, Ollama, LM Studio — plus any OpenAI-compatible server
- Works with local models for free, no API key needed
- Installs from npm: `npm install -g forge-anthos-intelligence`

**Current limitations:**
- Local models are capable but less reliable — they may try several wrong commands before getting it right
- When a tool is blocked, a small local model may answer from memory as if it had run. Forge still prints the `⎿ … not allowed` line and logs the block, so what actually happened is always visible
- Two `general` sub-agents running in parallel can edit the same file; use parallel tasks for separate files or read-only work
- The 32k context wrapper (`num_ctx` Modelfile) is a manual step. Forge reads the window from Ollama once it's set, but doesn't create the Modelfile for you
- Not yet run for real: Xcode, the VS Code extension, and a conversation on any provider other than Ollama and Anthropic. Each is covered by tests against stand-ins; see [What has been tested](#what-has-been-tested-and-how)
- The [sandbox](#sandbox) covers commands (`bash`, `verify`), not MCP servers, and limits where a command can write, not what it writes: a command can still change files in the project that run later, such as a test script or a Makefile
- On Linux the sandbox needs bubblewrap, and it's tested on GitHub's Ubuntu machines rather than a desktop Linux; on Windows there's no sandbox

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
| Xcode (Apple's MCP bridge) | Yes | — | Yes, not yet tried with real Xcode |
| Ready-made permission levels | Yes | — | Yes — read-only, workspace-write, full-access, written as a policy file you can edit |
| Setup check (`doctor`) | Yes | — | Yes — includes the policy file and MCP servers |
| Sandbox | Yes | — | Yes — macOS Seatbelt, Linux bubblewrap; on by default where available |

A dash means I haven't confirmed it either way. Claude Code and OpenClaude are far larger projects; Forge's focus is the part they share least: an agent you can govern and audit, running on whatever model you choose.

### Compared with claw-code

[claw-code](https://github.com/ultraworkers/claw-code) is an open-source coding agent written in Rust, modeled on Claude Code. Forge's sandbox was built from the same idea, with its own code. This comparison is from claw-code's code and commits as of 2026-11-20 (release v0.1.13, 2026-11-09); I haven't run claw-code.

| | Forge 0.4.3 | claw-code v0.1.13 |
|---|---|---|
| Permission levels | A rule for each resource, action and target (allow, ask or deny), plus three ready-made presets | Three fixed modes: read-only, workspace-write, danger-full-access |
| Sandbox on macOS | Yes (Seatbelt), escape tests run for real | No, Linux only |
| Sandbox on Linux | bubblewrap: the system is read-only and only the project is writable. The same escape tests as on macOS run on Ubuntu in CI on every push | Linux namespaces (`unshare`). Its "workspace-only" mode is passed to the command as an environment variable rather than blocking writes; it also points `HOME` at a folder inside the project |
| Checks the sandbox can start before using it | Yes: tries bubblewrap once; `forge doctor` says why if it can't | Yes: tries the ways `unshare` can start before using one |
| Policy file, audit log and git hooks protected from commands | Yes, including swapping `.git` for another and creating them where they don't exist yet | No |
| `~/.ssh`, `~/.aws`, `~/.gnupg` | Hidden from commands, and denied by every preset | Not blocked by the sandbox |
| Telling the model why something was blocked | The policy's reason, and a sandbox hint; on `main`, the hint names the protected files | Its permission checks give a reason, such as a path being outside the workspace |
| Record of every permission decision | Yes, a local audit log | None found |
| Setup check | `forge doctor` | `doctor` |
| Written in | TypeScript (Node.js) | Rust, one program to install |
| Windows | Not supported by the sandbox; not tested | Supported |
| Built-in tools | Files, search, shell, web, verify, sub-agents, memory | More, including notebook editing |
| Community | New, one maintainer | 194,760 stars and 107,203 forks; releases every few days until v0.1.13 (2026-11-09) |

**In short:** claw-code reaches further: more tools, Windows, and far more people using it, so more of it has been tried in practice. Forge goes further on control: per-rule permissions, a record of every decision, and a sandbox that also works on a Mac and protects its own rules. Some Forge features still haven't been run for real, including a session with a model on Linux; see the next table.

### What has been tested, and how

| Feature | Tests | Run for real |
|---|---|---|
| Agent loop, policy, audit, undo | Yes | Yes, on `forge-deepseek` |
| `forge --version`, unknown options | Yes — the version matches `package.json`; a misspelled flag is an error, not a request | Yes — the built command printed its version and refused `--bogus` |
| Web search and fetch | Yes, including a local server for redirects | Yes — live search, live fetch, and a deny rule blocking a host |
| Repo map | Yes | Yes — answered a code question from the map alone |
| Project index | Yes — imports of every kind, methods, constructors, interfaces, name clashes | Yes — indexed Forge itself: 30 methods, 236 call links, none pointing at nothing |
| Sub-agents | Yes, including two in parallel | Yes — `explore` found the right file and line |
| gRPC server | Yes, over a real connection | Yes — `forge serve` + the example client |
| 13 providers | Key handling and addresses | Ollama and **Anthropic** (`claude-opus-5-5`): a real session read a file, found two bugs, edited the file and ran the tests after approval, for 5k tokens and $0.04. It found two bugs in Forge, both fixed in 0.4.3: `FORGE_PROVIDER` kept the saved Ollama model, and a command sent with an edit ran before it. The other hosted addresses answered; **no real conversation on them yet** (needs each provider's key) |
| VS Code extension | Yes, against a stand-in VS Code API; packages with `vsce` | **Not yet run in VS Code** |
| Context compaction | Yes — trigger, carry-over, both providers' summary requests, fallback | Yes on `forge-deepseek`: compacted once mid-task (7.8k → 1.7k) and still answered correctly |
| Streaming | Yes — local servers speaking the OpenAI and Anthropic stream formats | Yes on `forge-deepseek`: a reply arrived in 77 pieces over 6 s, and a turn with a tool call streamed too. On Anthropic, the session above ran over the streaming API, tool calls included |
| Xcode (through MCP) | Yes, against a server that replies the way Xcode's bridge does | **Not yet run with real Xcode** |
| MCP | Yes, against a real MCP server (`tests/fixtures/mcp-server.ts`) | Yes — `forge-deepseek` used a server's tool; a tool with no rule was refused |
| `forge doctor` | Yes, against a fake model server | Yes — on this Ollama setup, and on broken ones: invalid config, missing model, stopped server, missing key, and a fake key the real Anthropic API rejected |
| Ready-made policies | Yes — every action under each policy | Yes on `forge-deepseek`: `read-only` refused every edit and command; `workspace-write` made the fix and refused unapproved commands. Installed fresh from npm and written with `forge policy use` |
| Sandbox | Yes — settings and fallbacks, plus real escape attempts through the `bash` tool on macOS and on Linux (Ubuntu, in CI on every push) | Yes on `forge-deepseek` under `full-access`, so only the sandbox could stop anything: a write to the home folder was blocked, one in the project worked. Installed fresh from npm (0.4.2), `forge doctor` reports it active, and the installed `bash` tool's `git init` in an empty folder was blocked, leaving the folder empty. On Linux, the escape tests pass on GitHub's Ubuntu machines; **not yet run with a model on Linux** |

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

### Ready-made policies

Writing rules from scratch is the hard part, so Forge comes with three. Each is written to `forge.policy.yaml` as an ordinary policy, with comments, for you to edit:

```bash
forge policy                          # list them
forge policy show workspace-write     # print one
forge policy use workspace-write      # write it to this folder
```

| Action | `read-only` | `workspace-write` | `full-access` |
|---|---|---|---|
| Read files in the project, search it | allow | allow | allow |
| Read `.env` files | ask | ask | allow |
| Read files outside the project | ask | ask | allow |
| Write files in the project | **deny** | allow | allow |
| Write files outside the project | **deny** | ask | allow |
| `git status`, `diff`, `log`, `show` | allow | allow | allow |
| `git add` | **deny** | allow | allow |
| `git commit`, `git push` to a branch | **deny** | ask | allow |
| `git push` to `main` or `master` | **deny** | **deny** | allow |
| Shell commands, `verify` | **deny** | ask | allow |
| Web search and fetch, MCP tools | ask | ask | allow |
| Read or write `~/.ssh`, `~/.aws`, `~/.gnupg` | **deny** | **deny** | **deny** |
| `git push --force` | **deny** | **deny** | **deny** |

- **read-only** is for exploring or reviewing code you don't want touched.
- **workspace-write** is the everyday choice: Forge edits the project freely and asks before anything that runs code, leaves the project or changes git history. To stop being asked about one command, uncomment the example in the file (`npm test`, say). Forge can edit `package.json`, so allowing `npm test` effectively lets it run any script it writes.
- **full-access** runs everything without asking, except commands with redirection or substitution (`>`, `$(...)`, backticks): the policy can't see what those will do, so they still ask. Use it only in a container or on a machine where nothing can be lost; the [sandbox](#sandbox) still limits where commands can write.

Whatever the policy says, Forge never writes `forge.policy.yaml`, `.forge/` or `.git/`. Unattended (`forge "<request>"` or `forge serve` with no one to approve), every "ask" is a no.

These are tested action by action (`tests/presets.test.ts`) and were run for real on a local model: under `read-only`, every edit and shell command was refused and the file was untouched; under `workspace-write`, the fix was made, `git status` ran, and `ls` and `verify` were refused for lack of approval.

**Rule order matters.** The first rule that matches decides, and a file target like `**` matches paths outside the project too (they're absolute, such as `/Users/you/.ssh/id_ed25519`). So the presets list deny rules first, then `"/**"` for "outside the project", then `"**"` for everything in it. If you wrote your own policy with `target: "**"` to mean "the project", check it: it also covers your home folder.

**Letting `verify` run without asking.** `verify` runs `npx tsc`, `npm test` and `npx eslint`, and the policy checks each one. Under `workspace-write` it asks every time, until you allow the three commands, for example by adding these rules to the shell section:

```yaml
  - id: allow-tsc
    resource: shell
    operation: npx tsc
    target: "*"
    effect: allow

  - id: allow-tests
    resource: shell
    operation: npm test
    target: "*"
    effect: allow

  - id: allow-eslint
    resource: shell
    operation: npx eslint
    target: "*"
    effect: allow
```

**This repository's own policy** is exactly that: `workspace-write` plus these three rules ([forge.policy.yaml](forge.policy.yaml)). It replaced an older hand-written policy with two problems. It allowed reading any file on the machine, `~/.ssh` and `~/.aws` included, because its read rule used `target: "**"`. And its list of folders Forge could edit was out of date, leaving out `agent/`, `tools/` and `tests/`, where most of the work happens. With the new policy, in this repo:

| Action | Decision |
|---|---|
| Read `~/.ssh/id_ed25519` | deny |
| Read `/etc/hosts` or `.env` | ask |
| Edit `agent/loop.ts` | allow |
| Edit `forge.policy.yaml` | deny |
| `verify`, `npm test -- --watch` | allow |
| `rm -rf dist`, `git commit` | ask |
| `git push origin main` | deny |

### Sandbox

The policy decides whether a command may run; the sandbox limits what it can do once it runs. Every command Forge runs (`bash` and `verify`) runs inside the operating system's own sandbox, so even a command you approved can't touch the rest of your machine:

| Inside the sandbox | |
|---|---|
| Write in the project and temp folders | allowed |
| Write anywhere else (your home folder, other projects, system files) | **blocked** |
| Change `forge.policy.yaml` or the audit log, even inside the project | **blocked** |
| Change `.git/config` or `.git/hooks` (they'd run code later, outside the sandbox) | **blocked** |
| Move, remove or replace `.git` or `.forge` (a `.git` file pointing elsewhere would bring its own hooks) | **blocked** |
| Create `forge.policy.yaml`, `.git` or git hooks where there are none (`git init`, say) | **blocked**; run `git init` yourself |
| Read or write `~/.ssh`, `~/.aws`, `~/.gnupg` | **blocked** |
| Normal git: add, commit, branch | allowed |
| Reach this machine (local model servers, test servers) | allowed. On Linux, blocked too when `sandboxNetwork` is off |
| Reach the internet | allowed, or blocked with `sandboxNetwork off` |

| Platform | How |
|---|---|
| macOS | Seatbelt (`sandbox-exec`), built into macOS |
| Linux | [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`), if installed: `apt install bubblewrap` or `dnf install bubblewrap`. Forge tries it once at startup; where it can't start a sandbox (user namespaces turned off, as in some containers), `forge doctor` says why |
| Windows | None yet |

```bash
forge config set sandbox auto           # the default: use it when the OS has one
forge config set sandbox on             # require it: with no sandbox, commands don't run
forge config set sandbox off            # turn it off
forge config set sandboxNetwork off     # sandboxed commands can't reach the internet
```

`forge doctor` shows whether it's on. When a command fails because of it, Forge tells the model so, and the model can ask you to run that command yourself. When what was blocked is a protected file inside the project (`git init`, say), the hint names the protected files, so the model doesn't think the project itself is off limits. `git push` over SSH needs your SSH key, which the sandbox hides, so push yourself or use HTTPS.

**What it covers, and what it doesn't.** It covers commands Forge runs. Forge's own `read`, `write` and `edit` tools run inside Forge and are covered by the policy instead. MCP servers are started by you, from your config, and aren't sandboxed. The sandbox limits *where* a command can write, not *what*: a command can still change a file in the project that runs later, such as a test script or a Makefile, which is one more reason to review the diff.

**How the protected paths are guarded.** On macOS, Seatbelt blocks the paths themselves, whether they exist or not. On Linux, bubblewrap can only protect paths that exist, so `.git` and `.forge` are pinned in place and their protected files made read-only; after each command, Forge checks whether it created any protected path that wasn't there before (a policy file, a `.git` from `git init`), renames each to `*.blocked-by-forge` so nothing reads or runs it, and tells the model. Nothing is deleted. The command's processes are all gone by then, so none can make it again.

**Tested on macOS** (`tests/sandbox.test.ts`): Forge's own `bash` tool tried to write to the home folder, rewrite the policy file and the audit log, plant a git hook and change git config, move `.git` and `.forge` aside, create a policy file and a repo in a folder that had neither, read `~/.ssh`, and reach the internet with the network off. All were blocked, while writes in the project, a real git commit and a local server still worked. In a real run on `forge-deepseek` under the `full-access` policy, which allows everything, `touch ~/forge-escape-test.txt` was blocked and `touch notes.txt` in the project worked. The model then explained which was which. Forge's whole test suite also passes from inside the sandbox, the way `verify` runs it. 

**Tested on Linux** (same file, in CI on every push): the same escape attempts run through bubblewrap on GitHub's Ubuntu machines, with a fake home folder and a fake SSH key. All were blocked; in a folder with no policy file or repo, the ones the command made were set aside, while writes in the project and `/tmp` and a real git commit still worked. One difference from macOS: with the network off, Linux gives the command a network of its own, so it can't reach servers on this machine either. Forge itself still reaches a local model; only commands are cut off. Not yet run with a model on Linux.

**Compared with claw-code's.** [claw-code](https://github.com/ultraworkers/claw-code) also sandboxes commands, using Linux namespaces (`unshare`). It works only on Linux, and its "workspace-only" file mode sets an environment variable rather than blocking writes. Forge's sandbox blocks writes outside the project on macOS as well as Linux, and protects the policy, the audit log and git hooks inside it.

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

1. Install the `forge` command: `npm install -g forge-anthos-intelligence`
2. Download `forge-vscode-0.1.0.vsix` from the [latest release](https://github.com/TushaeBXN/anthos-engineer/releases/latest), then:

```bash
code --install-extension forge-vscode-0.1.0.vsix
```

To build the extension yourself instead: `cd vscode-extension && npx @vscode/vsce package`.

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

### Xcode

Since Xcode 26.3, Apple ships an MCP server for outside coding agents, `xcrun mcpbridge`. It gives Forge Xcode's own tools: reading the project, building, running tests and rendering SwiftUI previews (about 20 tools, such as `BuildProject`, `RunTests` and `RenderPreview`). Add it to `~/.forge/mcp.json`:

```json
{ "mcpServers": { "xcode": { "command": "xcrun", "args": ["mcpbridge"] } } }
```

Then:

1. Turn on the MCP server in Xcode's settings.
2. Open your project in Xcode. The bridge talks to the running Xcode, so the project must be open, not just an empty window.
3. Run Forge in Terminal, in the project's folder. `/mcp` should list the Xcode tools.

Allow what you're happy to run without asking, such as builds and tests, and leave the rest on "ask":

```yaml
  - id: xcode-build-and-test
    resource: mcp
    operation: BuildProject
    target: xcode
    effect: allow
```

`operation` is an exact tool name; `/mcp` lists the bridge's tool names. The [repo map](#repo-map) reads Swift, so Forge knows your types and functions from the start. The [project index](#project-index) covers TypeScript only.

Xcode's bridge is reported to declare output schemas for its tools and then reply in plain text, which the MCP SDK's normal call rejects. Forge reads the reply's text either way, and a test server that behaves like this is in the test suite.

**Not yet tried with real Xcode.** The setup above follows Apple's bridge as other agents (Claude Code, Codex, Cursor) use it, and Forge passes its tests against a server that behaves the same way. If something doesn't work, please open an issue.

Forge can't be used *inside* Xcode's own AI panel. That panel takes a model, not an agent: to use a local model there, point Xcode at Ollama directly.

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

1. Find the names each source file defines (functions, classes, types) — TypeScript/JavaScript, Python, Go, Rust, Java/Kotlin/C#, Ruby, Swift.
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
├── version.ts           # Forge's version, read from package.json
├── doctor.ts            # forge doctor: setup checks and how to fix each
├── sandbox.ts           # runs commands in the OS sandbox (macOS Seatbelt, Linux bubblewrap)
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
├── presets.ts           # read-only, workspace-write, full-access (forge policy use)
└── audit.ts             # audit log (.forge/audit.db)

vscode-extension/       # VS Code: Forge in the terminal panel, ask about a selection
grpc/                   # forge.proto, the gRPC server, and an example client

cli/
├── index.ts             # the forge command: chat, one-shot, config, providers, doctor, serve, init, query
└── commands.ts          # 24 slash commands

model/                   # the project index behind forge init and find_dependents (.forge/events.db)
verify/chain.ts          # type check → tests → lint
executor/git.ts          # guarded git helpers
diff/semantic.ts         # semantic diff grouping
tests/                   # 313 tests; fixtures/ holds small MCP servers used by them
```

---

## Tests

```bash
npm test               # 313 tests
```

CI runs them on Linux (Ubuntu) on every push to `main`, with bubblewrap installed, so the Linux sandbox tests run for real there; on a Mac, the macOS ones run instead.

`npm audit` reports no known vulnerabilities in Forge's dependencies (as of 2026-11-18). This matters more than usual for an agent: the `glob` tool passes model-written patterns to `glob` and `minimatch`, so a denial-of-service bug in either could let text the model has read hang Forge.

| Suite | Tests | Covers |
|---|---|---|
| `loop` | 18 | Tool calls and results, deny / ask / approve, unattended refusals, cut-off and empty replies, step and budget limits |
| `check` | 19 | Path escapes, symlinks, chained commands, git rules, protected files |
| `policy` | 13 | Rule matching, deny-by-default, approval rules |
| `tools` | 20 | read, write, edit, glob, grep, bash, line counting |
| `web` | 16 | Search parsing, HTML to text, redirects, binary refusal, network policy |
| `subagents` | 8 | Agent files, read-only `explore`, policy and audit inside children, shared usage |
| `repomap` | 7 | Definitions per language (Swift included), ranking, budget |
| `streaming` | 11 | Both providers' stream formats, tool calls rebuilt from pieces, usage, tool input checks, empty replies |
| `compaction` | 11 | When to compact, no repeat compacting, what's carried over, mid-task with pending tool results, both providers' summary requests, the fallback |
| `grpc` | 5 | A full turn over a real connection, streamed text, approvals, token check |
| `mcp` | 9 | A real MCP server: calls, errors, policy, project trust, a server that fails to start, replies like Xcode's bridge |
| `extractor` | 4 | The project indexer: functions and methods, calls across files, constructors, interfaces, never library files |
| `presets` | 76 | Every action in the table above, under each ready-made policy, loaded from YAML the way Forge loads it; `verify` goes through the policy; `forge doctor` finds no problems in any of them |
| `telemetry` | 2 | The circuit breaker; refused calls don't trip it |
| `sandbox` | 28 | Settings and fallbacks, the Linux command line, setting aside what a command created, the hint the model gets, and real escape attempts through the `bash` tool on macOS and on Linux: home folder, policy file, audit log, git hooks and config, swapping `.git`, creating a policy file or repo, `~/.ssh`, the internet. Each OS's set skips on the other |
| `doctor` | 12 | Each setup check against a fake model server: missing model, unreachable server, rejected or missing key (never printed), small window, policy problems, broken `~/.forgerc` |
| `vscode` | 8 | Message formatting, every command, unsaved files |
| `usage` | 14 | Model lookup, provider keys, status line, cost, budget |
| `git-executor` | 19 | Branch names, protected branches, verification gate. Uses its own policy, not this repo's |
| `diff` | 14 | Category grouping, blast radius |
| `verify` | 5 | Stages, skip conditions |

Tests never read your `~/.forgerc`, so they give the same result on any machine.

---

## Releases

The current version is **0.4.3**. Each release is on the [releases page](https://github.com/TushaeBXN/anthos-engineer/releases), with notes on what changed and the VS Code extension attached, and on [npm](https://www.npmjs.com/package/forge-anthos-intelligence).

To update to the newest release:

```bash
npm install -g forge-anthos-intelligence@latest
```

| Version | Date | What's new |
|---|---|---|
| [0.4.3](https://github.com/TushaeBXN/anthos-engineer/releases/tag/v0.4.3) | 2026-11-20 | `forge --version`; misspelled options are errors instead of requests; `FORGE_PROVIDER` no longer keeps another provider's saved model; tool calls run in the model's order; first real session on Claude |
| [0.4.2](https://github.com/TushaeBXN/anthos-engineer/releases/tag/v0.4.2) | 2026-11-20 | Sandbox fixes: commands can no longer swap `.git` for another, or create a policy file or repo where there was none |
| [0.4.1](https://github.com/TushaeBXN/anthos-engineer/releases/tag/v0.4.1) | 2026-11-20 | The Linux sandbox, tested for real on Ubuntu; Forge checks that bubblewrap can start before using it |
| [0.4.0](https://github.com/TushaeBXN/anthos-engineer/releases/tag/v0.4.0) | 2026-11-20 | [Sandbox](#sandbox): commands run in macOS Seatbelt or Linux bubblewrap and can write only inside the project |
| [0.3.0](https://github.com/TushaeBXN/anthos-engineer/releases/tag/v0.3.0) | 2026-11-20 | [Ready-made policies](#ready-made-policies) (`forge policy use`); `verify` now goes through the policy; fixes for chained commands, the circuit breaker and empty replies |
| [0.2.0](https://github.com/TushaeBXN/anthos-engineer/releases/tag/v0.2.0) | 2026-11-20 | [`forge doctor`](#checking-your-setup): checks the setup and says how to fix each problem |
| [0.1.0](https://github.com/TushaeBXN/anthos-engineer/releases/tag/v0.1.0) | 2026-11-19 | First release: the agent loop and policy, 13 providers, MCP, sub-agents, streaming, compaction, repo map, project index, gRPC, VS Code |

**Updating from 0.4.2:**
- An option Forge doesn't know, such as `forge --verison`, now stops with an error. Before, it was sent to the model as a request.
- `FORGE_PROVIDER=anthropic forge` with Ollama saved in `~/.forgerc` now uses Claude's default model. Before, it asked Anthropic for your Ollama model and failed with "not found". Set `FORGE_MODEL` to choose another.
- When the model asks for an edit and a command in one reply, the command now runs after the edit. Before, commands ran first, so tests could run against the old file.

The v0.4.0 tag points at `099be44`, one commit before a fix to a test file; the published code is the same.

**Updating from 0.4.1:** `git init` inside Forge is now blocked on Linux too (it already failed on macOS): the new repo is renamed to `.git.blocked-by-forge`. Run `git init` yourself. Anything else a command creates among Forge's and git's protected files is set aside the same way, and the model is told.

**Updating from 0.4.0** (Linux only; nothing changes on macOS): where bubblewrap is installed but can't start a sandbox, as in some containers, 0.4.0 tried to use it anyway and every command failed. 0.4.1 runs commands without it there (with `sandbox on`, it runs none), and `forge doctor` says why.

**Updating from 0.3.0:**
- Commands now run in the sandbox wherever the system supports it. A command that wrote outside the project (a global install, a file in your home folder) now fails; run it yourself, or turn the sandbox off with `forge config set sandbox off`.
- `git push` over SSH from inside Forge fails, because the sandbox hides `~/.ssh`. Push yourself, or use an HTTPS remote.

**Updating from 0.2.0 or earlier:**
- If a project has no `forge.policy.yaml`, run `forge policy use workspace-write` there; until then Forge asks before every action.
- `verify` is now checked as the commands it runs (`npx tsc`, `npm test`, `npx eslint`). If your policy has no rule for them, it asks before running; add shell rules for the ones you trust.
- If your own policy uses `target: "**"` to mean the project, it also covers files outside it, such as `~/.ssh`. See [Rule order matters](#ready-made-policies).

The VS Code extension is versioned on its own and is still 0.1.0; every release has it attached, so the [latest release](https://github.com/TushaeBXN/anthos-engineer/releases/latest) always has a copy.

Forge stays at 0.x while some integrations (Xcode, VS Code, providers other than Ollama and Anthropic) haven't been run for real. See [What has been tested](#what-has-been-tested-and-how).

### Publishing a new version

For maintainers. Publishing to npm needs two-factor authentication on the npm account.

1. **Start from an up-to-date folder.** npm publishes whatever is in the folder you run it from, so an old checkout publishes old code:

   ```bash
   git pull && npm install
   ```

   Before publishing, `npm pack --dry-run` lists exactly which files will go into the package, and `npm test` shows whether publishing will get past the tests. Run the tests in this folder, not only in the one you work in: a test can pass in one folder and fail in another. For 0.4.0, a test passed in a folder whose path had a space in it and failed in the publish folder.

2. **Set the new version** and push it:

   ```bash
   npm version 0.2.0 --no-git-tag-version
   git commit -am "Set version to 0.2.0" && git push
   ```

   Then wait for CI to pass on that commit. `npm publish` on a Mac runs only the Mac's tests; the Linux sandbox tests run only in CI. CI failed on every push from the sandbox commit until after 0.4.0 was published, and nobody noticed until the Linux tests were looked at:

   ```bash
   gh run watch "$(gh run list -w ci.yml -b main -L 1 --json databaseId -q '.[0].databaseId')" --exit-status
   ```

3. **Publish to npm.** This builds and runs every test first, then opens your browser to confirm with 2FA:

   ```bash
   npm publish
   ```

   If a test fails, npm stops and publishes nothing; the version number is still free. Fix it in your working copy, push, run `git pull` in this folder, and publish again.

   npm may say "Your package is being processed and may take a few minutes to become available." That's normal: 0.2.0 took about 40 seconds to appear.

4. **Create the GitHub release** with notes on what changed, once `npm publish` has succeeded, so the tag points at the commit that was published. Moving a tag later means deleting a public one. Tag the commit first and push the tag; `gh release create --target <commit>` refuses a bare commit ID. Attach the VS Code extension every time, so the latest release always has it. If the extension changed, build a new one with `cd vscode-extension && npx @vscode/vsce package`; if not, download the current one from the previous release:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0   # the commit you published
   gh release download v0.1.0 -p "forge-vscode-*.vsix"
   gh release create v0.2.0 --verify-tag --title "Forge v0.2.0" --notes-file notes.md forge-vscode-0.1.0.vsix
   ```

5. **Check it.** npm keeps a local copy of package information, so ask the registry directly:

   ```bash
   npm view forge-anthos-intelligence version --prefer-online
   npm install -g forge-anthos-intelligence@latest --prefer-online && forge doctor
   ```

   Without `--prefer-online`, npm may still say the new version doesn't exist (`ETARGET`) for a while after it's published.

6. **Add a row** to the version table above.

npm never lets a version number be used twice, even after it's been removed. 1.0.0 was published by mistake and removed, so the 1.0 release will need another number, such as 1.0.1.

**Old or unwanted versions.** npm keeps every published version in the package's list. Mark one you don't want used as deprecated instead of removing it: it stays listed, but anyone who installs it sees a warning. That's what was done to `0.0.0-stage`, an empty placeholder made while setting up the package:

```bash
npm deprecate forge-anthos-intelligence@0.0.0-stage "Placeholder version, not a real release. Install forge-anthos-intelligence@latest instead."
```

`npm view forge-anthos-intelligence@0.0.0-stage deprecated` prints the warning if it worked.

**If npm says 404 or 401.** For an account change such as `npm publish` or `npm deprecate`, a `404 Not Found` usually means you're signed out, not that the package is missing; npm sign-ins expire. Check with `npm whoami`, and if it fails, run `npm login`. Press Enter when it asks, so it opens the browser, and approve there: signing in on the npm website alone doesn't sign in the command.

---

## License

MIT — Brian Tushae Thomas / Anthos Intelligence

### Origins

Forge started as **Anthos Engineer** and was later renamed Forge, which is why the repository is still called `anthos-engineer`. Its code was written for it; it is not built on another project's code. Some pieces were implemented from ideas seen in other tools, such as Claude Code, OpenClaude and Cloudroom, which are compared [above](#how-forge-compares).

This repository's early git history contains commits from [Free Claude Code](https://github.com/Alishahryar1/free-claude-code) by Ali Khokhar (MIT), which is why his name appears in the log. None of that code is in the current files.

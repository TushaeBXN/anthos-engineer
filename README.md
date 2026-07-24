<div align="center">

# Anthos Engineer

**Standalone agentic coding system powered by your local Ollama models.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-3776ab.svg?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/downloads/)

No Claude Code. No API keys. No cloud dependency. Describe what you want to build — Anthos Engineer plans it, writes the code, and runs it using Amy or any model running locally in Ollama.

</div>

---

## What It Does

- **Intent detection** — Knows the difference between a build goal and a chat message. Greetings get a conversational reply; build requests get a full plan-execute loop.
- **Plan → Execute → Verify** — Breaks goals into steps (write file, run command, install package), executes them in order, and streams every step live.
- **Local-first** — Calls Ollama directly at `http://localhost:11434`. No outbound API traffic.
- **Model picker** — Switch between amy, kerrigan-fantasma, deepseek-coder, llama3.2, or any model you have pulled.
- **Dark web UI** — Real-time execution view with plan list, step status, log feed, and created files list.

---

## Quick Start

**Prerequisites:** Python 3.11+, [uv](https://docs.astral.sh/uv/getting-started/installation/), [Ollama](https://ollama.ai) running with at least one model pulled.

```bash
git clone https://github.com/TushaeBXN/anthos-engineer
cd anthos-engineer
uv sync
source .venv/bin/activate
anthos-engineer
```

Open **http://127.0.0.1:7337** in your browser.

To use a different default model:

```bash
ANTHOS_MODEL=deepseek-coder anthos-engineer
```

---

## Models

Any model available in your local Ollama installation works. The UI ships with these in the picker:

| Model | Best for |
|---|---|
| `amy` | General coding (default) |
| `amy-base` | Lightweight tasks |
| `kerrigan-fantasma` | Security research |
| `deepseek-coder:6.7b` | Code generation |
| `llama3.2:3b` | Fast responses |
| `llama3.2-vision` | Image-aware tasks |

Pull a model: `ollama pull <name>`

---

## Architecture

```
anthos_engineer/
├── agent.py      # classify_intent(), AnthosEngineer (plan/execute/chat)
├── server.py     # FastAPI + SSE streaming on port 7337
└── static/
    ├── index.html
    ├── style.css
    └── app.js
```

**Request flow:**

1. User submits a goal in the web UI
2. `POST /api/session` creates a session
3. `GET /api/session/{id}/stream` opens an SSE connection
4. Server calls `classify_intent()` — routes to `chat()` or full `plan()` + `execute_step()` loop
5. Events (`status`, `plan`, `step_start`, `step_done`, `chat`, `done`) stream to the browser in real time

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ANTHOS_MODEL` | `amy` | Default Ollama model |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server address |

---

## License

MIT — Brian Tushae Thomas

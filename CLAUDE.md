# Anthos Engineer — Developer Guide

## Setup

```bash
uv sync
source .venv/bin/activate
anthos-engineer        # starts on http://127.0.0.1:7337
```

Requires: Python 3.11+, uv, Ollama running locally.

## Project Layout

```
anthos_engineer/
├── agent.py      # classify_intent(), AnthosEngineer class
├── server.py     # FastAPI app + SSE streaming
└── static/       # index.html, style.css, app.js
```

## Key Decisions

- **No proxy layer** — calls Ollama's `/v1/chat/completions` directly via httpx.
- **Intent classification first** — every session starts with `classify_intent()` before any planning. Chat messages never enter the build loop.
- **SSE events**: `status` → `plan` → `step_start` / `step_done` (repeated) → `done`; or `status` → `chat` → `done` for conversational input.
- **Workspace isolation** — each session gets a `tempfile.mkdtemp(prefix="anthos-")` directory so generated files never collide.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `ANTHOS_MODEL` | `amy` | Any model name known to Ollama |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Change if Ollama runs on a different host/port |

## Coding Standards

- Python 3.11+, no `from __future__ import annotations`
- Ruff for formatting and lint (`ruff format`, `ruff check --fix`)
- No type ignores — fix the underlying issue
- No comments explaining what the code does — only WHY if non-obvious

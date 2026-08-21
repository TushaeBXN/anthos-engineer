"""Cross-session memory index — persists goal/summary across restarts.

Stored at ~/.anthos/cross_session.json so it survives workspace changes.
"""

import json
from datetime import datetime
from pathlib import Path

_INDEX_PATH = Path.home() / ".anthos" / "cross_session.json"


def _load() -> dict:
    if _INDEX_PATH.exists():
        try:
            return json.loads(_INDEX_PATH.read_text())
        except Exception:
            return {}
    return {}


def _save(index: dict) -> None:
    _INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    _INDEX_PATH.write_text(json.dumps(index, indent=2))


def record_session(session_id: str, goal: str, workspace: str, model: str, file_count: int) -> None:
    """Called at session end to persist a summary entry."""
    index = _load()
    index[session_id] = {
        "session_id": session_id,
        "ts": datetime.now().isoformat(),
        "goal": goal,
        "workspace": workspace,
        "model": model,
        "file_count": file_count,
    }
    # Keep last 200 sessions only
    if len(index) > 200:
        oldest = sorted(index, key=lambda k: index[k].get("ts", ""))[:len(index) - 200]
        for k in oldest:
            del index[k]
    _save(index)


def search(query: str, max_results: int = 10) -> list[dict]:
    """Keyword search across all recorded sessions. Returns newest-first."""
    index = _load()
    q = query.lower()
    hits = [
        v for v in index.values()
        if q in v.get("goal", "").lower() or q in v.get("workspace", "").lower()
    ]
    hits.sort(key=lambda x: x.get("ts", ""), reverse=True)
    return hits[:max_results]


def recent(max_results: int = 10) -> list[dict]:
    """Return the most recent sessions regardless of query."""
    index = _load()
    entries = sorted(index.values(), key=lambda x: x.get("ts", ""), reverse=True)
    return entries[:max_results]

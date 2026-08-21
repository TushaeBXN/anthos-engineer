"""Append-only session log with JSONL persistence and history search."""

import json
import uuid
from datetime import datetime
from pathlib import Path


class Session:
    def __init__(self, session_id: str, workspace: Path) -> None:
        self.session_id = session_id
        log_dir = workspace / ".anthos" / "sessions"
        log_dir.mkdir(parents=True, exist_ok=True)
        self.log_path = log_dir / f"{session_id}.jsonl"

    def append(self, role: str, content: str, meta: dict | None = None) -> None:
        entry = {
            "id": str(uuid.uuid4()),
            "ts": datetime.now().isoformat(),
            "role": role,
            "content": content,
        }
        if meta:
            entry["meta"] = meta
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

    def search(self, query: str, max_results: int = 5) -> list[dict]:
        if not self.log_path.exists():
            return []
        q = query.lower()
        results: list[dict] = []
        with self.log_path.open(encoding="utf-8") as f:
            for line in f:
                entry = json.loads(line)
                if q in entry.get("content", "").lower():
                    results.append({"role": entry["role"], "content": entry["content"], "ts": entry["ts"]})
                    if len(results) >= max_results:
                        break
        return results

    def all_entries(self) -> list[dict]:
        if not self.log_path.exists():
            return []
        with self.log_path.open(encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

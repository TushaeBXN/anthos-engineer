"""Context compaction — three strategies keyed to how full the context window is."""

import json


# ~8k tokens in characters; Ollama models default to 8192 ctx
_CHAR_LIMIT = 28_000
_MICRO_THRESHOLD = 0.6   # clear old tool outputs
_FULL_THRESHOLD  = 0.85  # LLM-summarize early history


class CompactionEngine:
    def __init__(self, ollama_url: str, model: str) -> None:
        self._url = ollama_url
        self._model = model

    def maybe_compact(self, messages: list[dict]) -> list[dict]:
        size = len(json.dumps(messages))
        ratio = size / _CHAR_LIMIT
        if ratio < _MICRO_THRESHOLD:
            return messages
        if ratio < _FULL_THRESHOLD:
            return self._compact_micro(messages)
        return self._compact_full(messages)

    # ── strategies ────────────────────────────────────────────────────────────

    def _compact_micro(self, messages: list[dict]) -> list[dict]:
        """Truncate large assistant payloads; keep structure intact."""
        compacted: list[dict] = []
        for i, msg in enumerate(messages):
            recent = i >= len(messages) - 6
            if msg["role"] == "assistant" and not recent:
                content = msg["content"]
                if len(content) > 400:
                    msg = {**msg, "content": content[:400] + "\n[…compacted]"}
            compacted.append(msg)
        return compacted

    def _compact_full(self, messages: list[dict]) -> list[dict]:
        """Summarize early messages via the model; keep the last 8 verbatim."""
        recent = messages[-8:]
        older  = messages[:-8]
        if not older:
            return messages

        summary = self._summarize(older)
        summary_msg = {
            "role": "assistant",
            "content": f"[Session summary — earlier context]\n{summary}",
        }
        return [summary_msg] + recent

    def _summarize(self, messages: list[dict]) -> str:
        import httpx

        prompt = (
            "Summarize this conversation in under 200 words. "
            "Focus on what was built, decisions made, and current state.\n\n"
            + "\n".join(f"{m['role']}: {m['content'][:300]}" for m in messages)
        )
        try:
            resp = httpx.post(
                f"{self._url}/v1/chat/completions",
                json={"model": self._model, "messages": [{"role": "user", "content": prompt}], "stream": False},
                timeout=60,
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
        except Exception as e:
            return f"(summary unavailable: {e})"

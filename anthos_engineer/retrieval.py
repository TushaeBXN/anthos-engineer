"""Semantic history search using Ollama embeddings + numpy cosine similarity.

Falls back to keyword search if the embedding endpoint is unavailable
or no embedding model is pulled.
"""

import json
import os
from pathlib import Path

import httpx
import numpy as np

OLLAMA_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
EMBED_MODEL = os.environ.get("ANTHOS_EMBED_MODEL", "nomic-embed-text")
SIMILARITY_THRESHOLD = 0.30


def _get_embedding(text: str) -> np.ndarray | None:
    try:
        resp = httpx.post(
            f"{OLLAMA_URL}/api/embeddings",
            json={"model": EMBED_MODEL, "prompt": text},
            timeout=30,
        )
        resp.raise_for_status()
        return np.array(resp.json()["embedding"], dtype=np.float32)
    except Exception:
        return None


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


class SemanticRetriever:
    """Builds an embedding index over a session JSONL log and answers semantic queries."""

    def __init__(self, log_path: Path) -> None:
        self.log_path = log_path
        self._index_path = log_path.with_suffix(".idx.npy")
        self._meta_path  = log_path.with_suffix(".idx.json")
        self._embeddings: np.ndarray | None = None
        self._entries: list[dict] = []

    # ── public ────────────────────────────────────────────────────────────────

    def search(self, query: str, top_k: int = 5) -> list[dict]:
        """Return up to top_k entries most semantically similar to query.

        Falls back to keyword search when embeddings are unavailable.
        """
        q_emb = _get_embedding(query)
        if q_emb is None:
            return self._keyword_fallback(query, top_k)

        self._ensure_index()
        if self._embeddings is None or len(self._entries) == 0:
            return self._keyword_fallback(query, top_k)

        sims = np.array([_cosine_similarity(q_emb, e) for e in self._embeddings])
        ranked = np.argsort(sims)[::-1]

        results = []
        for i in ranked[:top_k]:
            if sims[i] >= SIMILARITY_THRESHOLD:
                results.append({**self._entries[i], "score": round(float(sims[i]), 3)})
        return results

    def add(self, role: str, content: str, ts: str) -> None:
        """Incrementally embed and append one new entry."""
        entry = {"role": role, "content": content, "ts": ts}
        emb = _get_embedding(content)
        if emb is None:
            return  # embedding unavailable — skip; keyword search still works via JSONL

        self._ensure_index()
        self._entries.append(entry)
        if self._embeddings is None:
            self._embeddings = emb[np.newaxis, :]
        else:
            self._embeddings = np.vstack([self._embeddings, emb])
        self._save_index()

    # ── internals ─────────────────────────────────────────────────────────────

    def _ensure_index(self) -> None:
        if self._embeddings is not None:
            return
        if self._index_path.exists() and self._meta_path.exists():
            self._embeddings = np.load(str(self._index_path))
            self._entries = json.loads(self._meta_path.read_text())
        else:
            self._build_index()

    def _build_index(self) -> None:
        if not self.log_path.exists():
            return
        embeddings, entries = [], []
        with self.log_path.open(encoding="utf-8") as f:
            for line in f:
                rec = json.loads(line)
                emb = _get_embedding(rec.get("content", ""))
                if emb is not None:
                    embeddings.append(emb)
                    entries.append({"role": rec["role"], "content": rec["content"], "ts": rec["ts"]})
        if embeddings:
            self._embeddings = np.vstack(embeddings)
            self._entries = entries
            self._save_index()

    def _save_index(self) -> None:
        if self._embeddings is not None:
            np.save(str(self._index_path), self._embeddings)
            self._meta_path.write_text(json.dumps(self._entries))

    def _keyword_fallback(self, query: str, top_k: int) -> list[dict]:
        if not self.log_path.exists():
            return []
        q = query.lower()
        results: list[dict] = []
        with self.log_path.open(encoding="utf-8") as f:
            for line in f:
                rec = json.loads(line)
                if q in rec.get("content", "").lower():
                    results.append({"role": rec["role"], "content": rec["content"], "ts": rec["ts"], "score": None})
                    if len(results) >= top_k:
                        break
        return results

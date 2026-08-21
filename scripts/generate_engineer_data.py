"""
Generate synthetic fine-tuning data for Anthos Engineer LoRA.

Produces JSONL in ChatML format matching the exact prompt templates
used by agent.py (classify_intent, plan, _write_file).

Usage:
    python scripts/generate_engineer_data.py --out data/engineer_train.jsonl
    python scripts/generate_engineer_data.py --out data/engineer_train.jsonl --n 2000
"""

import argparse
import json
import random
from pathlib import Path


SYSTEM = (
    "You are Anthos Engineer, an expert agentic coding system. "
    "You plan, write, and execute code to accomplish user goals. "
    "You produce clean, production-ready Python unless another language is specified."
)

# ── Intent classification ─────────────────────────────────────────────────────

BUILD_MESSAGES = [
    "build a REST API with FastAPI",
    "create a web scraper for news headlines",
    "write a CLI tool to rename files in bulk",
    "make a Discord bot that replies to !help",
    "build a CSV to JSON converter",
    "write a script that watches a folder and runs a command when files change",
    "create a simple key-value store backed by a JSON file",
    "build a port scanner",
    "write a Markdown to HTML converter",
    "create a URL shortener with SQLite",
    "build a task queue using Redis",
    "write a script to back up a PostgreSQL database",
    "make a simple HTTP proxy",
    "create a password generator with configurable length and symbols",
    "build a rate limiter middleware for FastAPI",
    "write a file encryption tool using AES",
    "create a log parser that extracts errors and writes them to a report",
    "build a simple static site generator",
    "write a Python script that sends a daily email digest",
    "create a CLI todo app with sqlite",
    "build a webhook receiver that logs payloads to a file",
    "write a script to resize all images in a directory",
    "create a Dockerfile for a Python FastAPI app",
    "build a simple pub/sub system using ZeroMQ",
    "write a GitHub Actions workflow to run tests on push",
    "create a script that monitors CPU and memory and alerts when thresholds are exceeded",
    "build a basic JWT auth system",
    "write a function to retry HTTP requests with exponential backoff",
    "create a YAML config loader with schema validation",
    "build a command-line diff viewer",
    "write a script to generate a sitemap from a list of URLs",
    "create a mock HTTP server for testing",
    "build a simple neural network from scratch with numpy",
    "write a script to download and cache API responses",
    "create a cron job manager in Python",
    "build a socket chat server",
    "write a script to find duplicate files by hash",
    "create a type-safe settings manager using Pydantic",
    "build a simple ORM for SQLite",
    "write a data pipeline that reads from CSV, transforms, and writes to Parquet",
    "I want a script that detects the language of a text string",
    "can you make a basic event emitter class",
    "I need a tool to validate JSON schemas",
    "automate screenshot comparison for regression testing",
    "write a script that converts between time zones",
    "build me a dependency graph visualizer",
]

CHAT_MESSAGES = [
    "hello",
    "hi there",
    "what can you do?",
    "what is Python?",
    "how does a hash map work?",
    "what's the difference between a list and a tuple?",
    "explain async/await to me",
    "what is a REST API?",
    "how do I use git?",
    "what is Docker?",
    "tell me about yourself",
    "good morning",
    "thanks",
    "what models can you use?",
    "how do I install Python?",
    "what is object-oriented programming?",
    "explain recursion",
    "what is a closure?",
    "what's new in Python 3.12?",
    "can you explain what a decorator does?",
    "what is the difference between SQL and NoSQL?",
    "how does the internet work?",
    "what is machine learning?",
    "explain TCP vs UDP",
    "what is a deadlock?",
    "how does garbage collection work?",
    "what is idempotency?",
    "hey",
    "who made you?",
    "what is Anthos?",
    "nice work",
    "that looks good",
    "what language should I learn first?",
    "explain big O notation",
]

CLASSIFY_PROMPT = (
    'Classify this user message. Reply with exactly one word: "build" or "chat".\n\n'
    '"build" = the user wants to create, code, build, fix, or automate something technical.\n'
    '"chat" = the user is greeting, asking a question, or having a conversation.\n\n'
    "Message: {msg}\n\n"
    'Reply with only "build" or "chat":'
)


def make_classify_examples(n: int) -> list[dict]:
    examples = []
    half = n // 2
    for msg in random.choices(BUILD_MESSAGES, k=half):
        examples.append(_msg(CLASSIFY_PROMPT.format(msg=msg), "build"))
    for msg in random.choices(CHAT_MESSAGES, k=n - half):
        examples.append(_msg(CLASSIFY_PROMPT.format(msg=msg), "chat"))
    random.shuffle(examples)
    return examples


# ── Planning ──────────────────────────────────────────────────────────────────

PLAN_PROMPT = (
    "You are Anthos Engineer, an expert agentic coding system.\n"
    "Create a detailed step-by-step plan to accomplish this goal:\n\n"
    "GOAL: {goal}\n\n"
    "Return ONLY a valid JSON array. Each item must have exactly these fields:\n"
    '- "action": one of "write" | "run_command" | "install" | "read"\n'
    '- "target": file path (for write/read) or shell command (for run_command) or package name (for install)\n'
    '- "description": what this step does\n\n'
    "Return ONLY the JSON array, nothing else."
)

PLANS: list[tuple[str, list[dict]]] = [
    (
        "build a FastAPI REST API with a /health endpoint",
        [
            {"action": "install", "target": "fastapi uvicorn", "description": "Install FastAPI and ASGI server"},
            {"action": "write", "target": "main.py", "description": "Create FastAPI app with /health endpoint"},
            {"action": "run_command", "target": "uvicorn main:app --port 8000 &", "description": "Start the server"},
            {"action": "run_command", "target": "curl http://localhost:8000/health", "description": "Verify health endpoint responds"},
        ],
    ),
    (
        "create a CLI tool to convert CSV files to JSON",
        [
            {"action": "write", "target": "csv_to_json.py", "description": "CLI that reads CSV and writes JSON using argparse"},
            {"action": "write", "target": "sample.csv", "description": "Sample CSV for testing"},
            {"action": "run_command", "target": "python csv_to_json.py sample.csv output.json", "description": "Test conversion"},
            {"action": "run_command", "target": "cat output.json", "description": "Verify JSON output"},
        ],
    ),
    (
        "build a web scraper that fetches the top 10 Hacker News titles",
        [
            {"action": "install", "target": "httpx beautifulsoup4", "description": "Install HTTP client and HTML parser"},
            {"action": "write", "target": "scraper.py", "description": "Fetch HN front page and extract story titles"},
            {"action": "run_command", "target": "python scraper.py", "description": "Run the scraper and print titles"},
        ],
    ),
    (
        "write a script to find and delete duplicate files by MD5 hash",
        [
            {"action": "write", "target": "dedupe.py", "description": "Walk directory, hash files, collect duplicates, delete extras"},
            {"action": "run_command", "target": "python dedupe.py --dry-run .", "description": "Preview which duplicates would be removed"},
        ],
    ),
    (
        "create a SQLite-backed todo CLI app",
        [
            {"action": "write", "target": "todo.py", "description": "Todo CLI with add/list/done/delete commands backed by SQLite"},
            {"action": "run_command", "target": 'python todo.py add "Buy groceries"', "description": "Add a todo item"},
            {"action": "run_command", "target": "python todo.py list", "description": "List all todos"},
            {"action": "run_command", "target": "python todo.py done 1", "description": "Mark item 1 done"},
        ],
    ),
    (
        "build a password generator CLI with configurable length and character sets",
        [
            {"action": "write", "target": "passgen.py", "description": "CLI password generator with --length, --symbols, --digits flags"},
            {"action": "run_command", "target": "python passgen.py --length 20 --symbols", "description": "Generate a 20-char password with symbols"},
        ],
    ),
    (
        "create a rate limiter using a token bucket algorithm",
        [
            {"action": "write", "target": "rate_limiter.py", "description": "TokenBucket class with consume() and is_allowed() methods"},
            {"action": "write", "target": "test_rate_limiter.py", "description": "Tests for rate limiter: burst, steady, rejection"},
            {"action": "run_command", "target": "python -m pytest test_rate_limiter.py -v", "description": "Run tests"},
        ],
    ),
    (
        "write a file watcher that runs a command when Python files change",
        [
            {"action": "install", "target": "watchdog", "description": "Install file system event library"},
            {"action": "write", "target": "watcher.py", "description": "Watch directory for .py changes and run configurable command"},
            {"action": "run_command", "target": "python watcher.py . 'python -m pytest'", "description": "Start watcher running pytest on changes"},
        ],
    ),
    (
        "build a simple HTTP proxy server",
        [
            {"action": "write", "target": "proxy.py", "description": "HTTP proxy using http.server that forwards requests and returns responses"},
            {"action": "run_command", "target": "python proxy.py --port 8888 &", "description": "Start proxy on port 8888"},
            {"action": "run_command", "target": "curl --proxy http://localhost:8888 http://example.com", "description": "Test the proxy"},
        ],
    ),
    (
        "create a Pydantic settings manager that loads from .env and validates types",
        [
            {"action": "install", "target": "pydantic-settings python-dotenv", "description": "Install Pydantic settings and dotenv"},
            {"action": "write", "target": ".env.example", "description": "Example .env with required and optional keys"},
            {"action": "write", "target": "config.py", "description": "Settings class with typed fields, validators, and .env loading"},
            {"action": "run_command", "target": "python -c 'from config import settings; print(settings)'", "description": "Verify settings load correctly"},
        ],
    ),
    (
        "write a retry decorator with exponential backoff for HTTP requests",
        [
            {"action": "write", "target": "retry.py", "description": "retry_with_backoff decorator: max_attempts, base_delay, jitter, exception filter"},
            {"action": "write", "target": "test_retry.py", "description": "Tests: successful call, eventual success, max retries exceeded"},
            {"action": "run_command", "target": "python -m pytest test_retry.py -v", "description": "Run tests"},
        ],
    ),
    (
        "build a port scanner that checks common ports on a host",
        [
            {"action": "write", "target": "scanner.py", "description": "Async port scanner using asyncio with configurable port range and timeout"},
            {"action": "run_command", "target": "python scanner.py localhost --ports 22,80,443,8080", "description": "Scan localhost common ports"},
        ],
    ),
    (
        "create a log parser that extracts ERROR lines and writes a summary report",
        [
            {"action": "write", "target": "log_parser.py", "description": "Read log file, extract ERROR lines, count by type, write markdown report"},
            {"action": "write", "target": "sample.log", "description": "Sample log file with INFO, WARNING, and ERROR entries"},
            {"action": "run_command", "target": "python log_parser.py sample.log report.md", "description": "Parse log and generate report"},
            {"action": "run_command", "target": "cat report.md", "description": "Verify report content"},
        ],
    ),
    (
        "build a basic JWT authentication system with sign and verify functions",
        [
            {"action": "install", "target": "pyjwt cryptography", "description": "Install JWT library"},
            {"action": "write", "target": "auth.py", "description": "sign_token() and verify_token() with HS256, expiry, and payload validation"},
            {"action": "write", "target": "test_auth.py", "description": "Tests: valid token, expired token, tampered token"},
            {"action": "run_command", "target": "python -m pytest test_auth.py -v", "description": "Run auth tests"},
        ],
    ),
    (
        "create a simple event emitter with on(), off(), and emit() methods",
        [
            {"action": "write", "target": "emitter.py", "description": "EventEmitter class: on/off/emit, supports multiple listeners per event"},
            {"action": "write", "target": "test_emitter.py", "description": "Tests: single listener, multiple listeners, off() removes correctly"},
            {"action": "run_command", "target": "python -m pytest test_emitter.py -v", "description": "Run tests"},
        ],
    ),
]

PLAN_VARIATIONS = [
    "build a FastAPI health check endpoint",
    "write a script to back up files to a timestamped directory",
    "create a CLI that reads stdin and counts word frequencies",
    "build a Markdown to HTML converter",
    "write a script that monitors a URL and sends an alert if it goes down",
    "create a JSON schema validator CLI",
    "build a simple bloom filter implementation",
    "write a script to generate fake test data as CSV",
    "create a thread-safe LRU cache",
    "build a script that diffs two directories and reports differences",
]


def make_plan_examples(n: int) -> list[dict]:
    examples = []
    for goal, plan in random.choices(PLANS, k=n):
        prompt = PLAN_PROMPT.format(goal=goal)
        examples.append(_msg(prompt, json.dumps(plan, indent=2)))
    return examples


# ── Code generation ───────────────────────────────────────────────────────────

CODEGEN_PROMPT = (
    "Write complete, working code for this file.\n\n"
    "Goal: {goal}\n"
    "File: {path}\n"
    "Purpose: {purpose}\n\n"
    "Requirements:\n"
    "- Include all imports\n"
    "- Add error handling where appropriate\n"
    "- Make it production-ready\n"
    "- Return ONLY the code, no explanations or markdown fences"
)

CODE_EXAMPLES: list[tuple[str, str, str, str]] = [
    # (goal, path, purpose, code)
    (
        "CLI tool to convert CSV files to JSON",
        "csv_to_json.py",
        "CLI that reads a CSV file and writes JSON using argparse",
        '''\
import argparse
import csv
import json
import sys
from pathlib import Path


def csv_to_json(input_path: str, output_path: str | None) -> None:
    path = Path(input_path)
    if not path.exists():
        print(f"Error: {input_path} not found", file=sys.stderr)
        sys.exit(1)

    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    result = json.dumps(rows, indent=2, ensure_ascii=False)

    if output_path:
        Path(output_path).write_text(result, encoding="utf-8")
        print(f"Wrote {len(rows)} records to {output_path}")
    else:
        print(result)


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert CSV to JSON")
    parser.add_argument("input", help="Input CSV file path")
    parser.add_argument("output", nargs="?", help="Output JSON file (stdout if omitted)")
    args = parser.parse_args()
    csv_to_json(args.input, args.output)


if __name__ == "__main__":
    main()
''',
    ),
    (
        "password generator CLI",
        "passgen.py",
        "Generate random passwords with configurable length and character sets",
        '''\
import argparse
import secrets
import string


def generate_password(length: int, use_symbols: bool, use_digits: bool) -> str:
    chars = string.ascii_letters
    if use_digits:
        chars += string.digits
    if use_symbols:
        chars += string.punctuation
    return "".join(secrets.choice(chars) for _ in range(length))


def main() -> None:
    parser = argparse.ArgumentParser(description="Secure password generator")
    parser.add_argument("--length", type=int, default=16, help="Password length (default: 16)")
    parser.add_argument("--symbols", action="store_true", help="Include symbols")
    parser.add_argument("--no-digits", action="store_true", help="Exclude digits")
    parser.add_argument("--count", type=int, default=1, help="Number of passwords to generate")
    args = parser.parse_args()

    if args.length < 8:
        print("Warning: passwords shorter than 8 characters are insecure")

    for _ in range(args.count):
        print(generate_password(args.length, args.symbols, not args.no_digits))


if __name__ == "__main__":
    main()
''',
    ),
    (
        "SQLite-backed todo CLI",
        "todo.py",
        "Todo app with add/list/done/delete commands backed by SQLite",
        '''\
import argparse
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path.home() / ".todo.db"


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS todos "
        "(id INTEGER PRIMARY KEY, text TEXT NOT NULL, done INTEGER DEFAULT 0)"
    )
    conn.commit()
    return conn


def cmd_add(text: str) -> None:
    with get_conn() as conn:
        conn.execute("INSERT INTO todos (text) VALUES (?)", (text,))
    print(f"Added: {text}")


def cmd_list() -> None:
    with get_conn() as conn:
        rows = conn.execute("SELECT id, text, done FROM todos ORDER BY id").fetchall()
    if not rows:
        print("No todos.")
        return
    for id_, text, done in rows:
        status = "x" if done else " "
        print(f"[{status}] {id_}. {text}")


def cmd_done(id_: int) -> None:
    with get_conn() as conn:
        cur = conn.execute("UPDATE todos SET done=1 WHERE id=?", (id_,))
    if cur.rowcount == 0:
        print(f"No todo with id {id_}", file=sys.stderr)
        sys.exit(1)
    print(f"Marked {id_} done.")


def cmd_delete(id_: int) -> None:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM todos WHERE id=?", (id_,))
    if cur.rowcount == 0:
        print(f"No todo with id {id_}", file=sys.stderr)
        sys.exit(1)
    print(f"Deleted {id_}.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Todo CLI")
    sub = parser.add_subparsers(dest="cmd")

    add_p = sub.add_parser("add")
    add_p.add_argument("text")

    sub.add_parser("list")

    done_p = sub.add_parser("done")
    done_p.add_argument("id", type=int)

    del_p = sub.add_parser("delete")
    del_p.add_argument("id", type=int)

    args = parser.parse_args()
    if args.cmd == "add":
        cmd_add(args.text)
    elif args.cmd == "list":
        cmd_list()
    elif args.cmd == "done":
        cmd_done(args.id)
    elif args.cmd == "delete":
        cmd_delete(args.id)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
''',
    ),
    (
        "rate limiter with token bucket algorithm",
        "rate_limiter.py",
        "TokenBucket class with consume() and is_allowed() methods",
        '''\
import time
import threading


class TokenBucket:
    """Thread-safe token bucket rate limiter."""

    def __init__(self, rate: float, capacity: float) -> None:
        self.rate = rate          # tokens added per second
        self.capacity = capacity  # max tokens
        self._tokens = capacity
        self._last_refill = time.monotonic()
        self._lock = threading.Lock()

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_refill
        self._tokens = min(self.capacity, self._tokens + elapsed * self.rate)
        self._last_refill = now

    def consume(self, tokens: float = 1.0) -> bool:
        with self._lock:
            self._refill()
            if self._tokens >= tokens:
                self._tokens -= tokens
                return True
            return False

    def is_allowed(self) -> bool:
        return self.consume(1.0)

    @property
    def available(self) -> float:
        with self._lock:
            self._refill()
            return self._tokens
''',
    ),
    (
        "retry decorator with exponential backoff",
        "retry.py",
        "retry_with_backoff decorator: max_attempts, base_delay, jitter, exception filter",
        '''\
import functools
import random
import time
from typing import Callable, Type


def retry_with_backoff(
    max_attempts: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 60.0,
    jitter: bool = True,
    exceptions: tuple[Type[Exception], ...] = (Exception,),
) -> Callable:
    """Decorator that retries a function with exponential backoff on failure."""

    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            last_exc: Exception | None = None
            for attempt in range(1, max_attempts + 1):
                try:
                    return func(*args, **kwargs)
                except exceptions as exc:
                    last_exc = exc
                    if attempt == max_attempts:
                        break
                    delay = min(base_delay * (2 ** (attempt - 1)), max_delay)
                    if jitter:
                        delay *= (0.5 + random.random() * 0.5)
                    time.sleep(delay)
            raise last_exc  # type: ignore[misc]

        return wrapper

    return decorator
''',
    ),
    (
        "simple event emitter",
        "emitter.py",
        "EventEmitter class: on/off/emit, supports multiple listeners per event",
        '''\
from collections import defaultdict
from typing import Callable, Any


class EventEmitter:
    def __init__(self) -> None:
        self._listeners: dict[str, list[Callable]] = defaultdict(list)

    def on(self, event: str, listener: Callable) -> "EventEmitter":
        self._listeners[event].append(listener)
        return self

    def off(self, event: str, listener: Callable) -> "EventEmitter":
        try:
            self._listeners[event].remove(listener)
        except ValueError:
            pass
        return self

    def emit(self, event: str, *args: Any, **kwargs: Any) -> bool:
        listeners = self._listeners.get(event, [])
        for listener in list(listeners):
            listener(*args, **kwargs)
        return bool(listeners)

    def once(self, event: str, listener: Callable) -> "EventEmitter":
        def wrapper(*args, **kwargs):
            self.off(event, wrapper)
            listener(*args, **kwargs)
        return self.on(event, wrapper)
''',
    ),
    (
        "JWT authentication module",
        "auth.py",
        "sign_token() and verify_token() with HS256, expiry, and payload validation",
        '''\
import time
from typing import Any

import jwt


SECRET_KEY = "change-me-in-production"
ALGORITHM = "HS256"
DEFAULT_EXPIRY = 3600  # seconds


def sign_token(payload: dict[str, Any], expiry_seconds: int = DEFAULT_EXPIRY) -> str:
    claims = {
        **payload,
        "iat": int(time.time()),
        "exp": int(time.time()) + expiry_seconds,
    }
    return jwt.encode(claims, SECRET_KEY, algorithm=ALGORITHM)


def verify_token(token: str) -> dict[str, Any]:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise ValueError("Token has expired")
    except jwt.InvalidTokenError as exc:
        raise ValueError(f"Invalid token: {exc}") from exc
''',
    ),
    (
        "FastAPI REST API with health endpoint",
        "main.py",
        "FastAPI app with /health endpoint and structured startup",
        '''\
from fastapi import FastAPI
from pydantic import BaseModel
import time

app = FastAPI(title="Anthos Service", version="1.0.0")
_start_time = time.time()


class HealthResponse(BaseModel):
    status: str
    uptime_seconds: float
    version: str


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        uptime_seconds=round(time.time() - _start_time, 2),
        version="1.0.0",
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
''',
    ),
    (
        "thread-safe LRU cache",
        "lru_cache.py",
        "LRU cache with get/put and configurable capacity, thread-safe",
        '''\
import threading
from collections import OrderedDict
from typing import Generic, TypeVar

K = TypeVar("K")
V = TypeVar("V")


class LRUCache(Generic[K, V]):
    def __init__(self, capacity: int) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self.capacity = capacity
        self._cache: OrderedDict[K, V] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: K) -> V | None:
        with self._lock:
            if key not in self._cache:
                return None
            self._cache.move_to_end(key)
            return self._cache[key]

    def put(self, key: K, value: V) -> None:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
            self._cache[key] = value
            if len(self._cache) > self.capacity:
                self._cache.popitem(last=False)

    def __len__(self) -> int:
        with self._lock:
            return len(self._cache)
''',
    ),
    (
        "web scraper for Hacker News titles",
        "scraper.py",
        "Fetch HN front page and extract the top story titles",
        '''\
import httpx
from bs4 import BeautifulSoup


HN_URL = "https://news.ycombinator.com/"


def fetch_top_stories(n: int = 10) -> list[str]:
    response = httpx.get(HN_URL, timeout=10)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")
    titles = [
        a.get_text(strip=True)
        for a in soup.select(".titleline > a")
    ]
    return titles[:n]


if __name__ == "__main__":
    for i, title in enumerate(fetch_top_stories(), 1):
        print(f"{i:2}. {title}")
''',
    ),
    (
        "Pydantic settings manager with .env loading",
        "config.py",
        "Settings class with typed fields, validators, and .env loading",
        '''\
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    app_name: str = Field(default="anthos-engineer", description="Application name")
    debug: bool = Field(default=False, description="Enable debug mode")
    port: int = Field(default=8000, ge=1, le=65535, description="Server port")
    secret_key: str = Field(..., description="Secret key for signing tokens")
    database_url: str = Field(default="sqlite:///./app.db", description="Database URL")
    max_workers: int = Field(default=4, ge=1, le=32)

    @field_validator("secret_key")
    @classmethod
    def validate_secret_key(cls, v: str) -> str:
        if len(v) < 32:
            raise ValueError("secret_key must be at least 32 characters")
        return v


settings = Settings()
''',
    ),
    (
        "async port scanner",
        "scanner.py",
        "Async port scanner using asyncio with configurable port list and timeout",
        '''\
import argparse
import asyncio
import sys


async def check_port(host: str, port: int, timeout: float) -> tuple[int, bool]:
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=timeout
        )
        writer.close()
        await writer.wait_closed()
        return port, True
    except (asyncio.TimeoutError, ConnectionRefusedError, OSError):
        return port, False


async def scan(host: str, ports: list[int], timeout: float) -> dict[int, bool]:
    tasks = [check_port(host, p, timeout) for p in ports]
    results = await asyncio.gather(*tasks)
    return dict(results)


def parse_ports(spec: str) -> list[int]:
    ports: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            start, end = part.split("-", 1)
            ports.extend(range(int(start), int(end) + 1))
        else:
            ports.append(int(part))
    return sorted(set(ports))


def main() -> None:
    parser = argparse.ArgumentParser(description="Async port scanner")
    parser.add_argument("host", help="Target host")
    parser.add_argument("--ports", default="22,80,443,8080,8443,3000,5432", help="Comma-separated ports or ranges")
    parser.add_argument("--timeout", type=float, default=1.0, help="Timeout per port in seconds")
    args = parser.parse_args()

    ports = parse_ports(args.ports)
    print(f"Scanning {args.host} ({len(ports)} ports)...")
    results = asyncio.run(scan(args.host, ports, args.timeout))

    open_ports = [p for p, open_ in sorted(results.items()) if open_]
    if open_ports:
        for p in open_ports:
            print(f"  OPEN  {p}")
    else:
        print("  No open ports found.")


if __name__ == "__main__":
    main()
''',
    ),
]


def make_codegen_examples(n: int) -> list[dict]:
    examples = []
    for goal, path, purpose, code in random.choices(CODE_EXAMPLES, k=n):
        prompt = CODEGEN_PROMPT.format(goal=goal, path=path, purpose=purpose)
        examples.append(_msg(prompt, code.rstrip()))
    return examples


# ── Error correction ──────────────────────────────────────────────────────────

ERROR_PROMPT = (
    "The previous step failed. Fix the code to resolve this error.\n\n"
    "Goal: {goal}\n"
    "File: {path}\n"
    "Error output:\n{error}\n\n"
    "Previous code:\n{old_code}\n\n"
    "Return ONLY the corrected code, no explanations:"
)

ERROR_EXAMPLES: list[tuple[str, str, str, str, str]] = [
    (
        "CSV to JSON converter",
        "csv_to_json.py",
        "ModuleNotFoundError: No module named 'csv'\nWait — csv is stdlib. Actually: AttributeError: 'DictReader' object has no attribute 'fieldnames' before reading",
        '''\
import csv, json, sys
r = csv.DictReader(open(sys.argv[1]))
print(r.fieldnames)
print(json.dumps(list(r)))
''',
        '''\
import csv
import json
import sys
from pathlib import Path


def main() -> None:
    path = Path(sys.argv[1])
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)  # consume iterator before accessing fieldnames
    print(json.dumps(rows, indent=2))


if __name__ == "__main__":
    main()
''',
    ),
    (
        "rate limiter",
        "rate_limiter.py",
        "TypeError: unsupported operand type(s) for +=: 'float' and 'NoneType'\nTraceback points to self._tokens += elapsed * self.rate",
        '''\
import time

class TokenBucket:
    def __init__(self, rate, capacity):
        self.rate = rate
        self.capacity = capacity
        self._tokens = None  # bug: should be capacity
        self._last = time.monotonic()

    def consume(self):
        now = time.monotonic()
        self._tokens += (now - self._last) * self.rate
        self._last = now
        if self._tokens >= 1:
            self._tokens -= 1
            return True
        return False
''',
        '''\
import time
import threading


class TokenBucket:
    def __init__(self, rate: float, capacity: float) -> None:
        self.rate = rate
        self.capacity = capacity
        self._tokens = float(capacity)  # initialize to full capacity
        self._last = time.monotonic()
        self._lock = threading.Lock()

    def consume(self, tokens: float = 1.0) -> bool:
        with self._lock:
            now = time.monotonic()
            self._tokens = min(self.capacity, self._tokens + (now - self._last) * self.rate)
            self._last = now
            if self._tokens >= tokens:
                self._tokens -= tokens
                return True
            return False
''',
    ),
    (
        "port scanner",
        "scanner.py",
        "SyntaxError: invalid syntax at 'async def' — Python version is 3.9, union type hints need 'from __future__ import annotations'",
        '''\
async def check_port(host: str, port: int, timeout: float) -> tuple[int, bool]:
    try:
        _, writer = await asyncio.open_connection(host, port)
        writer.close()
        return port, True
    except:
        return port, False
''',
        '''\
from __future__ import annotations
import asyncio
from typing import Optional


async def check_port(host: str, port: int, timeout: float) -> tuple[int, bool]:
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=timeout
        )
        writer.close()
        await writer.wait_closed()
        return port, True
    except (asyncio.TimeoutError, ConnectionRefusedError, OSError):
        return port, False
''',
    ),
    (
        "JWT auth module",
        "auth.py",
        "ImportError: cannot import name 'encode' from 'jwt' — installed PyJWT < 2.0 which has different API",
        '''\
import jwt

def sign_token(payload, secret):
    return jwt.encode(payload, secret, algorithm="HS256")

def verify_token(token, secret):
    return jwt.decode(token, secret, algorithms=["HS256"])
''',
        '''\
import time
from typing import Any

try:
    import jwt
except ImportError:
    raise ImportError("Run: pip install PyJWT>=2.0")


SECRET_KEY = "change-me-in-production"
ALGORITHM = "HS256"


def sign_token(payload: dict[str, Any], expiry_seconds: int = 3600, secret: str = SECRET_KEY) -> str:
    claims = {**payload, "iat": int(time.time()), "exp": int(time.time()) + expiry_seconds}
    token = jwt.encode(claims, secret, algorithm=ALGORITHM)
    # PyJWT >= 2.0 returns str; older versions return bytes
    return token if isinstance(token, str) else token.decode("utf-8")


def verify_token(token: str, secret: str = SECRET_KEY) -> dict[str, Any]:
    try:
        return jwt.decode(token, secret, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise ValueError("Token has expired")
    except jwt.InvalidTokenError as exc:
        raise ValueError(f"Invalid token: {exc}") from exc
''',
    ),
]


def make_error_examples(n: int) -> list[dict]:
    examples = []
    for goal, path, error, old_code, fixed_code in random.choices(ERROR_EXAMPLES, k=n):
        prompt = ERROR_PROMPT.format(goal=goal, path=path, error=error, old_code=old_code)
        examples.append(_msg(prompt, fixed_code.rstrip()))
    return examples


# ── Helpers ───────────────────────────────────────────────────────────────────

def _msg(user: str, assistant: str) -> dict:
    return {
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": user},
            {"role": "assistant", "content": assistant},
        ]
    }


def build_dataset(n: int) -> list[dict]:
    classify = make_classify_examples(n // 4)
    plan = make_plan_examples(n // 4)
    codegen = make_codegen_examples(n // 3)
    error = make_error_examples(n - len(classify) - len(plan) - len(codegen))
    all_examples = classify + plan + codegen + error
    random.shuffle(all_examples)
    return all_examples


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Anthos Engineer LoRA training data")
    parser.add_argument("--out", default="data/engineer_train.jsonl", help="Output JSONL path")
    parser.add_argument("--n", type=int, default=1500, help="Total examples to generate")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    random.seed(args.seed)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    examples = build_dataset(args.n)
    with out.open("w", encoding="utf-8") as f:
        for ex in examples:
            f.write(json.dumps(ex) + "\n")

    print(f"Wrote {len(examples)} examples → {out}")
    counts = {
        "classify": sum(1 for e in examples if "Reply with only" in e["messages"][1]["content"]),
        "plan":     sum(1 for e in examples if "JSON array" in e["messages"][1]["content"]),
        "codegen":  sum(1 for e in examples if "Return ONLY the code" in e["messages"][1]["content"] and "Error output" not in e["messages"][1]["content"]),
        "error":    sum(1 for e in examples if "Error output" in e["messages"][1]["content"]),
    }
    for k, v in counts.items():
        print(f"  {k:10} {v:4}")


if __name__ == "__main__":
    main()

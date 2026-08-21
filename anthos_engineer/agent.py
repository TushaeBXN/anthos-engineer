"""Anthos Engineer — agentic coding system powered by local Ollama models."""

import ast
import json
import os
import subprocess
import tempfile
from pathlib import Path

import httpx

from anthos_engineer.session import Session
from anthos_engineer.compaction import CompactionEngine


OLLAMA_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
DEFAULT_MODEL = os.environ.get("ANTHOS_MODEL", "amy")

_MAX_RETRIES = 2


def _call_ollama(prompt: str, model: str = DEFAULT_MODEL, system: str | None = None) -> str:
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    payload = {"model": model, "messages": messages, "stream": False}
    resp = httpx.post(f"{OLLAMA_URL}/v1/chat/completions", json=payload, timeout=120)
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


_HISTORY_PHRASES = (
    "look in", "search history", "search session", "find in logs",
    "previous session", "remember when", "remember about", "from the logs",
)
_FOLLOWUP_WORDS = {"it", "that", "this", "the same", "fix it", "make it", "also", "then"}


def classify_intent(goal: str, model: str = DEFAULT_MODEL) -> str:
    """Kept for backwards-compat — returns the primary type string."""
    return detect_intent(goal, model)["type"]


def detect_intent(goal: str, model: str = DEFAULT_MODEL, recent_context: list[dict] | None = None) -> dict:
    """Return a richer intent dict: {type, is_followup, search_query}.

    type is one of: build | chat | debug | modify | explain | search_history
    """
    low = goal.lower()

    # History search — check before calling the model (cheap heuristic)
    if any(p in low for p in _HISTORY_PHRASES):
        import re
        q = re.search(r'"([^"]+)"', goal)
        query = q.group(1) if q else goal
        return {"type": "search_history", "is_followup": False, "search_query": query}

    # Follow-up detection — short message that refers to prior output
    words = set(low.split())
    is_followup = bool(recent_context) and (len(goal.split()) < 12 or bool(words & _FOLLOWUP_WORDS))

    prompt = f"""Classify this user message into exactly one category. Reply with one word only.

Categories:
- build    : create a new file, project, script, or feature from scratch
- modify   : change, update, refactor, or extend existing code
- debug    : fix a bug, error, crash, or unexpected behaviour
- explain  : explain, describe, or answer a conceptual question about code
- chat     : greeting, small talk, or off-topic question

Message: {goal}

Reply with only one of: build modify debug explain chat"""
    raw = _call_ollama(prompt, model).strip().lower().split()[0]
    valid = {"build", "modify", "debug", "explain", "chat"}
    intent_type = raw if raw in valid else "build"

    return {"type": intent_type, "is_followup": is_followup, "search_query": None}


def _extract_json(text: str) -> list | dict:
    start = text.find("[") if "[" in text else text.find("{")
    end = text.rfind("]") + 1 if "[" in text else text.rfind("}") + 1
    if start == -1 or end == 0:
        raise ValueError("No JSON found in response")
    return json.loads(text[start:end])


class AnthosEngineer:
    def __init__(
        self,
        workspace: str | None = None,
        model: str = DEFAULT_MODEL,
        session_id: str | None = None,
        generate_tests: bool = False,
    ) -> None:
        self.model = model
        self.generate_tests = generate_tests
        self.workspace = Path(workspace or tempfile.mkdtemp(prefix="anthos-"))
        self.workspace.mkdir(parents=True, exist_ok=True)

        import uuid
        self.session = Session(session_id or str(uuid.uuid4()), self.workspace)
        self.compaction = CompactionEngine(OLLAMA_URL, model)
        self._context: list[dict] = []

    # ── context helpers ───────────────────────────────────────────────────────

    def _chat(self, user_content: str, system: str | None = None) -> str:
        """Send a message using accumulated context, compact if needed, return reply."""
        if system and not self._context:
            self._context.append({"role": "system", "content": system})
        self._context.append({"role": "user", "content": user_content})
        self._context = self.compaction.maybe_compact(self._context)

        payload = {"model": self.model, "messages": self._context, "stream": False}
        resp = httpx.post(f"{OLLAMA_URL}/v1/chat/completions", json=payload, timeout=120)
        resp.raise_for_status()
        reply = resp.json()["choices"][0]["message"]["content"]

        self._context.append({"role": "assistant", "content": reply})
        return reply

    # ── plan / execute ────────────────────────────────────────────────────────

    def plan(self, goal: str, intent: dict | None = None) -> list[dict]:
        self.session.append("user", goal, {"type": "goal", "intent": (intent or {}).get("type")})

        # Inject recent session excerpts when this looks like a follow-up
        context_block = ""
        if intent and intent.get("is_followup") and self._context:
            recent = self._context[-4:]  # last 2 exchanges
            excerpts = "\n".join(
                f"{m['role']}: {m['content'][:200]}" for m in recent
            )
            context_block = f"\nRecent session context:\n{excerpts}\n"

        # Tailor the planning instruction to the intent type
        intent_type = (intent or {}).get("type", "build")
        instruction_map = {
            "modify":  "Modify existing code to accomplish the goal. Prefer targeted edits over rewrites.",
            "debug":   "Diagnose and fix the described problem. Include a step to reproduce before fixing.",
            "explain": "Write a brief explanation script or markdown file covering the requested topic.",
            "build":   "Build a complete solution from scratch.",
        }
        instruction = instruction_map.get(intent_type, instruction_map["build"])

        prompt = f"""You are Anthos Engineer, an expert agentic coding system.
{instruction}
{context_block}
GOAL: {goal}

Return ONLY a valid JSON array. Each item must have exactly these fields:
- "action": one of "write" | "run_command" | "install" | "read"
- "target": file path (for write/read) or shell command (for run_command) or package name (for install)
- "description": what this step does

Return ONLY the JSON array, nothing else."""
        raw = self._chat(prompt, system="You are Anthos Engineer, an expert agentic coding system.")
        self.session.append("assistant", raw, {"type": "plan"})
        try:
            plan = _extract_json(raw)
            if not isinstance(plan, list):
                plan = [plan]
            return plan
        except Exception:
            return [{"action": "write", "target": "solution.py", "description": f"Implement: {goal}"}]

    def execute_step(self, step: dict, goal: str) -> dict:
        action = step.get("action", "")
        target = step.get("target", "")

        if action == "write":
            result = self._write_file(target, step.get("description", ""), goal)
        elif action == "run_command":
            result = self._run_command(target)
            # retry loop: if command fails, ask the model to fix it
            if not result["success"]:
                result = self._retry_command(step, result["output"], goal)
        elif action == "install":
            result = self._install(target)
        elif action == "read":
            result = self._read_file(target)
        else:
            result = {"success": False, "output": f"Unknown action: {action}"}

        self.session.append(
            "tool",
            result["output"],
            {"action": action, "target": target, "success": result["success"]},
        )
        return result

    def _retry_command(self, step: dict, error: str, goal: str) -> dict:
        """Ask the model to diagnose and fix a failed command, retry up to _MAX_RETRIES times."""
        last_result = {"success": False, "output": error}
        for attempt in range(_MAX_RETRIES):
            fix_prompt = (
                f"The command failed:\n  command: {step['target']}\n  error: {error}\n\n"
                f"Original goal: {goal}\n\n"
                "Suggest a corrected shell command to fix this. "
                "Reply with ONLY the corrected command, nothing else."
            )
            corrected = self._chat(fix_prompt).strip().strip("`").strip()
            self.session.append("assistant", corrected, {"type": "retry_fix", "attempt": attempt + 1})
            last_result = self._run_command(corrected)
            if last_result["success"]:
                return last_result
            error = last_result["output"]
        return last_result

    # ── actions ───────────────────────────────────────────────────────────────

    def _write_file(self, path: str, description: str, goal: str) -> dict:
        prompt = f"""Write complete, working code for this file.

Goal: {goal}
File: {path}
Purpose: {description}

Requirements:
- Include all imports
- Add error handling where appropriate
- Make it production-ready
- Return ONLY the code, no explanations or markdown fences"""
        code = self._chat(prompt)
        code = self._strip_fences(code)

        # Validate: if the model returned prose instead of code, retry once
        if not self._looks_like_code(code, path):
            retry_prompt = (
                f"Your previous response did not contain valid code for {path}.\n"
                f"Return ONLY the complete Python code, starting with imports. No explanation."
            )
            code = self._strip_fences(self._chat(retry_prompt))

        # Syntax validation for Python files — fix before writing to disk
        if path.endswith(".py"):
            code, syntax_note = self._validate_and_fix_python(code)
        else:
            syntax_note = ""

        file_path = self.workspace / path
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(code)
        self.session.append("assistant", code, {"type": "file_write", "path": path})

        note = f" ({syntax_note})" if syntax_note else ""
        output = f"Created {path} ({len(code.splitlines())} lines){note}"

        # Optional test generation
        if self.generate_tests and path.endswith(".py") and not path.startswith("test_"):
            test_result = self._generate_tests_for(path, code, goal)
            output += f"\n{test_result}"

        return {"success": True, "output": output}

    def _validate_and_fix_python(self, code: str) -> tuple[str, str]:
        """Parse the code with ast. On SyntaxError, ask the model to fix it once."""
        try:
            ast.parse(code)
            return code, ""
        except SyntaxError as e:
            try:
                fix_prompt = (
                    f"This Python code has a syntax error: {e}\n\n"
                    f"```python\n{code}\n```\n\n"
                    "Return the corrected Python code only, no explanation."
                )
                fixed = self._strip_fences(self._chat(fix_prompt))
                ast.parse(fixed)
                return fixed, "syntax fixed"
            except Exception:
                return code, f"syntax warning: {e}"  # use original if fix fails

    def _generate_tests_for(self, path: str, code: str, goal: str) -> str:
        """Ask the model to write pytest tests for a generated file."""
        test_path = f"test_{Path(path).name}"
        prompt = (
            f"Write pytest unit tests for this file ({path}).\n\n"
            f"```python\n{code[:2000]}\n```\n\n"
            "Include tests for: normal operation, edge cases, and error handling.\n"
            "Return ONLY the test code, no explanation."
        )
        test_code = self._strip_fences(self._chat(prompt))
        if not self._looks_like_code(test_code, test_path):
            return "(test generation skipped — model returned prose)"
        test_file = self.workspace / test_path
        test_file.write_text(test_code)
        self.session.append("assistant", test_code, {"type": "file_write", "path": test_path})
        return f"Generated tests → {test_path}"

    @staticmethod
    def _strip_fences(text: str) -> str:
        if text.startswith("```"):
            lines = text.split("\n")
            end = -1 if lines[-1].strip() == "```" else len(lines)
            return "\n".join(lines[1:end])
        return text

    @staticmethod
    def _looks_like_code(text: str, path: str) -> bool:
        """Heuristic: does the response look like source code?"""
        ext = Path(path).suffix.lower()
        if ext in (".md", ".txt", ".rst"):
            return True  # prose is fine for docs
        code_signals = ("import ", "def ", "class ", "from ", "#!", "const ", "function ", "<?php")
        return any(s in text for s in code_signals) or len(text.splitlines()) > 3

    def _run_command(self, command: str) -> dict:
        try:
            result = subprocess.run(
                command, shell=True, cwd=self.workspace,
                capture_output=True, text=True, timeout=30,
            )
            output = result.stdout[:1000] if result.stdout else result.stderr[:500]
            return {"success": result.returncode == 0, "output": output or "(no output)"}
        except subprocess.TimeoutExpired:
            return {"success": False, "output": "Command timed out after 30s"}
        except Exception as e:
            return {"success": False, "output": str(e)}

    def _install(self, package: str) -> dict:
        result = subprocess.run(
            f"pip install {package}", shell=True, capture_output=True, text=True
        )
        return {"success": result.returncode == 0, "output": f"Installed {package}"}

    def _read_file(self, path: str) -> dict:
        try:
            content = (self.workspace / path).read_text()
            return {"success": True, "output": content[:500]}
        except Exception as e:
            return {"success": False, "output": str(e)}

    def chat(self, message: str) -> str:
        system = (
            "You are Anthos Engineer, a helpful AI coding assistant powered by local models. "
            "Answer conversationally and helpfully. Keep responses concise."
        )
        reply = self._chat(message, system=system)
        self.session.append("user", message)
        self.session.append("assistant", reply)
        return reply

    def files(self) -> list[str]:
        return [
            str(f.relative_to(self.workspace))
            for f in self.workspace.rglob("*") if f.is_file()
            if ".anthos" not in f.parts
        ]

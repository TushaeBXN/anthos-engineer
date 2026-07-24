"""Anthos Engineer — agentic coding system powered by local Ollama models."""

import json
import os
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path

import httpx


OLLAMA_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
DEFAULT_MODEL = os.environ.get("ANTHOS_MODEL", "amy")


def _call_ollama(prompt: str, model: str = DEFAULT_MODEL, system: str | None = None) -> str:
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    payload = {"model": model, "messages": messages, "stream": False}
    resp = httpx.post(f"{OLLAMA_URL}/v1/chat/completions", json=payload, timeout=120)
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def classify_intent(goal: str, model: str = DEFAULT_MODEL) -> str:
    """Return 'build' if goal is a coding/build task, 'chat' otherwise."""
    prompt = f"""Classify this user message. Reply with exactly one word: "build" or "chat".

"build" = the user wants to create, code, build, fix, or automate something technical.
"chat" = the user is greeting, asking a question, or having a conversation.

Message: {goal}

Reply with only "build" or "chat":"""
    result = _call_ollama(prompt, model).strip().lower()
    return "build" if "build" in result else "chat"


def _extract_json(text: str) -> list | dict:
    start = text.find("[") if "[" in text else text.find("{")
    end = text.rfind("]") + 1 if "[" in text else text.rfind("}") + 1
    if start == -1 or end == 0:
        raise ValueError("No JSON found in response")
    return json.loads(text[start:end])


class AnthosEngineer:
    def __init__(self, workspace: str | None = None, model: str = DEFAULT_MODEL):
        self.model = model
        self.workspace = Path(workspace or tempfile.mkdtemp(prefix="anthos-"))
        self.workspace.mkdir(parents=True, exist_ok=True)

    def plan(self, goal: str) -> list[dict]:
        prompt = f"""You are Anthos Engineer, an expert agentic coding system.
Create a detailed step-by-step plan to accomplish this goal:

GOAL: {goal}

Return ONLY a valid JSON array. Each item must have exactly these fields:
- "action": one of "write" | "run_command" | "install" | "read"
- "target": file path (for write/read) or shell command (for run_command) or package name (for install)
- "description": what this step does

Example:
[
  {{"action": "write", "target": "app.py", "description": "Create main Python application"}},
  {{"action": "run_command", "target": "python app.py", "description": "Test the application"}}
]

Return ONLY the JSON array, nothing else."""
        raw = _call_ollama(prompt, self.model)
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
            return self._write_file(target, step.get("description", ""), goal)
        elif action == "run_command":
            return self._run_command(target)
        elif action == "install":
            return self._install(target)
        elif action == "read":
            return self._read_file(target)
        return {"success": False, "output": f"Unknown action: {action}"}

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
        code = _call_ollama(prompt, self.model)
        # Strip markdown fences if model added them
        if code.startswith("```"):
            lines = code.split("\n")
            code = "\n".join(lines[1:-1] if lines[-1] == "```" else lines[1:])
        file_path = self.workspace / path
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(code)
        return {"success": True, "output": f"Created {path} ({len(code.splitlines())} lines)"}

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
        return _call_ollama(message, self.model, system=system)

    def files(self) -> list[str]:
        return [
            str(f.relative_to(self.workspace))
            for f in self.workspace.rglob("*") if f.is_file()
        ]

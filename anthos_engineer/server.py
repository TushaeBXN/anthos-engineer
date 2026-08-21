"""Anthos Engineer web server — FastAPI + SSE streaming."""

import asyncio
import json
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from anthos_engineer.agent import AnthosEngineer, classify_intent, detect_intent
from anthos_engineer.compaction import CompactionEngine
from anthos_engineer import cross_session

try:
    from anthos_engineer import amy_backend

    _amy_memory = amy_backend.Memory()
    _amy_ok = True
except Exception as _e:
    print(f"[amy] Backend unavailable: {_e}")
    _amy_ok = False
    amy_backend = None  # type: ignore[assignment]
    _amy_memory = None

app = FastAPI(title="Anthos Engineer")

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

sessions: dict[str, dict] = {}

# Amy sessions dict: {session_id: {history: [...ollama format...], label: str}}
amy_sessions: dict[str, dict] = {}
# Amy turns dict: {turn_id: {session_id, message, model, image_b64}}
amy_turns: dict[str, dict] = {}


class GoalRequest(BaseModel):
    goal: str
    model: str = "amy"
    generate_tests: bool = False


@app.get("/", response_class=HTMLResponse)
async def root():
    return (STATIC_DIR / "index.html").read_text()


@app.post("/api/session")
async def create_session(req: GoalRequest):
    session_id = str(uuid.uuid4())
    sessions[session_id] = {
        "goal": req.goal,
        "model": req.model,
        "generate_tests": req.generate_tests,
        "status": "planning",
        "plan": [],
        "results": [],
    }
    return {"session_id": session_id}


@app.get("/api/session/{session_id}/stream")
async def stream_session(session_id: str):
    if session_id not in sessions:
        return {"error": "Session not found"}

    session = sessions[session_id]

    async def generate():
        def emit(event: str, data: dict):
            return f"event: {event}\ndata: {json.dumps(data)}\n\n"

        engineer = AnthosEngineer(
            model=session["model"],
            session_id=session_id,
            generate_tests=session.get("generate_tests", False),
        )
        session["workspace"] = str(engineer.workspace)
        session["log_path"] = str(engineer.session.log_path)
        loop = asyncio.get_event_loop()

        # Detect intent (richer than binary build/chat)
        yield emit("status", {"message": "Thinking…"})
        await asyncio.sleep(0.05)
        recent_ctx = engineer._context[-6:] if engineer._context else []
        intent = await loop.run_in_executor(
            None, detect_intent, session["goal"], session["model"], recent_ctx
        )
        intent_type = intent["type"]

        # Route: history search
        if intent_type == "search_history":
            from anthos_engineer.retrieval import SemanticRetriever
            log_path = engineer.session.log_path
            results = SemanticRetriever(log_path).search(intent["search_query"] or session["goal"], top_k=5)
            reply = (
                f"Found {len(results)} result(s) in session history:\n\n"
                + "\n".join(f"- [{r['role']}] {r['content'][:200]}" for r in results)
            ) if results else f"No history found matching '{intent['search_query']}'."
            session["status"] = "done"
            yield emit("chat", {"message": reply})
            yield emit("done", {"files": [], "workspace": "", "steps_completed": 0})
            return

        # Route: conversational
        if intent_type in ("chat", "explain"):
            reply = await loop.run_in_executor(None, engineer.chat, session["goal"])
            session["status"] = "done"
            yield emit("chat", {"message": reply})
            yield emit("done", {"files": [], "workspace": "", "steps_completed": 0})
            return

        label = {
            "build":  f"Planning how to build: {session['goal']}",
            "modify": f"Planning modifications: {session['goal']}",
            "debug":  f"Diagnosing: {session['goal']}",
        }.get(intent_type, f"Planning: {session['goal']}")
        yield emit("status", {"message": label})
        await asyncio.sleep(0.05)

        # Planning phase — pass intent so plan() can tailor instructions + inject context
        plan = await loop.run_in_executor(None, engineer.plan, session["goal"], intent)
        session["plan"] = plan
        session["status"] = "executing"

        yield emit("plan", {"steps": plan})
        await asyncio.sleep(0.1)

        # Execution phase
        results = []
        for i, step in enumerate(plan):
            yield emit("step_start", {
                "index": i,
                "action": step.get("action"),
                "target": step.get("target"),
                "description": step.get("description"),
            })
            await asyncio.sleep(0.05)

            result = await loop.run_in_executor(
                None, engineer.execute_step, step, session["goal"]
            )
            results.append(result)
            session["results"] = results

            yield emit("step_done", {
                "index": i,
                "success": result["success"],
                "output": result["output"],
            })
            await asyncio.sleep(0.05)

        files = engineer.files()
        session["files"] = files
        session["status"] = "done"

        cross_session.record_session(
            session_id=session_id,
            goal=session["goal"],
            workspace=str(engineer.workspace),
            model=session["model"],
            file_count=len(files),
        )

        yield emit("done", {
            "files": files,
            "workspace": str(engineer.workspace),
            "steps_completed": len(results),
        })

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/session/{session_id}")
async def get_session(session_id: str):
    return sessions.get(session_id, {"error": "not found"})


class SearchRequest(BaseModel):
    query: str
    max_results: int = 5


@app.post("/api/session/{session_id}/history/search")
async def history_search(session_id: str, req: SearchRequest):
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    log_path = session.get("log_path")
    if not log_path:
        return {"results": [], "engine": "none"}
    from anthos_engineer.retrieval import SemanticRetriever
    retriever = SemanticRetriever(Path(log_path))
    results = retriever.search(req.query, req.max_results)
    engine = "semantic" if results and results[0].get("score") is not None else "keyword"
    return {"results": results, "engine": engine}


@app.get("/api/session/{session_id}/state")
async def session_state(session_id: str):
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    log_path = session.get("log_path")
    log_bytes = Path(log_path).stat().st_size if log_path and Path(log_path).exists() else 0
    return {
        "session_id": session_id,
        "status": session.get("status"),
        "goal": session.get("goal"),
        "model": session.get("model"),
        "steps_total": len(session.get("plan", [])),
        "steps_done": len(session.get("results", [])),
        "files_created": len(session.get("files", [])),
        "log_bytes": log_bytes,
        "workspace": session.get("workspace"),
    }


@app.get("/api/cross-session/recent")
async def cross_session_recent():
    return {"sessions": cross_session.recent(20)}


class CrossSearchRequest(BaseModel):
    query: str


@app.post("/api/cross-session/search")
async def cross_session_search(req: CrossSearchRequest):
    return {"results": cross_session.search(req.query)}


class CompactRequest(BaseModel):
    type: str = "full"  # "micro" | "full"


@app.post("/api/session/{session_id}/compact")
async def compact_session(session_id: str, req: CompactRequest):
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    # Compaction operates on the live engineer context; for completed sessions
    # this endpoint returns the current log size as informational.
    log_path = session.get("log_path")
    if not log_path:
        return {"status": "no log available"}
    from pathlib import Path
    size = Path(log_path).stat().st_size if Path(log_path).exists() else 0
    return {"status": "ok", "type": req.type, "log_bytes": size}


# ── Amy endpoints ─────────────────────────────────────────────────────────────

@app.post("/api/amy/start")
async def amy_start():
    session_id = str(uuid.uuid4())
    amy_sessions[session_id] = {"history": [], "label": "New conversation"}
    return {"session_id": session_id}


@app.post("/api/amy/upload")
async def amy_upload(file: UploadFile = File(...)):
    if not _amy_ok:
        return {"type": "error", "data": "Amy backend not available"}
    content = await file.read()
    return amy_backend.extract_file_content(
        content, file.filename or "upload", file.content_type or ""
    )


class AmyTurnRequest(BaseModel):
    session_id: str
    message: str
    model: str = "amy"
    image_b64: str | None = None


@app.post("/api/amy/turn")
async def amy_turn(req: AmyTurnRequest):
    turn_id = str(uuid.uuid4())
    amy_turns[turn_id] = {
        "session_id": req.session_id,
        "message": req.message,
        "model": req.model,
        "image_b64": req.image_b64,
    }
    return {"turn_id": turn_id}


@app.get("/api/amy/turn/{turn_id}/stream")
async def amy_stream(turn_id: str):
    if not _amy_ok:
        return {"error": "Amy backend not available"}

    turn = amy_turns.get(turn_id)
    if not turn:
        return {"error": "turn not found"}

    session = amy_sessions.setdefault(turn["session_id"], {"history": [], "label": ""})
    history = list(session.get("history", []))

    async def generate():
        def emit(event: str, data: dict) -> str:
            return f"event: {event}\ndata: {json.dumps(data)}\n\n"

        loop = asyncio.get_event_loop()

        def run_turn():
            return amy_backend.amy_web_turn(
                history=history,
                mem=_amy_memory,
                message=turn["message"],
                image_b64=turn.get("image_b64"),
                model=turn["model"],
            )

        yield emit("status", {"message": "Amy is thinking…"})
        await asyncio.sleep(0.05)

        try:
            reply, new_history, tools_used = await loop.run_in_executor(None, run_turn)
            session["history"] = new_history
            for t in tools_used:
                yield emit("tool", {"name": t})
            yield emit("message", {"content": reply})
            yield emit("done", {})
        except Exception as e:
            yield emit("error_event", {"message": str(e)})
            yield emit("done", {})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/amy/sessions")
async def amy_list_sessions():
    return [
        {"id": k, "label": v.get("label", ""), "turns": len(v.get("history", [])) // 2}
        for k, v in amy_sessions.items()
    ]


def serve():
    import uvicorn
    uvicorn.run("anthos_engineer.server:app", host="127.0.0.1", port=7337, reload=False)

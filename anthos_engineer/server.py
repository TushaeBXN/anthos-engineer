"""Anthos Engineer web server — FastAPI + SSE streaming."""

import asyncio
import json
import uuid
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from anthos_engineer.agent import AnthosEngineer, classify_intent

app = FastAPI(title="Anthos Engineer")

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

sessions: dict[str, dict] = {}


class GoalRequest(BaseModel):
    goal: str
    model: str = "amy"


@app.get("/", response_class=HTMLResponse)
async def root():
    return (STATIC_DIR / "index.html").read_text()


@app.post("/api/session")
async def create_session(req: GoalRequest):
    session_id = str(uuid.uuid4())
    sessions[session_id] = {
        "goal": req.goal,
        "model": req.model,
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

        engineer = AnthosEngineer(model=session["model"])
        session["workspace"] = str(engineer.workspace)
        loop = asyncio.get_event_loop()

        # Classify intent first: chat vs build
        yield emit("status", {"message": "Thinking…"})
        await asyncio.sleep(0.05)
        intent = await loop.run_in_executor(None, classify_intent, session["goal"], session["model"])

        if intent == "chat":
            # Conversational reply — no build steps
            reply = await loop.run_in_executor(None, engineer.chat, session["goal"])
            session["status"] = "done"
            yield emit("chat", {"message": reply})
            yield emit("done", {"files": [], "workspace": "", "steps_completed": 0})
            return

        yield emit("status", {"message": f"Planning how to: {session['goal']}"})
        await asyncio.sleep(0.05)

        # Planning phase
        plan = await loop.run_in_executor(None, engineer.plan, session["goal"])
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


def serve():
    import uvicorn
    uvicorn.run("anthos_engineer.server:app", host="127.0.0.1", port=7337, reload=False)

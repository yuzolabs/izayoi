"""FastAPI application: REST API, hand-rolled SSE, SPA static hosting.

- Binds to 127.0.0.1 by default (local-only tool, C4); override with
  ``IZAYOI_HOST`` / ``IZAYOI_PORT``.
- SSE is implemented by hand (no sse-starlette): live sessions fan out through
  per-subscriber queues, completed sessions replay from the DB (P1, P5).
- SPA deep links are served index.html by catching starlette's 404
  HTTPException — catching fastapi.HTTPException would miss it (P3).
"""

from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import db, orchestrator, personas, providers
from .models import DecisionUpdate, SessionCreate

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DIST = REPO_ROOT / "frontend" / "dist"

_TERMINAL_STATUSES = ("done", "error")


def _frontend_dist() -> Path:
    return Path(os.environ.get("IZAYOI_FRONTEND_DIST", str(DEFAULT_DIST)))


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    # A previous process may have died mid-run; mark orphaned sessions as
    # errored so history never shows them as eternally "running".
    for session in db.list_sessions():
        if session.status not in _TERMINAL_STATUSES:
            db.update_session_status(session.id, "error", "Interrupted by server restart")
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="izayoi", version="1.0.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ------------------------------------------------------------------
    # Metadata
    # ------------------------------------------------------------------

    @app.get("/api/providers")
    async def get_providers() -> dict[str, Any]:
        return {"providers": [p.model_dump() for p in providers.detect_providers()]}

    @app.get("/api/personas")
    async def get_personas() -> dict[str, Any]:
        return {"personas": [p.model_dump() for p in personas.list_persona_summaries()]}

    # ------------------------------------------------------------------
    # Sessions
    # ------------------------------------------------------------------

    @app.post("/api/sessions", status_code=201)
    async def post_session(payload: SessionCreate) -> dict[str, Any]:
        known = {p["type"] for p in personas.load_personas()}
        for agent in payload.agents:
            if agent.persona_type not in known:
                raise HTTPException(422, f"unknown persona type: {agent.persona_type}")
            _require_available(agent.provider)
        _require_available(payload.facilitator.provider)
        session = db.create_session(payload)
        return session.model_dump()

    @app.post("/api/sessions/{session_id}/start", status_code=202)
    async def post_start(session_id: str) -> dict[str, str]:
        session = db.get_session(session_id)
        if not session:
            raise HTTPException(404, "session not found")
        if session.status in _TERMINAL_STATUSES:
            raise HTTPException(409, f"session already {session.status}")
        if orchestrator.is_any_session_running():
            raise HTTPException(409, "another session is already running")
        config = SessionCreate(**(db.get_session_config(session_id) or {}))
        await orchestrator.start_session(session_id, config)
        return {"status": "started"}

    @app.get("/api/sessions")
    async def get_sessions() -> dict[str, Any]:
        return {"sessions": [s.model_dump() for s in db.list_sessions()]}

    @app.get("/api/sessions/{session_id}")
    async def get_session(session_id: str) -> dict[str, Any]:
        session = db.get_session(session_id)
        if not session:
            raise HTTPException(404, "session not found")
        return session.model_dump()

    @app.get("/api/sessions/{session_id}/ideas")
    async def get_ideas(session_id: str) -> dict[str, Any]:
        if not db.get_session(session_id):
            raise HTTPException(404, "session not found")
        return {"ideas": [i.model_dump() for i in db.list_ideas(session_id)]}

    @app.get("/api/sessions/{session_id}/messages")
    async def get_messages(session_id: str) -> dict[str, Any]:
        """Framing + discussion log (read model for the results view)."""

        if not db.get_session(session_id):
            raise HTTPException(404, "session not found")
        return {"messages": db.list_messages(session_id)}

    @app.patch("/api/ideas/{idea_id}/decision")
    async def patch_decision(idea_id: str, payload: DecisionUpdate) -> dict[str, Any]:
        idea = db.update_idea_decision(idea_id, payload.decision, payload.note)
        if not idea:
            raise HTTPException(404, "idea not found")
        return idea.model_dump()

    @app.get("/api/sessions/{session_id}/export")
    async def get_export(session_id: str, format: str = "md") -> Response:
        session = db.get_session(session_id)
        if not session:
            raise HTTPException(404, "session not found")
        ideas = db.list_ideas(session_id)
        messages = db.list_messages(session_id)
        if format == "json":
            body = json.dumps(
                {
                    "session": session.model_dump(mode="json"),
                    "ideas": [i.model_dump(mode="json") for i in ideas],
                    "messages": messages,
                },
                ensure_ascii=False,
                indent=2,
            )
            return Response(
                content=body,
                media_type="application/json",
                headers={
                    "Content-Disposition": f'attachment; filename="izayoi-{session_id}.json"'
                },
            )
        if format != "md":
            raise HTTPException(422, "format must be 'md' or 'json'")
        body = _render_markdown(session.model_dump(), [i.model_dump() for i in ideas], messages)
        return Response(
            content=body,
            media_type="text/markdown; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="izayoi-{session_id}.md"'},
        )

    # ------------------------------------------------------------------
    # SSE stream (hand-rolled; P1/P5)
    # ------------------------------------------------------------------

    @app.get("/api/sessions/{session_id}/stream")
    async def get_stream(session_id: str) -> StreamingResponse:
        if not db.get_session(session_id):
            raise HTTPException(404, "session not found")
        return StreamingResponse(
            _event_stream(session_id),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # ------------------------------------------------------------------
    # SPA static hosting (P3)
    # ------------------------------------------------------------------

    dist = _frontend_dist()
    if dist.is_dir():

        @app.exception_handler(StarletteHTTPException)
        async def spa_fallback(request: Request, exc: StarletteHTTPException) -> Response:
            # API paths keep their honest 404 JSON; everything else is a SPA route.
            if exc.status_code == 404 and not request.url.path.startswith("/api"):
                return FileResponse(dist / "index.html")
            return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)

        app.mount("/", StaticFiles(directory=str(dist), html=True), name="spa")

    return app


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _require_available(provider_id: str) -> None:
    if not providers.is_provider_available(provider_id):
        spec = next((p for p in providers.detect_providers() if p.id == provider_id), None)
        hint = f" (env var {spec.env_var} not set)" if spec and spec.env_var else ""
        raise HTTPException(422, f"provider '{provider_id}' is not available{hint}")


def _is_terminal(event: dict[str, Any]) -> bool:
    return event.get("type") == "error" or (
        event.get("type") == "phase" and event.get("phase") == "done"
    )


async def _event_stream(session_id: str) -> AsyncIterator[str]:
    runner = orchestrator.get_runner(session_id)
    if runner is not None and not runner.done:
        queue = await runner.subscribe()
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"  # heartbeat comment keeps the connection warm
                    continue
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                if _is_terminal(event):
                    # P5: the server closes here; clients must not close early.
                    break
        finally:
            runner.unsubscribe(queue)
    else:
        for event in _replay_events(session_id):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def _replay_events(session_id: str) -> list[dict[str, Any]]:
    """Reconstruct the event sequence for a finished session from the DB."""

    session = db.get_session(session_id)
    if not session:
        return []
    ideas = db.list_ideas(session_id)
    messages = db.list_messages(session_id)
    events: list[dict[str, Any]] = []

    def phase(name: str) -> dict[str, Any]:
        return {"type": "phase", "phase": name, "label": orchestrator.PHASE_LABELS.get(name, name)}

    events.append(phase("framing"))
    framing_msgs = [m for m in messages if m["round"] == 0]
    for m in framing_msgs:
        events.append({"type": "message", "round": 0, "from": m["anon_name"], "content": m["content"]})

    events.append(phase("divergence"))
    for idea in ideas:
        if idea.phase == "divergence":
            events.append({"type": "idea", "idea": idea.model_dump(mode="json")})

    events.append(phase("discussion"))
    # Interleave discussion messages and discussion-derived ideas by time.
    timed: list[tuple[str, dict[str, Any]]] = []
    for m in messages:
        if m["round"] >= 1:
            timed.append(
                (m["created_at"], {"type": "message", "round": m["round"], "from": m["anon_name"], "content": m["content"]})
            )
    discussion_ideas = [i for i in ideas if i.phase == "discussion"]
    for idea in discussion_ideas:
        timed.append(
            (idea.id, {"type": "idea", "idea": idea.model_dump(mode="json")})  # stable tiebreak
        )
    timed.sort(key=lambda pair: pair[0])
    events.extend(event for _, event in timed)

    events.append(phase("convergence"))
    if session.metrics:
        events.append({"type": "metrics", "metrics": session.metrics.model_dump(mode="json")})
    if session.status == "done":
        events.append(phase("done"))
    else:
        events.append({"type": "error", "message": session.phase_progress or "session failed"})
    return events


def _render_markdown(
    session: dict[str, Any], ideas: list[dict[str, Any]], messages: list[dict[str, Any]]
) -> str:
    """Markdown export: framing, cluster-grouped ideas, discussion log, metrics."""

    lines: list[str] = [
        f"# izayoi brainstorming session {session['id']}",
        "",
        f"- **Theme:** {session['theme']}",
        f"- **Constraints:** {session['constraints'] or '(none)'}",
        f"- **Status:** {session['status']}",
        f"- **Created:** {session['created_at']}",
        "",
    ]
    metrics = session.get("metrics")
    if metrics:
        lines += [
            "## Metrics",
            "",
            f"- Total ideas: {metrics['total_ideas']}",
            f"- Unique ideas: {metrics['unique_ideas']}",
            f"- Non-duplicate ratio: {metrics['non_duplicate_ratio']}",
            f"- Semantic dispersion: {metrics['semantic_dispersion']}",
            f"- Collapse alert: {metrics['collapse_alert']}",
            "",
        ]
    framing = [m for m in messages if m["round"] == 0]
    if framing:
        lines += ["## Framing", "", framing[0]["content"], ""]

    lines += ["## Ideas", ""]
    clusters: dict[Any, list[dict[str, Any]]] = {}
    for idea in ideas:
        clusters.setdefault(idea.get("cluster_id"), []).append(idea)
    for cid, members in sorted(clusters.items(), key=lambda kv: (kv[0] is None, kv[0])):
        title = f"Cluster {cid}" if cid is not None else "Unclustered"
        lines += [f"### {title}", ""]
        for member in members:
            if member.get("synthesized"):
                lines += [f"**Synthesized:** {member['synthesized']}", ""]
            scores = member.get("scores")
            score_text = (
                f"N{scores['novelty']} / F{scores['feasibility']} / C{scores['clarity']}"
                f" (total {scores['total']})"
                if scores
                else "not scored"
            )
            lines.append(
                f"- [{member['decision']}] ({member['persona_type']}, {member['phase']})"
                f" {member['content']} — *{score_text}*"
            )
            if member.get("note"):
                lines.append(f"  - Note: {member['note']}")
        lines.append("")

    discussion = [m for m in messages if m["round"] >= 1]
    if discussion:
        lines += ["## Discussion log", ""]
        for m in discussion:
            lines += [f"- **Round {m['round']} — {m['anon_name']}:** {m['content']}"]
        lines.append("")
    return "\n".join(lines)


app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "backend.main:app",
        host=os.environ.get("IZAYOI_HOST", "127.0.0.1"),
        port=int(os.environ.get("IZAYOI_PORT", "8787")),
        reload=False,
    )

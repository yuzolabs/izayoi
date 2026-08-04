"""SQLite persistence layer (stdlib sqlite3 only, per SPEC C3).

A fresh connection is opened per operation; SQLite handles this well for a
local single-user tool and it keeps the code free of connection/lifecycle bugs.
The database file location is read from ``IZAYOI_DB_PATH`` at call time so
tests can point it at a temporary file before any call happens.
"""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from .models import Idea, IdeaScores, Session, SessionCreate, SessionMetrics

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions(
    id TEXT PRIMARY KEY,
    theme TEXT NOT NULL,
    constraints TEXT NOT NULL DEFAULT '',
    config_json TEXT NOT NULL,
    status TEXT NOT NULL,
    phase_progress TEXT NOT NULL DEFAULT '',
    metrics_json TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ideas(
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    persona_type TEXT NOT NULL,
    phase TEXT NOT NULL,
    content TEXT NOT NULL,
    cluster_id INTEGER,
    synthesized TEXT,
    scores_json TEXT,
    decision TEXT NOT NULL DEFAULT 'pending',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages(
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    anon_name TEXT NOT NULL,
    persona_type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ideas_session ON ideas(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
"""


def db_path() -> str:
    """Resolve the database path lazily so tests can override it via env var."""

    return os.environ.get("IZAYOI_DB_PATH", "izayoi.db")


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    return conn


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(_SCHEMA)


# ---------------------------------------------------------------------------
# sessions
# ---------------------------------------------------------------------------


def create_session(payload: SessionCreate) -> Session:
    session_id = new_id()
    created_at = utcnow()
    config_json = payload.model_dump_json()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO sessions(id, theme, constraints, config_json, status,"
            " phase_progress, metrics_json, created_at) VALUES(?,?,?,?,?,?,?,?)",
            (session_id, payload.theme, payload.constraints, config_json,
             "framing", "", None, created_at),
        )
    return Session(
        id=session_id,
        theme=payload.theme,
        constraints=payload.constraints,
        status="framing",
        phase_progress="",
        agents=payload.agents,
        created_at=created_at,
        metrics=None,
    )


def update_session_status(session_id: str, status: str, phase_progress: str = "") -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE sessions SET status = ?, phase_progress = ? WHERE id = ?",
            (status, phase_progress, session_id),
        )


def update_session_metrics(session_id: str, metrics: SessionMetrics) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE sessions SET metrics_json = ? WHERE id = ?",
            (metrics.model_dump_json(), session_id),
        )


def get_session(session_id: str) -> Optional[Session]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return _row_to_session(row) if row else None


def list_sessions() -> list[Session]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM sessions ORDER BY created_at DESC").fetchall()
    return [_row_to_session(r) for r in rows]


def _row_to_session(row: sqlite3.Row) -> Session:
    config = json.loads(row["config_json"])
    metrics = SessionMetrics(**json.loads(row["metrics_json"])) if row["metrics_json"] else None
    return Session(
        id=row["id"],
        theme=row["theme"],
        constraints=row["constraints"],
        status=row["status"],
        phase_progress=row["phase_progress"],
        agents=config.get("agents", []),
        created_at=row["created_at"],
        metrics=metrics,
    )


def get_session_config(session_id: str) -> Optional[dict[str, Any]]:
    """Return the raw stored SessionCreate payload (facilitator, parameters...)."""

    with _connect() as conn:
        row = conn.execute("SELECT config_json FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return json.loads(row["config_json"]) if row else None


# ---------------------------------------------------------------------------
# ideas
# ---------------------------------------------------------------------------


def insert_idea(session_id: str, persona_type: str, phase: str, content: str) -> Idea:
    idea = Idea(
        id=new_id(),
        session_id=session_id,
        persona_type=persona_type,
        phase=phase,  # type: ignore[arg-type]
        content=content,
    )
    with _connect() as conn:
        conn.execute(
            "INSERT INTO ideas(id, session_id, persona_type, phase, content, cluster_id,"
            " synthesized, scores_json, decision, note, created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (idea.id, session_id, persona_type, phase, content, None, None, None,
             "pending", "", utcnow()),
        )
    return idea


def update_idea_convergence(
    idea_id: str,
    cluster_id: Optional[int],
    synthesized: Optional[str],
    scores: Optional[IdeaScores],
) -> Optional[Idea]:
    with _connect() as conn:
        conn.execute(
            "UPDATE ideas SET cluster_id = ?, synthesized = ?, scores_json = ? WHERE id = ?",
            (cluster_id, synthesized, scores.model_dump_json() if scores else None, idea_id),
        )
    return get_idea(idea_id)


def update_idea_decision(idea_id: str, decision: str, note: Optional[str]) -> Optional[Idea]:
    with _connect() as conn:
        if note is None:
            conn.execute("UPDATE ideas SET decision = ? WHERE id = ?", (decision, idea_id))
        else:
            conn.execute(
                "UPDATE ideas SET decision = ?, note = ? WHERE id = ?",
                (decision, note, idea_id),
            )
    return get_idea(idea_id)


def get_idea(idea_id: str) -> Optional[Idea]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM ideas WHERE id = ?", (idea_id,)).fetchone()
    return _row_to_idea(row) if row else None


def list_ideas(session_id: str) -> list[Idea]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM ideas WHERE session_id = ? ORDER BY created_at ASC", (session_id,)
        ).fetchall()
    return [_row_to_idea(r) for r in rows]


def _row_to_idea(row: sqlite3.Row) -> Idea:
    scores = IdeaScores(**json.loads(row["scores_json"])) if row["scores_json"] else None
    return Idea(
        id=row["id"],
        session_id=row["session_id"],
        persona_type=row["persona_type"],
        phase=row["phase"],
        content=row["content"],
        cluster_id=row["cluster_id"],
        synthesized=row["synthesized"],
        scores=scores,
        decision=row["decision"],
        note=row["note"],
    )


# ---------------------------------------------------------------------------
# messages (facilitator framing + discussion log)
# ---------------------------------------------------------------------------


def insert_message(
    session_id: str, round_no: int, anon_name: str, persona_type: str, content: str
) -> dict[str, Any]:
    msg = {
        "id": new_id(),
        "session_id": session_id,
        "round": round_no,
        "anon_name": anon_name,
        "persona_type": persona_type,
        "content": content,
        "created_at": utcnow(),
    }
    with _connect() as conn:
        conn.execute(
            "INSERT INTO messages(id, session_id, round, anon_name, persona_type, content,"
            " created_at) VALUES(?,?,?,?,?,?,?)",
            (msg["id"], session_id, round_no, anon_name, persona_type, content,
             msg["created_at"]),
        )
    return msg


def list_messages(session_id: str) -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC", (session_id,)
        ).fetchall()
    return [dict(r) for r in rows]

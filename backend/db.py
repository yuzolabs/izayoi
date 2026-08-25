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
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from .models import Idea, IdeaScores, Session, SessionCreate, SessionMetrics
from .session_run_lock import SessionRunLock, hold_session_run_lock_ownership

_CURRENT_SCHEMA_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS sessions(
        id TEXT PRIMARY KEY,
        theme TEXT NOT NULL,
        constraints TEXT NOT NULL DEFAULT '',
        config_json TEXT NOT NULL,
        status TEXT NOT NULL,
        run_claimed INTEGER NOT NULL DEFAULT 0 CHECK(run_claimed IN (0, 1)),
        phase_progress TEXT NOT NULL DEFAULT '',
        metrics_json TEXT,
        created_at TEXT NOT NULL
    )
    """,
    """
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
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS messages(
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        round INTEGER NOT NULL,
        anon_name TEXT NOT NULL,
        persona_type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_ideas_session ON ideas(session_id)",
    "CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)",
)


def db_path() -> str:
    """Resolve the database path lazily so tests can override it via env var."""

    return os.environ.get("IZAYOI_DB_PATH", "izayoi.db")


def _connect(database_path: str | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(database_path or db_path())
    conn.row_factory = sqlite3.Row
    return conn


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def _execute_schema_in_transaction(conn: sqlite3.Connection) -> None:
    """Execute the static schema without ``executescript`` committing the transaction."""

    for statement in _CURRENT_SCHEMA_STATEMENTS:
        conn.execute(statement)


def _legacy_session_has_started_evidence(
    status: object,
    phase_progress: object,
) -> bool:
    """Return whether a pre-claim row contains evidence that its run started.

    Unknown statuses deliberately return false. Startup recovery must preserve
    an unrecognized row rather than guess that it is an orphan and overwrite it.
    """

    if status in {"divergence", "discussion", "convergence"}:
        return True
    return (
        status == "framing"
        and isinstance(phase_progress, str)
        and bool(phase_progress.strip())
    )


def _add_legacy_session_run_claims(conn: sqlite3.Connection) -> None:
    """Add ``run_claimed`` and claim only rows with legacy started-run evidence."""

    conn.execute(
        "ALTER TABLE sessions ADD COLUMN run_claimed INTEGER NOT NULL "
        "DEFAULT 0 CHECK(run_claimed IN (0, 1))"
    )
    legacy_rows = conn.execute(
        "SELECT id, status, phase_progress FROM sessions"
    ).fetchall()
    started_session_ids = [
        (row["id"],)
        for row in legacy_rows
        if _legacy_session_has_started_evidence(row["status"], row["phase_progress"])
    ]
    if started_session_ids:
        conn.executemany(
            "UPDATE sessions SET run_claimed = 1 WHERE id = ?",
            started_session_ids,
        )


def init_db() -> None:
    """Create the schema and migrate pre-claim databases in one write transaction."""

    with _connect() as conn:
        # BEGIN IMMEDIATE serializes schema creation, the column-existence
        # decision, ALTER TABLE, and evidence update across CLI/Web processes.
        conn.execute("BEGIN IMMEDIATE")
        _execute_schema_in_transaction(conn)
        session_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()
        }
        if "run_claimed" not in session_columns:
            # This branch is the one-time migration gate. Existing current-schema
            # rows, including a live claim, must never receive the legacy UPDATE.
            _add_legacy_session_run_claims(conn)


# ---------------------------------------------------------------------------
# sessions
# ---------------------------------------------------------------------------


class SessionRunClaimError(RuntimeError):
    """Base error for an atomic session run claim rejected inside SQLite."""


class SessionRunClaimMissingError(SessionRunClaimError):
    """Raised when the atomic session run claim cannot find its target row."""


class SessionRunClaimTerminalError(SessionRunClaimError):
    """Raised when the atomic session run claim targets a terminal session."""

    def __init__(self, status: str) -> None:
        self.status = status
        super().__init__(f"session already {status}")


class SessionRunClaimAlreadyStartedError(SessionRunClaimError):
    """Raised when the target session has already received a run claim."""


class SessionRunClaimInvariantError(SessionRunClaimError):
    """Raised when a serialized target claim update violates its invariant."""


@dataclass(frozen=True)
class ClaimedSessionRun:
    """Committed session run claim and the config read with its target row."""

    session: Session
    config: SessionCreate


def _insert_session_row(conn: sqlite3.Connection, payload: SessionCreate) -> str:
    session_id = new_id()
    stored_session_constraints = payload.constraints or ""
    conn.execute(
        "INSERT INTO sessions(id, theme, constraints, config_json, status, run_claimed,"
        " phase_progress, metrics_json, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        (
            session_id,
            payload.theme,
            stored_session_constraints,
            payload.model_dump_json(),
            "framing",
            0,
            "",
            None,
            utcnow(),
        ),
    )
    return session_id


def create_session(payload: SessionCreate) -> Session:
    """Create an unclaimed Web session that can be started exactly once."""

    with _connect() as conn:
        session_id = _insert_session_row(conn, payload)
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:  # pragma: no cover - SQLite INSERT/SELECT invariant
        raise RuntimeError("Session creation invariant failed: inserted row is missing")
    return _row_to_session(row)


def update_session_status(session_id: str, status: str, phase_progress: str = "") -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE sessions SET status = ?, phase_progress = ? WHERE id = ?",
            (status, phase_progress, session_id),
        )


def terminate_claimed_session_run(
    session_run_lock: SessionRunLock | None,
    session_id: str,
    reason: str,
) -> bool:
    """Commit a claimed run's graceful termination while its OS lock is held."""

    selected_database_path = db_path()
    with hold_session_run_lock_ownership(
        session_run_lock,
        selected_database_path,
    ) as canonical_database_path:
        with _connect(canonical_database_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            terminated = conn.execute(
                "UPDATE sessions SET status = 'error', phase_progress = ?, "
                "run_claimed = 0 WHERE id = ? AND run_claimed = 1 "
                "AND status NOT IN ('done', 'error')",
                (reason, session_id),
            ).rowcount
    return terminated == 1


def claim_session_run(
    session_run_lock: SessionRunLock | None,
    session_id: str,
    *,
    recovery_reason: str = "Interrupted by a newer session start",
) -> ClaimedSessionRun:
    """Atomically re-read and claim one existing session while recovering other orphans."""

    selected_database_path = db_path()
    with hold_session_run_lock_ownership(
        session_run_lock,
        selected_database_path,
    ) as canonical_database_path:
        with _connect(canonical_database_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            claimed_session_run = _claim_session_run_in_transaction(
                conn,
                session_id,
                recovery_reason,
            )
    return claimed_session_run


def create_and_claim_session_run(
    session_run_lock: SessionRunLock | None,
    payload: SessionCreate,
    *,
    recovery_reason: str = "Interrupted by a newer session start",
) -> ClaimedSessionRun:
    """Create and atomically claim one CLI session without a phantom row on failure."""

    selected_database_path = db_path()
    with hold_session_run_lock_ownership(
        session_run_lock,
        selected_database_path,
    ) as canonical_database_path:
        with _connect(canonical_database_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            session_id = _insert_session_row(conn, payload)
            claimed_session_run = _claim_session_run_in_transaction(
                conn,
                session_id,
                recovery_reason,
            )
    return claimed_session_run


def _claim_session_run_in_transaction(
    conn: sqlite3.Connection,
    session_id: str,
    recovery_reason: str,
) -> ClaimedSessionRun:
    target_row = conn.execute(
        "SELECT * FROM sessions WHERE id = ?",
        (session_id,),
    ).fetchone()
    if target_row is None:
        raise SessionRunClaimMissingError("session not found")
    if target_row["status"] in ("done", "error"):
        raise SessionRunClaimTerminalError(target_row["status"])
    if target_row["run_claimed"]:
        raise SessionRunClaimAlreadyStartedError("session already running")

    # The target eligibility read, recovery of only previously claimed rows,
    # and target claim are one write transaction. No await or external lock
    # acquisition occurs while SQLite holds this transaction.
    conn.execute(
        "UPDATE sessions SET status = 'error', phase_progress = ? "
        "WHERE id != ? AND run_claimed = 1 "
        "AND status IN ('framing', 'divergence', 'discussion', 'convergence')",
        (recovery_reason, session_id),
    )
    target_update = conn.execute(
        "UPDATE sessions SET run_claimed = 1 "
        "WHERE id = ? AND run_claimed = 0 AND status NOT IN ('done', 'error')",
        (session_id,),
    )
    if target_update.rowcount != 1:
        raise SessionRunClaimInvariantError(
            f"Session run claim invariant failed for target '{session_id}'"
        )

    return ClaimedSessionRun(
        session=_row_to_session(target_row),
        config=SessionCreate(**json.loads(target_row["config_json"])),
    )


def recover_orphaned_session_runs(
    session_run_lock: SessionRunLock | None,
    *,
    recovery_reason: str = "Interrupted by a newer session start",
) -> int:
    """Recover claimed rows in recognized active statuses under lock ownership."""

    selected_database_path = db_path()
    with hold_session_run_lock_ownership(
        session_run_lock,
        selected_database_path,
    ) as canonical_database_path:
        with _connect(canonical_database_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            # Restrict automatic recovery to statuses this version recognizes.
            # Even a claimed unknown status is preserved rather than destructively
            # reclassified as an error.
            recovered = conn.execute(
                "UPDATE sessions SET status = 'error', phase_progress = ? "
                "WHERE run_claimed = 1 "
                "AND status IN ('framing', 'divergence', 'discussion', 'convergence')",
                (recovery_reason,),
            ).rowcount
    return recovered


def update_session_metrics(session_id: str, metrics: SessionMetrics) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE sessions SET metrics_json = ? WHERE id = ?",
            (metrics.model_dump_json(), session_id),
        )


def get_persisted_session_status(session_id: str) -> str | None:
    """Return the stored session status string, including unknown values.

    This read does not construct a Session model, so a future-version status
    can be classified without validation errors.
    """

    with _connect() as conn:
        row = conn.execute(
            "SELECT status FROM sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
    if row is None:
        return None
    return str(row["status"])


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

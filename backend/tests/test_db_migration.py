"""Regression coverage for upgrading the main-branch SQLite schema."""

from __future__ import annotations

import hashlib
import io
import json
import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import cli, db, main, providers
from backend.models import AgentConfig, FacilitatorConfig, SessionCreate
from backend.session_export import (
    build_session_export_payload,
    render_session_export_markdown,
    serialize_session_export_json,
)
from backend.session_run_lock import acquire_session_run_lock, session_run_lock_path

_MAIN_SCHEMA = """
CREATE TABLE sessions(
    id TEXT PRIMARY KEY,
    theme TEXT NOT NULL,
    constraints TEXT NOT NULL DEFAULT '',
    config_json TEXT NOT NULL,
    status TEXT NOT NULL,
    phase_progress TEXT NOT NULL DEFAULT '',
    metrics_json TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE ideas(
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
CREATE TABLE messages(
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    anon_name TEXT NOT NULL,
    persona_type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_ideas_session ON ideas(session_id);
CREATE INDEX idx_messages_session ON messages(session_id);
"""

_MAIN_SESSION_COLUMNS = (
    "id",
    "theme",
    "constraints",
    "config_json",
    "status",
    "phase_progress",
    "metrics_json",
    "created_at",
)
_MAIN_IDEA_COLUMNS = (
    "id",
    "session_id",
    "persona_type",
    "phase",
    "content",
    "cluster_id",
    "synthesized",
    "scores_json",
    "decision",
    "note",
    "created_at",
)
_MAIN_MESSAGE_COLUMNS = (
    "id",
    "session_id",
    "round",
    "anon_name",
    "persona_type",
    "content",
    "created_at",
)

UNSTARTED_SESSION_ID = "000000000001"
WHITESPACE_SESSION_ID = "000000000002"
STARTED_FRAMING_SESSION_ID = "000000000003"
DIVERGENCE_SESSION_ID = "000000000004"
DISCUSSION_SESSION_ID = "000000000005"
CONVERGENCE_SESSION_ID = "000000000006"
DONE_SESSION_ID = "000000000007"
ERROR_SESSION_ID = "000000000008"
UNKNOWN_SESSION_ID = "000000000009"

LEGACY_STARTED_SESSION_IDS = {
    STARTED_FRAMING_SESSION_ID,
    DIVERGENCE_SESSION_ID,
    DISCUSSION_SESSION_ID,
    CONVERGENCE_SESSION_ID,
}
LEGACY_UNCLAIMED_SESSION_IDS = {
    UNSTARTED_SESSION_ID,
    WHITESPACE_SESSION_ID,
    DONE_SESSION_ID,
    ERROR_SESSION_ID,
    UNKNOWN_SESSION_ID,
}


def _main_schema_session_config(theme: str) -> SessionCreate:
    """Build a valid persisted config for a main-schema fixture row."""

    return SessionCreate(
        theme=theme,
        constraints="Preserve every legacy field",
        ideas_per_agent=1,
        discussion_rounds=0,
        agents=[
            AgentConfig(persona_type="INTJ", provider="mock", model="mock"),
            AgentConfig(persona_type="ENFP", provider="mock", model="mock"),
        ],
        facilitator=FacilitatorConfig(provider="mock", model="mock"),
        enable_judge=False,
    )


def _create_main_schema_database(database_path: Path) -> None:
    """Create the exact main schema with every migration evidence category."""

    metrics_json = json.dumps(
        {
            "total_ideas": 2,
            "unique_ideas": 2,
            "non_duplicate_ratio": 1.0,
            "semantic_dispersion": 0.75,
            "collapse_alert": False,
        }
    )
    session_evidence = (
        (UNSTARTED_SESSION_ID, "framing", "", None),
        (WHITESPACE_SESSION_ID, "framing", " \t\n\u2003\u3000 ", None),
        (
            STARTED_FRAMING_SESSION_ID,
            "framing",
            "Structuring goal and rules",
            None,
        ),
        (DIVERGENCE_SESSION_ID, "divergence", "", None),
        (DISCUSSION_SESSION_ID, "discussion", "", None),
        (CONVERGENCE_SESSION_ID, "convergence", "", None),
        (DONE_SESSION_ID, "done", "Session completed", metrics_json),
        (ERROR_SESSION_ID, "error", "Provider failed", None),
        (UNKNOWN_SESSION_ID, "paused-by-future-version", "Opaque progress", None),
    )

    with sqlite3.connect(database_path) as conn:
        conn.executescript(_MAIN_SCHEMA)
        for ordinal, (session_id, status, phase_progress, stored_metrics) in enumerate(
            session_evidence,
            start=1,
        ):
            theme = f"Legacy migration row {session_id}"
            config = _main_schema_session_config(theme)
            conn.execute(
                "INSERT INTO sessions(id, theme, constraints, config_json, status, "
                "phase_progress, metrics_json, created_at) VALUES(?,?,?,?,?,?,?,?)",
                (
                    session_id,
                    theme,
                    config.constraints,
                    config.model_dump_json(),
                    status,
                    phase_progress,
                    stored_metrics,
                    f"2026-01-01T00:00:{ordinal:02d}+00:00",
                ),
            )

        conn.executemany(
            "INSERT INTO ideas(id, session_id, persona_type, phase, content, "
            "cluster_id, synthesized, scores_json, decision, note, created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (
                (
                    "100000000001",
                    DONE_SESSION_ID,
                    "INTJ",
                    "divergence",
                    "Use a transactional migration gate.",
                    4,
                    "Serialize migration decisions.",
                    json.dumps(
                        {
                            "novelty": 8,
                            "feasibility": 9,
                            "clarity": 10,
                            "total": 27,
                        }
                    ),
                    "adopted",
                    "Keep the evidence predicate explicit.",
                    "2026-01-01T01:00:00+00:00",
                ),
                (
                    "100000000002",
                    DONE_SESSION_ID,
                    "DISCUSSION:ENFP",
                    "discussion",
                    "Preserve unknown states rather than guessing.",
                    None,
                    None,
                    None,
                    "held",
                    "Review after the migration.",
                    "2026-01-01T01:01:00+00:00",
                ),
            ),
        )
        conn.executemany(
            "INSERT INTO messages(id, session_id, round, anon_name, persona_type, "
            "content, created_at) VALUES(?,?,?,?,?,?,?)",
            (
                (
                    "200000000001",
                    DONE_SESSION_ID,
                    0,
                    "Facilitator",
                    "FACILITATOR",
                    "Frame the legacy migration safely.",
                    "2026-01-01T00:30:00+00:00",
                ),
                (
                    "200000000002",
                    DONE_SESSION_ID,
                    1,
                    "Participant A",
                    "INTJ",
                    "Claims are evidence, not a blanket default.",
                    "2026-01-01T01:02:00+00:00",
                ),
            ),
        )


def _rows_with_named_columns(
    rows: list[tuple[object, ...]],
    columns: tuple[str, ...],
) -> list[dict[str, object]]:
    """Attach canonical main-schema column names to ordered SQLite rows."""

    return [dict(zip(columns, row, strict=True)) for row in rows]


def _canonical_main_data_snapshot(database_path: Path) -> dict[str, object]:
    """Hash and count only columns that existed on main before migration."""

    with sqlite3.connect(database_path) as conn:
        session_rows = conn.execute(
            "SELECT id, theme, constraints, config_json, status, phase_progress, "
            "metrics_json, created_at FROM sessions ORDER BY id"
        ).fetchall()
        idea_rows = conn.execute(
            "SELECT id, session_id, persona_type, phase, content, cluster_id, "
            "synthesized, scores_json, decision, note, created_at "
            "FROM ideas ORDER BY id"
        ).fetchall()
        message_rows = conn.execute(
            "SELECT id, session_id, round, anon_name, persona_type, content, "
            "created_at FROM messages ORDER BY id"
        ).fetchall()
        table_rows = {
            "sessions": _rows_with_named_columns(
                session_rows,
                _MAIN_SESSION_COLUMNS,
            ),
            "ideas": _rows_with_named_columns(idea_rows, _MAIN_IDEA_COLUMNS),
            "messages": _rows_with_named_columns(
                message_rows,
                _MAIN_MESSAGE_COLUMNS,
            ),
        }
    canonical_bytes = json.dumps(
        table_rows,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return {
        "sha256": hashlib.sha256(canonical_bytes).hexdigest(),
        "counts": {table: len(rows) for table, rows in table_rows.items()},
    }


def _done_session_export_payload() -> dict[str, object]:
    """Build the rich legacy export used for migration equality checks."""

    session = db.get_session(DONE_SESSION_ID)
    assert session is not None
    return build_session_export_payload(
        session,
        db.list_ideas(DONE_SESSION_ID),
        db.list_messages(DONE_SESSION_ID),
    )


def _read_raw_session_states(database_path: Path) -> dict[str, dict[str, object]]:
    """Read status, progress, and internal claim without model validation."""

    with sqlite3.connect(database_path) as conn:
        rows = conn.execute(
            "SELECT id, status, phase_progress, run_claimed FROM sessions ORDER BY id"
        ).fetchall()
    return {
        session_id: {
            "status": status,
            "phase_progress": phase_progress,
            "run_claimed": run_claimed,
        }
        for session_id, status, phase_progress, run_claimed in rows
    }


@pytest.fixture()
def main_schema_database(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Select a populated, pre-``run_claimed`` main database for each test."""

    database_path = tmp_path / "main-schema.db"
    monkeypatch.setenv("IZAYOI_DB_PATH", str(database_path))
    monkeypatch.delenv("EMBEDDING_MODEL", raising=False)

    async def disable_cloud_embeddings(texts: list[str]) -> None:
        return None

    monkeypatch.setattr(providers, "embed_texts", disable_cloud_embeddings)
    _create_main_schema_database(database_path)
    return database_path


def test_init_db_migrates_main_schema_once_without_changing_legacy_data(
    main_schema_database: Path,
) -> None:
    """The one-time ADD classifies evidence but preserves every old data field."""

    snapshot_before = _canonical_main_data_snapshot(main_schema_database)
    export_before = _done_session_export_payload()
    export_json_before = serialize_session_export_json(export_before)
    export_markdown_before = render_session_export_markdown(export_before)

    db.init_db()

    assert _canonical_main_data_snapshot(main_schema_database) == snapshot_before
    assert _done_session_export_payload() == export_before
    assert serialize_session_export_json(_done_session_export_payload()) == export_json_before
    assert render_session_export_markdown(_done_session_export_payload()) == export_markdown_before
    assert snapshot_before["counts"] == {"sessions": 9, "ideas": 2, "messages": 2}

    states_after_migration = _read_raw_session_states(main_schema_database)
    assert {
        session_id
        for session_id, state in states_after_migration.items()
        if state["run_claimed"] == 1
    } == LEGACY_STARTED_SESSION_IDS
    assert {
        session_id
        for session_id, state in states_after_migration.items()
        if state["run_claimed"] == 0
    } == LEGACY_UNCLAIMED_SESSION_IDS

    with sqlite3.connect(main_schema_database) as conn:
        conn.execute(
            """
            CREATE TRIGGER reject_repeat_migration_update
            BEFORE UPDATE ON sessions
            BEGIN
                SELECT RAISE(ABORT, 'current-schema row was updated by init_db');
            END
            """
        )
    db.init_db()

    assert _read_raw_session_states(main_schema_database) == states_after_migration
    assert _canonical_main_data_snapshot(main_schema_database) == snapshot_before


def test_legacy_null_and_unicode_whitespace_progress_remain_unclaimed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Malformed nullable progress is handled like blank main-schema progress."""

    database_path = tmp_path / "nullable-legacy-progress.db"
    monkeypatch.setenv("IZAYOI_DB_PATH", str(database_path))
    config = _main_schema_session_config("Nullable legacy progress")
    with sqlite3.connect(database_path) as conn:
        conn.execute(
            """
            CREATE TABLE sessions(
                id TEXT PRIMARY KEY,
                theme TEXT NOT NULL,
                constraints TEXT NOT NULL DEFAULT '',
                config_json TEXT NOT NULL,
                status TEXT NOT NULL,
                phase_progress TEXT,
                metrics_json TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.executemany(
            "INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?)",
            (
                (
                    "300000000001",
                    config.theme,
                    config.constraints,
                    config.model_dump_json(),
                    "framing",
                    None,
                    None,
                    "2026-01-02T00:00:01+00:00",
                ),
                (
                    "300000000002",
                    config.theme,
                    config.constraints,
                    config.model_dump_json(),
                    "framing",
                    "\t\n\r\u00a0\u2003\u3000",
                    None,
                    "2026-01-02T00:00:02+00:00",
                ),
                (
                    "300000000003",
                    config.theme,
                    config.constraints,
                    config.model_dump_json(),
                    "framing",
                    "  started  ",
                    None,
                    "2026-01-02T00:00:03+00:00",
                ),
            ),
        )

    db.init_db()

    with sqlite3.connect(database_path) as conn:
        claims = dict(
            conn.execute(
                "SELECT id, run_claimed FROM sessions ORDER BY id"
            ).fetchall()
        )
    assert claims == {
        "300000000001": 0,
        "300000000002": 0,
        "300000000003": 1,
    }


def test_two_lifespans_recover_only_started_legacy_rows_and_allow_unstarted_start(
    main_schema_database: Path,
) -> None:
    """First startup recovers evidence claims; second startup is idempotent."""

    expected_done_export = _done_session_export_payload()
    with TestClient(main.create_app()) as first_client:
        done_response = first_client.get(f"/api/sessions/{DONE_SESSION_ID}")
        ideas_response = first_client.get(f"/api/sessions/{DONE_SESSION_ID}/ideas")
        messages_response = first_client.get(
            f"/api/sessions/{DONE_SESSION_ID}/messages"
        )
        export_response = first_client.get(
            f"/api/sessions/{DONE_SESSION_ID}/export",
            params={"format": "json"},
        )

    states_after_first_lifespan = _read_raw_session_states(main_schema_database)
    for session_id in LEGACY_STARTED_SESSION_IDS:
        assert states_after_first_lifespan[session_id] == {
            "status": "error",
            "phase_progress": "Interrupted by server restart",
            "run_claimed": 1,
        }
    assert states_after_first_lifespan[UNSTARTED_SESSION_ID] == {
        "status": "framing",
        "phase_progress": "",
        "run_claimed": 0,
    }
    assert states_after_first_lifespan[WHITESPACE_SESSION_ID] == {
        "status": "framing",
        "phase_progress": " \t\n\u2003\u3000 ",
        "run_claimed": 0,
    }
    assert states_after_first_lifespan[DONE_SESSION_ID]["status"] == "done"
    assert states_after_first_lifespan[ERROR_SESSION_ID]["status"] == "error"
    assert states_after_first_lifespan[UNKNOWN_SESSION_ID] == {
        "status": "paused-by-future-version",
        "phase_progress": "Opaque progress",
        "run_claimed": 0,
    }

    assert done_response.status_code == 200
    assert set(done_response.json()) == {
        "id",
        "theme",
        "constraints",
        "status",
        "phase_progress",
        "agents",
        "created_at",
        "metrics",
    }
    assert ideas_response.status_code == 200
    assert ideas_response.json()["ideas"][0]["scores"] == {
        "novelty": 8,
        "feasibility": 9,
        "clarity": 10,
        "total": 27,
    }
    assert ideas_response.json()["ideas"][0]["decision"] == "adopted"
    assert ideas_response.json()["ideas"][0]["note"] == (
        "Keep the evidence predicate explicit."
    )
    assert messages_response.status_code == 200
    assert len(messages_response.json()["messages"]) == 2
    assert export_response.status_code == 200
    assert export_response.json() == expected_done_export

    with TestClient(main.create_app()) as second_client:
        assert _read_raw_session_states(main_schema_database) == (
            states_after_first_lifespan
        )
        start_response = second_client.post(
            f"/api/sessions/{UNSTARTED_SESSION_ID}/start"
        )
        stream_response = second_client.get(
            f"/api/sessions/{UNSTARTED_SESSION_ID}/stream"
        )

    assert start_response.status_code == 202
    assert start_response.json() == {"status": "started"}
    assert stream_response.status_code == 200
    started_session = db.get_session(UNSTARTED_SESSION_ID)
    assert started_session is not None
    assert started_session.status == "done"
    assert db.list_ideas(UNSTARTED_SESSION_ID)
    assert db.list_messages(UNSTARTED_SESSION_ID)


def test_unknown_claimed_status_is_not_destructively_recovered(
    main_schema_database: Path,
) -> None:
    """Recovery ignores claimed statuses unknown to this backend version."""

    db.init_db()
    with sqlite3.connect(main_schema_database) as conn:
        conn.execute(
            "UPDATE sessions SET run_claimed = 1 WHERE id = ?",
            (UNKNOWN_SESSION_ID,),
        )
    recovery_lock = acquire_session_run_lock(str(main_schema_database))
    try:
        recovered_count = db.recover_orphaned_session_runs(
            recovery_lock,
            recovery_reason="must not replace an unknown status",
        )
    finally:
        recovery_lock.release()

    unknown_state = _read_raw_session_states(main_schema_database)[UNKNOWN_SESSION_ID]
    assert recovered_count == len(LEGACY_STARTED_SESSION_IDS)
    assert unknown_state == {
        "status": "paused-by-future-version",
        "phase_progress": "Opaque progress",
        "run_claimed": 1,
    }


def test_concurrent_init_preserves_live_current_schema_claim(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Current-schema init calls never run the legacy evidence update."""

    database_path = tmp_path / "current-schema.db"
    monkeypatch.setenv("IZAYOI_DB_PATH", str(database_path))
    db.init_db()
    live_session = db.create_session(_main_schema_session_config("Live current row"))
    run_lock = acquire_session_run_lock(str(database_path))
    try:
        db.claim_session_run(run_lock, live_session.id)
        db.update_session_status(
            live_session.id,
            "discussion",
            "Live process owns this claim",
        )
        state_before = _read_raw_session_states(database_path)[live_session.id]

        with ThreadPoolExecutor(max_workers=6) as executor:
            futures = [executor.submit(db.init_db) for _ in range(6)]
            for future in futures:
                future.result(timeout=10)

        state_after = _read_raw_session_states(database_path)[live_session.id]
    finally:
        run_lock.release()

    assert state_before == {
        "status": "discussion",
        "phase_progress": "Live process owns this claim",
        "run_claimed": 1,
    }
    assert state_after == state_before
    with sqlite3.connect(database_path) as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        columns = {
            row[1] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()
        }
    assert "run_claimed" in columns


def test_migrated_main_database_supports_cli_run_export_api_and_hashed_lock(
    main_schema_database: Path,
) -> None:
    """The migrated DB remains compatible with CLI, Web API, and lock identity."""

    expected_legacy_export = _done_session_export_payload()
    export_stdout = io.StringIO()
    export_stderr = io.StringIO()
    export_exit = cli.main(
        ["export", DONE_SESSION_ID, "--format", "json"],
        stdout=export_stdout,
        stderr=export_stderr,
    )
    assert export_exit == cli.EXIT_SUCCESS
    assert export_stderr.getvalue() == ""
    assert json.loads(export_stdout.getvalue()) == expected_legacy_export

    expected_lock_digest = hashlib.sha256(
        os.fsencode(str(main_schema_database.resolve()))
    ).hexdigest()
    expected_lock_path = (
        main_schema_database.parent
        / ".izayoi-run-locks"
        / f"{expected_lock_digest}.lock"
    )
    assert session_run_lock_path(str(main_schema_database)) == expected_lock_path
    lock = acquire_session_run_lock(str(main_schema_database))
    lock.release()
    assert expected_lock_path.is_file()

    run_stdout = io.StringIO()
    run_stderr = io.StringIO()
    run_exit = cli.main(
        [
            "run",
            "--theme",
            "Run after upgrading the main database",
            "--persona",
            "INTJ",
            "ENFP",
            "--ideas-per-agent",
            "1",
            "--discussion-rounds",
            "0",
            "--no-judge",
            "--provider",
            "mock",
            "--model",
            "mock",
        ],
        stdout=run_stdout,
        stderr=run_stderr,
    )
    assert run_exit == cli.EXIT_SUCCESS, run_stderr.getvalue()
    run_export = json.loads(run_stdout.getvalue())
    assert run_export["session"]["status"] == "done"
    assert run_export["ideas"]
    assert run_export["messages"]

    new_session_id = run_export["session"]["id"]
    repeated_export_stdout = io.StringIO()
    assert cli.main(
        ["export", new_session_id],
        stdout=repeated_export_stdout,
        stderr=io.StringIO(),
    ) == cli.EXIT_SUCCESS
    assert json.loads(repeated_export_stdout.getvalue()) == run_export

    with TestClient(main.create_app()) as client:
        api_session = client.get(f"/api/sessions/{new_session_id}")
        api_export = client.get(
            f"/api/sessions/{new_session_id}/export",
            params={"format": "json"},
        )
    assert api_session.status_code == 200
    assert api_session.json() == run_export["session"]
    assert "run_claimed" not in api_session.json()
    assert api_export.status_code == 200
    assert api_export.json() == run_export

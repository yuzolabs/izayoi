"""Focused tests for the non-interactive ``izayoi run`` and ``export`` contracts."""

from __future__ import annotations

import asyncio
import errno
import hashlib
import io
import json
import os
import signal
import sqlite3
import stat
import subprocess
import sys
import threading
import time
import tomllib
import unittest.mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, TextIO

import pytest

from backend import cli, db, orchestrator, providers, session_run_lock
from backend.cli_sigterm import CliSigtermCancellation
from backend.models import (
    AgentConfig,
    DecisionUpdate,
    FacilitatorConfig,
    Idea,
    Session,
    SessionCreate,
)
from backend.session_export import (
    _fence_user_markdown,
    build_session_export_payload,
    render_session_export_markdown,
    serialize_session_export_json,
)
from backend.session_live_phase import SESSION_LIVE_PHASES
from backend.session_run_lock import (
    SessionRunLock,
    SessionRunLockOwnershipError,
    SessionRunLockUnavailable,
    acquire_session_run_lock,
)


_PAUSED_MOCK_CLI_RUN_SCRIPT = """
import asyncio
import sys
from pathlib import Path

from backend import cli, providers

ready_path = Path(sys.argv[1])
release_path = Path(sys.argv[2])
original_complete = providers.complete

async def complete_after_test_release(*args, **kwargs):
    ready_path.write_text("ready", encoding="utf-8")
    while not release_path.exists():
        await asyncio.sleep(0.02)
    return await original_complete(*args, **kwargs)

providers.complete = complete_after_test_release
raise SystemExit(
    cli.main(
        [
            "run",
            "--theme",
            "Cross-process lifespan race",
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
        ]
    )
)
"""

_PROVIDER_START_OBSERVER_CLI_RUN_SCRIPT = """
import sys
from pathlib import Path

from backend import cli, providers

provider_start_path = Path(sys.argv[1])
original_complete = providers.complete

async def complete_after_recording_provider_start(*args, **kwargs):
    provider_start_path.write_text("started", encoding="utf-8")
    return await original_complete(*args, **kwargs)

providers.complete = complete_after_recording_provider_start
raise SystemExit(
    cli.main(
        [
            "run",
            "--theme",
            "Competing cross-process run",
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
        ]
    )
)
"""

_SIGTERM_CLEANUP_CLI_RUN_SCRIPT = """
import asyncio
import sys
from pathlib import Path

from backend import cli, db, orchestrator, providers

provider_started_path = Path(sys.argv[1])
provider_cancelled_path = Path(sys.argv[2])
allow_provider_cleanup_path = Path(sys.argv[3])
provider_finally_path = Path(sys.argv[4])
runner_removed_path = Path(sys.argv[5])

async def complete_until_sigterm(*args, **kwargs):
    provider_started_path.write_text("started", encoding="utf-8")
    try:
        await asyncio.Event().wait()
    except asyncio.CancelledError:
        provider_cancelled_path.write_text("cancelled", encoding="utf-8")
        while not allow_provider_cleanup_path.exists():
            await asyncio.sleep(0.02)
        raise
    finally:
        provider_finally_path.write_text("finished", encoding="utf-8")

providers.complete = complete_until_sigterm
exit_code = cli.main(
    [
        "run",
        "--theme",
        "Graceful SIGTERM cleanup",
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
    ]
)
sessions = db.list_sessions()
if len(sessions) == 1 and orchestrator.get_runner(sessions[0].id) is None:
    runner_removed_path.write_text("removed", encoding="utf-8")
raise SystemExit(exit_code)
"""

_UNRESPONSIVE_HTTP_CLI_RUN_SCRIPT = """
import sys
from pathlib import Path

import httpx

from backend import cli, db, orchestrator, providers

stall_url = sys.argv[1]
ready_path = Path(sys.argv[2])
runner_removed_path = Path(sys.argv[3])
timeout_flag = sys.argv[4]

async def complete_against_unresponsive_http(*args, **kwargs):
    ready_path.write_text("ready", encoding="utf-8")
    async with httpx.AsyncClient(timeout=None) as client:
        await client.post(stall_url, json={"model": "stall", "messages": []})
    raise RuntimeError("unresponsive chat completions endpoint returned unexpectedly")

providers.complete = complete_against_unresponsive_http
exit_code = cli.main(
    [
        "run",
        "--theme",
        "Unresponsive provider timeout",
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
        "--timeout",
        timeout_flag,
    ]
)
sessions = db.list_sessions()
if len(sessions) == 1 and orchestrator.get_runner(sessions[0].id) is None:
    runner_removed_path.write_text("removed", encoding="utf-8")
raise SystemExit(exit_code)
"""

_EARLY_SIGTERM_CLI_RUN_SCRIPT = """
import asyncio
import sys
from pathlib import Path

from backend import cli, orchestrator

handler_active_path = Path(sys.argv[1])
cleanup_complete_path = Path(sys.argv[2])

async def pause_before_session_claim(config):
    handler_active_path.write_text("active", encoding="utf-8")
    await asyncio.Event().wait()

orchestrator.create_and_start_session = pause_before_session_claim
exit_code = cli.main(["run", "--theme", "Early SIGTERM"])
cleanup_complete_path.write_text("complete", encoding="utf-8")
raise SystemExit(exit_code)
"""


def _start_paused_mock_cli_run(
    ready_path: Path,
    release_path: Path,
    *,
    working_directory: Path | None = None,
    environment: dict[str, str] | None = None,
) -> subprocess.Popen:
    """Start a real CLI process paused inside framing while its run lock is held."""

    return subprocess.Popen(
        [
            sys.executable,
            "-c",
            _PAUSED_MOCK_CLI_RUN_SCRIPT,
            str(ready_path),
            str(release_path),
        ],
        cwd=working_directory or Path(__file__).resolve().parents[2],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


class _UnresponsiveChatCompletionsHandler(BaseHTTPRequestHandler):
    """Accept ``POST /v1/chat/completions`` and never write an HTTP response."""

    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length:
            try:
                self.rfile.read(length)
            except OSError:
                return
        try:
            while not getattr(self.server, "stop_unresponsive_handlers", False):
                time.sleep(0.05)
        except OSError:
            return

    def log_message(self, format: str, *args: object) -> None:
        del format, args


def _start_unresponsive_chat_completions_server() -> tuple[ThreadingHTTPServer, str]:
    """Serve a localhost OpenAI chat-completions path that never responds."""

    server = ThreadingHTTPServer(("127.0.0.1", 0), _UnresponsiveChatCompletionsHandler)
    server.stop_unresponsive_handlers = False
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    return server, f"http://{host}:{port}/v1/chat/completions"


def _stop_unresponsive_chat_completions_server(server: ThreadingHTTPServer) -> None:
    """Unblock hung POST handlers, then close the stall HTTP server."""

    server.stop_unresponsive_handlers = True
    server.shutdown()
    server.server_close()


def _start_unresponsive_http_cli_run(
    stall_url: str,
    ready_path: Path,
    runner_removed_path: Path,
    timeout_flag: str,
    *,
    environment: dict[str, str] | None = None,
) -> subprocess.Popen:
    """Start a CLI whose provider POSTs to an unresponsive chat-completions URL."""

    return subprocess.Popen(
        [
            sys.executable,
            "-c",
            _UNRESPONSIVE_HTTP_CLI_RUN_SCRIPT,
            stall_url,
            str(ready_path),
            str(runner_removed_path),
            timeout_flag,
        ],
        cwd=Path(__file__).resolve().parents[2],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _start_sigterm_cleanup_cli_run(
    provider_started_path: Path,
    provider_cancelled_path: Path,
    allow_provider_cleanup_path: Path,
    provider_finally_path: Path,
    runner_removed_path: Path,
) -> subprocess.Popen:
    """Start a CLI whose provider exposes cancellation and cleanup markers."""

    return subprocess.Popen(
        [
            sys.executable,
            "-c",
            _SIGTERM_CLEANUP_CLI_RUN_SCRIPT,
            str(provider_started_path),
            str(provider_cancelled_path),
            str(allow_provider_cleanup_path),
            str(provider_finally_path),
            str(runner_removed_path),
        ],
        cwd=Path(__file__).resolve().parents[2],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _build_cli_subprocess_environment(
    database_path: str,
    temporary_directory: Path,
) -> dict[str, str]:
    """Build a source-tree CLI environment with explicit DB and temp identities."""

    project_root = Path(__file__).resolve().parents[2]
    environment = os.environ.copy()
    environment["IZAYOI_DB_PATH"] = database_path
    environment["TMPDIR"] = str(temporary_directory)
    environment["TMP"] = str(temporary_directory)
    environment["TEMP"] = str(temporary_directory)
    existing_python_path = environment.get("PYTHONPATH")
    environment["PYTHONPATH"] = os.pathsep.join(
        path
        for path in (str(project_root), existing_python_path)
        if path
    )
    return environment


def _run_cli_export_subprocess(
    database_path: Path,
    temporary_directory: Path,
    session_id: str = "0123456789ab",
    extra_arguments: list[str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run ``izayoi export`` against one explicit database path in a child process."""

    return subprocess.run(
        [
            sys.executable,
            "-m",
            "backend.cli",
            "export",
            session_id,
            *(extra_arguments or ()),
        ],
        cwd=Path(__file__).resolve().parents[2],
        env=_build_cli_subprocess_environment(
            str(database_path),
            temporary_directory,
        ),
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )


def _persisted_session_export_snapshot(
    database_path: Path,
    session_id: str,
) -> tuple[tuple[object, ...], list[tuple[object, ...]], list[tuple[object, ...]]]:
    """Capture session, idea, and message rows so export cannot mutate them."""

    with sqlite3.connect(database_path) as conn:
        session_row = conn.execute(
            "SELECT * FROM sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        idea_rows = conn.execute(
            "SELECT * FROM ideas WHERE session_id = ? ORDER BY id",
            (session_id,),
        ).fetchall()
        message_rows = conn.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY id",
            (session_id,),
        ).fetchall()
    assert session_row is not None
    return (
        tuple(session_row),
        [tuple(row) for row in idea_rows],
        [tuple(row) for row in message_rows],
    )


def _assert_cli_export_refuses_live_session(
    completed: subprocess.CompletedProcess[str],
    session_id: str,
    status: str,
) -> None:
    """Require rc 1, one stderr line, empty stdout, and no finished transcript."""

    assert completed.returncode == cli.EXIT_RUNTIME_ERROR
    assert completed.stdout == ""
    assert completed.stderr == (
        f"izayoi: error: session '{session_id}' is still running (status={status})\n"
    )
    assert "Traceback" not in completed.stderr
    assert "# izayoi brainstorming session" not in completed.stdout
    assert '"ideas"' not in completed.stdout
    assert "## Ideas" not in completed.stdout


def _brainstorm_database_row_counts(database_path: Path) -> dict[str, int]:
    """Count persisted result rows so a rejected runner cannot mutate the DB."""

    with sqlite3.connect(database_path) as conn:
        return {
            "sessions": conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0],
            "ideas": conn.execute("SELECT COUNT(*) FROM ideas").fetchone()[0],
            "messages": conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0],
        }


def _wait_for_subprocess_marker(
    marker_path: Path,
    process: subprocess.Popen,
    timeout: float = 10.0,
) -> None:
    """Wait until a child creates its readiness marker or fail with its output."""

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if marker_path.exists():
            return
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            raise AssertionError(
                f"subprocess exited before readiness marker: stdout={stdout!r}, stderr={stderr!r}"
            )
        time.sleep(0.02)
    raise AssertionError(f"subprocess did not create readiness marker {marker_path}")


def _read_session_states_during_web_lifespan(
    *session_ids: str,
) -> dict[str, dict[str, str]]:
    """Read persisted session states from a real Web lifespan process."""

    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import json, sys\n"
                "from fastapi.testclient import TestClient\n"
                "from backend import db, main\n"
                "with TestClient(main.create_app()):\n"
                "    states = {}\n"
                "    for session_id in sys.argv[1:]:\n"
                "        session = db.get_session(session_id)\n"
                "        states[session_id] = {\"status\": session.status, "
                "\"phase_progress\": session.phase_progress}\n"
                "    print(json.dumps(states))\n"
            ),
            *session_ids,
        ],
        cwd=Path(__file__).resolve().parents[2],
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def _leave_claimed_session_without_owner(session_id: str) -> None:
    """Simulate a process exit after its durable claim but before terminal status."""

    run_lock = acquire_session_run_lock(db.db_path())
    try:
        claimed = db.claim_session_run(run_lock, session_id)
        assert claimed.session.id == session_id
    finally:
        run_lock.release()


def _session_has_run_claim(database_path: Path, session_id: str) -> bool:
    """Read the internal durable run-claim marker for an invariant assertion."""

    with sqlite3.connect(database_path) as conn:
        row = conn.execute(
            "SELECT run_claimed FROM sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
    assert row is not None
    return bool(row[0])


def _require_posix_pipe_size_control() -> None:
    """Skip when this platform cannot shrink a pipe to 4096 bytes."""

    if sys.platform == "win32":
        pytest.skip("4096-byte pipe EPIPE shutdown behavior is POSIX-specific")
    import fcntl

    if not hasattr(fcntl, "F_SETPIPE_SZ"):
        pytest.skip("F_SETPIPE_SZ is required to reproduce a 4096-byte pipe")


def _set_posix_pipe_size(pipe_fd: int, pipe_size: int) -> None:
    """Set F_SETPIPE_SZ so a large stdout write blocks until the reader closes."""

    import fcntl

    fcntl.fcntl(pipe_fd, fcntl.F_SETPIPE_SZ, pipe_size)


def _assert_cli_broken_pipe_exit_contract(returncode: int, stderr_text: str) -> None:
    """A closed pipe must stay in {0, 1} without CPython 120 diagnostics."""

    assert returncode in {cli.EXIT_SUCCESS, cli.EXIT_RUNTIME_ERROR}, returncode
    assert returncode != cli.EXIT_BROKEN_PIPE_SHUTDOWN
    assert "Exception ignored" not in stderr_text
    assert "Traceback" not in stderr_text


def _require_proc_self_fd_listing() -> None:
    """Skip when this platform cannot count open fds via /proc/self/fd."""

    if sys.platform == "win32" or not os.path.isdir("/proc/self/fd"):
        pytest.skip("/proc/self/fd is required to count open file descriptors")


def _count_open_process_file_descriptors() -> int:
    """Count live descriptors so a leaked /dev/null open is visible."""

    return len(os.listdir("/proc/self/fd"))


def _open_broken_cli_pipe_text_stream() -> TextIO:
    """Return a text stream whose reader is already closed so the next write is EPIPE."""

    read_fd, write_fd = os.pipe()
    os.close(read_fd)
    return os.fdopen(write_fd, "w", encoding="utf-8", closefd=True)


def _replace_cli_stream_fd_with_broken_pipe(stream: TextIO) -> None:
    """Retarget an existing CLI stream fileno at a fresh closed-reader pipe."""

    stream_fd = stream.fileno()
    read_fd, write_fd = os.pipe()
    try:
        os.close(read_fd)
        read_fd = -1
        os.dup2(write_fd, stream_fd)
    finally:
        if read_fd >= 0:
            os.close(read_fd)
        os.close(write_fd)


def _close_cli_pipe_text_stream(stream: TextIO) -> None:
    """Close a CLI pipe stream without letting a leftover EPIPE escape."""

    try:
        cli.redirect_broken_cli_pipe_stream_to_devnull(stream)
    except OSError:
        pass
    try:
        stream.close()
    except OSError:
        pass


def _run_cli_with_short_lived_stdout_pipe(
    arguments: list[str],
    *,
    environment: dict[str, str],
    pipe_size: int | None = 4096,
    merge_stderr: bool = False,
) -> tuple[int, str, str]:
    """Start a real CLI process, read one stdout line, then close the reader."""

    read_fd, write_fd = os.pipe()
    if pipe_size is not None:
        try:
            _set_posix_pipe_size(write_fd, pipe_size)
        except OSError as exc:
            os.close(read_fd)
            os.close(write_fd)
            pytest.skip(f"could not set pipe size to {pipe_size}: {exc}")

    process = subprocess.Popen(
        [sys.executable, "-m", "backend.cli", *arguments],
        cwd=Path(__file__).resolve().parents[2],
        env=environment,
        stdout=write_fd,
        stderr=write_fd if merge_stderr else subprocess.PIPE,
        text=True,
    )
    os.close(write_fd)
    first_line = ""
    stderr_text = ""
    try:
        reader = os.fdopen(read_fd, "r", encoding="utf-8", closefd=True)
        read_fd = -1
        first_line = reader.readline()
        reader.close()
        if merge_stderr:
            process.wait(timeout=30)
        else:
            _, stderr_text = process.communicate(timeout=30)
    finally:
        if read_fd >= 0:
            os.close(read_fd)
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=10)
    assert process.returncode is not None
    return process.returncode, first_line, stderr_text


@pytest.fixture()
def cli_temp_db(tmp_path, monkeypatch):
    """Point CLI persistence at a throwaway DB and keep embeddings offline."""

    database_path = tmp_path / "cli.db"
    monkeypatch.setenv("IZAYOI_DB_PATH", str(database_path))
    monkeypatch.delenv("EMBEDDING_MODEL", raising=False)

    async def no_cloud_embeddings(texts):
        return None

    monkeypatch.setattr(providers, "embed_texts", no_cloud_embeddings)
    yield database_path


@pytest.mark.parametrize(
    ("arguments", "expected_fragments"),
    [
        (
            ["--help"],
            (
                "{run,export}",
                "[-h] [-V]",
                'izayoi run --theme "Improve onboarding"',
                "izayoi export SESSION_ID",
                "izayoi --version",
                "izayoi -V",
                "top-level only",
                "--theme -",
                "IZAYOI_DB_PATH",
                "only result data to stdout",
                "all errors",
                "provider 'openai' requires OPENAI_API_KEY",
                "openai requires OPENAI_API_KEY",
            ),
        ),
        (
            ["run", "--help"],
            (
                "--theme TEXT|-",
                "printf 'Improve onboarding' | izayoi run --theme -",
                "4 balanced personas",
                "default: json",
                "default: -",
                "Progress and",
                "errors go to stderr",
                "izayoi --version",
                "izayoi run --version is not accepted",
                "--timeout",
                "default: 900",
                "0 disables",
                "provider 'openai' requires OPENAI_API_KEY",
                "openai requires OPENAI_API_KEY",
                "GEMINI_API_KEY or GOOGLE_API_KEY",
                "API key environment variable",
            ),
        ),
        (
            ["export", "--help"],
            (
                "izayoi export SESSION_ID",
                "--format json|md",
                "default: json",
                "default: -",
                "IZAYOI_DB_PATH",
                "successful file export is",
                "errors go to stderr",
                "live-phase status",
                "still running (status=framing)",
                "unknown status",
                "finished transcript",
                "izayoi --version",
                "izayoi export --version is not accepted",
            ),
        ),
    ],
    ids=("top-level", "run", "export"),
)
def test_command_help_describes_examples_defaults_and_streams(
    arguments,
    expected_fragments,
):
    completed = subprocess.run(
        [sys.executable, "-m", "backend.cli", *arguments],
        cwd=Path(__file__).resolve().parents[2],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == cli.EXIT_SUCCESS
    for fragment in expected_fragments:
        assert fragment in completed.stdout
    assert completed.stderr == ""


def test_mock_run_reads_theme_from_stdin_and_emits_one_json_object(cli_temp_db):
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        [
            "run",
            "--theme",
            "-",
            "--constraints",
            "\u2003  Keep the CLI local  \u3000",
            "--balanced",
            "4",
            "--ideas-per-agent",
            "1",
            "--discussion-rounds",
            "0",
            "--judge",
            "off",
            "--provider",
            "mock",
            "--model",
            "mock",
            "--format",
            "json",
            "--output",
            "-",
        ],
        stdin=io.StringIO("\u3000  Improve CLI onboarding  \u00a0\n"),
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_SUCCESS
    exported = json.loads(stdout.getvalue())
    assert set(exported) == {"session", "ideas", "messages"}
    assert exported["session"]["status"] == "done"
    assert exported["session"]["theme"] == "Improve CLI onboarding"
    assert exported["session"]["constraints"] == "Keep the CLI local"
    persisted_session = db.get_session(exported["session"]["id"])
    assert persisted_session is not None
    assert persisted_session.theme == "Improve CLI onboarding"
    assert persisted_session.constraints == "Keep the CLI local"
    assert len(exported["session"]["agents"]) == 4
    assert exported["ideas"]
    assert all(idea["session_id"] == exported["session"]["id"] for idea in exported["ideas"])
    assert stdout.getvalue().lstrip().startswith("{")
    assert "izayoi:" not in stdout.getvalue()
    assert "created session" in stderr.getvalue()
    assert "completed session" in stderr.getvalue()
    assert "Traceback" not in stderr.getvalue()

    released_run_lock = acquire_session_run_lock(str(cli_temp_db))
    released_run_lock.release()


@pytest.fixture()
def persisted_cli_export(cli_temp_db):
    """Store one complete session for export-only command tests."""

    db.init_db()
    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    session = db.create_session(
        SessionCreate(
            theme="Persisted CLI export",
            agents=[agent, agent],
            facilitator=FacilitatorConfig(provider="mock", model="mock"),
        )
    )
    db.insert_message(
        session.id,
        0,
        "Facilitator",
        "FACILITATOR",
        "Frame the persisted export.",
    )
    db.insert_idea(
        session.id,
        "INTJ",
        "divergence",
        "Reuse the shared session export renderer.",
    )
    db.update_session_status(session.id, "done", "Session completed")

    persisted_session = db.get_session(session.id)
    assert persisted_session is not None
    payload = build_session_export_payload(
        persisted_session,
        db.list_ideas(session.id),
        db.list_messages(session.id),
    )
    return session.id, payload


@pytest.mark.parametrize(
    ("output_format", "extra_arguments", "render_export"),
    [
        ("json", [], serialize_session_export_json),
        ("md", ["--format", "md"], render_session_export_markdown),
    ],
    ids=("default-json", "markdown"),
)
def test_export_stdout_uses_shared_web_renderer(
    persisted_cli_export,
    output_format,
    extra_arguments,
    render_export,
):
    session_id, payload = persisted_cli_export
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        ["export", session_id, *extra_arguments],
        stdin=io.StringIO(),
        stdout=stdout,
        stderr=stderr,
    )

    rendered_export = render_export(payload)
    expected_output = (
        rendered_export if rendered_export.endswith("\n") else f"{rendered_export}\n"
    )
    assert exit_code == cli.EXIT_SUCCESS
    assert stdout.getvalue() == expected_output
    if output_format == "json":
        assert json.loads(stdout.getvalue()) == payload
    else:
        assert stdout.getvalue().startswith(f"# izayoi brainstorming session {session_id}\n")
    assert stderr.getvalue() == ""


def test_export_file_is_exact_and_quiet(persisted_cli_export, tmp_path):
    session_id, payload = persisted_cli_export
    output_path = tmp_path / "session.json"
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        ["export", session_id, "--format", "json", "--output", str(output_path)],
        stdin=io.StringIO(),
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_SUCCESS
    assert output_path.read_text(encoding="utf-8") == (
        f"{serialize_session_export_json(payload)}\n"
    )
    assert stdout.getvalue() == ""
    assert stderr.getvalue() == ""


@pytest.mark.parametrize(
    ("raw_note", "stored_note"),
    [
        (f"\u3000{'n' * 2000}\u00a0", "n" * 2000),
        (" \u00a0\u2003\u3000 ", ""),
        ("\u00a0\u3000  Keep this note  \u2003", "Keep this note"),
    ],
    ids=("note-trimmed-2000", "note-unicode-blank-clear", "note-unicode-strip"),
)
def test_cli_export_uses_normalized_decision_note(
    cli_temp_db,
    raw_note,
    stored_note,
):
    db.init_db()
    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    session = db.create_session(
        SessionCreate(
            theme="Decision note export",
            agents=[agent, agent],
            facilitator=FacilitatorConfig(provider="mock", model="mock"),
        )
    )
    idea = db.insert_idea(session.id, "INTJ", "divergence", "Export this decision note")
    decision_update = DecisionUpdate.model_validate(
        {"decision": "adopted", "note": raw_note}
    )
    updated = db.update_idea_decision(
        idea.id,
        decision_update.decision,
        decision_update.note,
    )
    assert updated is not None
    assert updated.note == stored_note
    db.update_session_status(session.id, "done", "Session completed")

    json_stdout = io.StringIO()
    markdown_stdout = io.StringIO()
    stderr = io.StringIO()

    json_exit = cli.main(
        ["export", session.id],
        stdin=io.StringIO(),
        stdout=json_stdout,
        stderr=stderr,
    )
    markdown_exit = cli.main(
        ["export", session.id, "--format", "md"],
        stdin=io.StringIO(),
        stdout=markdown_stdout,
        stderr=stderr,
    )

    exported = json.loads(json_stdout.getvalue())
    exported_idea = next(item for item in exported["ideas"] if item["id"] == idea.id)
    assert json_exit == cli.EXIT_SUCCESS
    assert markdown_exit == cli.EXIT_SUCCESS
    assert exported_idea["note"] == stored_note
    if stored_note:
        markdown = markdown_stdout.getvalue()
        assert "- Note:" in markdown
        assert _fence_user_markdown(stored_note) in markdown
        assert f"- Note: {stored_note}" not in markdown
    else:
        assert "- Note:" not in markdown_stdout.getvalue()


def test_export_missing_session_exits_one_without_traceback(cli_temp_db):
    db.init_db()
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        ["export", "000000000000"],
        stdin=io.StringIO(),
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_RUNTIME_ERROR
    assert stdout.getvalue() == ""
    assert "session '000000000000' not found" in stderr.getvalue()
    assert "Traceback" not in stderr.getvalue()


def test_export_missing_database_file_exits_one_without_creating_database(tmp_path):
    """A missing IZAYOI_DB_PATH must not become an empty DB or lock directory."""

    database_parent = tmp_path / "existing-parent"
    database_parent.mkdir()
    database_path = database_parent / "missing.db"
    lock_directory = database_parent / ".izayoi-run-locks"
    temporary_directory = tmp_path / "tmp"
    temporary_directory.mkdir()

    completed = _run_cli_export_subprocess(database_path, temporary_directory)

    assert completed.returncode == cli.EXIT_RUNTIME_ERROR
    assert completed.stdout == ""
    assert completed.stderr == (
        f"izayoi: error: database '{database_path}' does not exist\n"
    )
    assert completed.stderr.count("\n") == 1
    assert "Traceback" not in completed.stderr
    assert "session " not in completed.stderr
    assert not database_path.exists()
    assert not lock_directory.exists()
    assert list(database_parent.iterdir()) == []


def test_export_database_directory_exits_one_without_traceback(tmp_path):
    """A directory IZAYOI_DB_PATH must keep the existing SQLite open rejection."""

    database_path = tmp_path / "directory.db"
    database_path.mkdir()
    temporary_directory = tmp_path / "tmp"
    temporary_directory.mkdir()

    completed = _run_cli_export_subprocess(database_path, temporary_directory)

    assert completed.returncode == cli.EXIT_RUNTIME_ERROR
    assert completed.stdout == ""
    assert completed.stderr == "izayoi: error: unable to open database file\n"
    assert completed.stderr.count("\n") == 1
    assert "Traceback" not in completed.stderr
    assert database_path.is_dir()
    assert not (tmp_path / ".izayoi-run-locks").exists()


def test_export_non_sqlite_database_bytes_exits_one_without_traceback(tmp_path):
    """Non-SQLite bytes at IZAYOI_DB_PATH must keep the existing file rejection."""

    database_path = tmp_path / "not-sqlite.db"
    junk_bytes = b"not a sqlite database!!!!"
    database_path.write_bytes(junk_bytes)
    temporary_directory = tmp_path / "tmp"
    temporary_directory.mkdir()

    completed = _run_cli_export_subprocess(database_path, temporary_directory)

    assert completed.returncode == cli.EXIT_RUNTIME_ERROR
    assert completed.stdout == ""
    assert completed.stderr == "izayoi: error: file is not a database\n"
    assert completed.stderr.count("\n") == 1
    assert "Traceback" not in completed.stderr
    assert database_path.read_bytes() == junk_bytes
    assert not (tmp_path / ".izayoi-run-locks").exists()


def test_export_chmod_000_database_file_exits_one_without_traceback(tmp_path):
    """A chmod 000 database file must keep the existing unreadable-file rejection."""

    database_path = tmp_path / "unreadable.db"
    database_path.write_bytes(b"x")
    database_path.chmod(0o000)
    temporary_directory = tmp_path / "tmp"
    temporary_directory.mkdir()
    try:
        completed = _run_cli_export_subprocess(database_path, temporary_directory)

        assert completed.returncode == cli.EXIT_RUNTIME_ERROR
        assert completed.stdout == ""
        assert completed.stderr == "izayoi: error: unable to open database file\n"
        assert completed.stderr.count("\n") == 1
        assert "Traceback" not in completed.stderr
        assert database_path.exists()
        assert not (tmp_path / ".izayoi-run-locks").exists()
    finally:
        database_path.chmod(0o644)


def test_export_invalid_session_id_exits_two_without_opening_database(cli_temp_db):
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        ["export", "not-a-session"],
        stdin=io.StringIO(),
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_USAGE_ERROR
    assert not cli_temp_db.exists()
    assert stdout.getvalue() == ""
    assert "invalid session ID" in stderr.getvalue()
    assert "Traceback" not in stderr.getvalue()


def test_export_write_failure_exits_one_without_traceback(
    persisted_cli_export,
    tmp_path,
):
    session_id, _ = persisted_cli_export
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        [
            "export",
            session_id,
            "--output",
            str(tmp_path / "missing-parent" / "session.json"),
        ],
        stdin=io.StringIO(),
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_RUNTIME_ERROR
    assert stdout.getvalue() == ""
    assert "could not write result" in stderr.getvalue()
    assert "Traceback" not in stderr.getvalue()


def _create_export_status_fixture_session(theme: str):
    """Create one session with an idea so a leaked export would have a body."""

    db.init_db()
    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    session = db.create_session(
        SessionCreate(
            theme=theme,
            agents=[agent, agent],
            facilitator=FacilitatorConfig(provider="mock", model="mock"),
        )
    )
    db.insert_idea(
        session.id,
        "INTJ",
        "divergence",
        "Do not leak this idea from a live or unknown session.",
    )
    return session


@pytest.mark.parametrize("live_status", SESSION_LIVE_PHASES)
def test_export_refuses_each_session_live_phase_status(
    cli_temp_db,
    tmp_path,
    live_status,
):
    session = _create_export_status_fixture_session(f"Live {live_status} export")
    db.update_session_status(session.id, live_status, f"In {live_status}")
    snapshot_before = _persisted_session_export_snapshot(cli_temp_db, session.id)

    for extra_arguments in ([], ["--format", "md"]):
        completed = _run_cli_export_subprocess(
            cli_temp_db,
            tmp_path,
            session.id,
            extra_arguments=extra_arguments,
        )
        _assert_cli_export_refuses_live_session(completed, session.id, live_status)

    assert _persisted_session_export_snapshot(cli_temp_db, session.id) == snapshot_before
    released_run_lock = acquire_session_run_lock(str(cli_temp_db))
    released_run_lock.release()


def test_export_writes_complete_payload_for_done_and_error_status(
    cli_temp_db,
    tmp_path,
):
    for terminal_status, phase_progress in (
        ("done", "Session completed"),
        ("error", "provider failed"),
    ):
        session = _create_export_status_fixture_session(
            f"Terminal {terminal_status} export"
        )
        db.insert_message(
            session.id,
            0,
            "Facilitator",
            "FACILITATOR",
            f"Frame the {terminal_status} export.",
        )
        db.update_session_status(session.id, terminal_status, phase_progress)
        persisted_session = db.get_session(session.id)
        assert persisted_session is not None
        expected_payload = build_session_export_payload(
            persisted_session,
            db.list_ideas(session.id),
            db.list_messages(session.id),
        )

        json_export = _run_cli_export_subprocess(
            cli_temp_db,
            tmp_path,
            session.id,
        )
        markdown_export = _run_cli_export_subprocess(
            cli_temp_db,
            tmp_path,
            session.id,
            extra_arguments=["--format", "md"],
        )

        rendered_markdown = render_session_export_markdown(expected_payload)
        expected_markdown = (
            rendered_markdown
            if rendered_markdown.endswith("\n")
            else f"{rendered_markdown}\n"
        )
        assert json_export.returncode == cli.EXIT_SUCCESS
        assert json_export.stderr == ""
        assert json.loads(json_export.stdout) == expected_payload
        assert markdown_export.returncode == cli.EXIT_SUCCESS
        assert markdown_export.stderr == ""
        assert markdown_export.stdout == expected_markdown


def test_export_refuses_unknown_status_without_mutating_rows(cli_temp_db, tmp_path):
    session = _create_export_status_fixture_session("Unknown status export")
    with sqlite3.connect(cli_temp_db) as conn:
        conn.execute(
            "UPDATE sessions SET status = ? WHERE id = ?",
            ("paused-by-future-version", session.id),
        )
    snapshot_before = _persisted_session_export_snapshot(cli_temp_db, session.id)

    for extra_arguments in ([], ["--format", "md"]):
        completed = _run_cli_export_subprocess(
            cli_temp_db,
            tmp_path,
            session.id,
            extra_arguments=extra_arguments,
        )
        assert completed.returncode == cli.EXIT_RUNTIME_ERROR
        assert completed.stdout == ""
        assert completed.stderr == (
            f"izayoi: error: session '{session.id}' has unknown status "
            f"'paused-by-future-version'\n"
        )
        assert "Traceback" not in completed.stderr
        assert "# izayoi brainstorming session" not in completed.stdout
        assert "## Ideas" not in completed.stdout

    assert _persisted_session_export_snapshot(cli_temp_db, session.id) == snapshot_before


def test_export_refuses_paused_live_run_then_exports_completed_result(
    cli_temp_db,
    tmp_path,
):
    ready_path = tmp_path / "paused-export-ready"
    release_path = tmp_path / "release-paused-export"
    cli_process = _start_paused_mock_cli_run(ready_path, release_path)
    cli_stdout = ""
    cli_stderr = ""
    try:
        _wait_for_subprocess_marker(ready_path, cli_process)
        running_sessions = db.list_sessions()
        assert len(running_sessions) == 1
        running_session = running_sessions[0]
        assert running_session.status == "framing"
        assert _session_has_run_claim(cli_temp_db, running_session.id)
        snapshot_before = _persisted_session_export_snapshot(
            cli_temp_db,
            running_session.id,
        )
        with pytest.raises(SessionRunLockUnavailable):
            acquire_session_run_lock(str(cli_temp_db))

        for extra_arguments in ([], ["--format", "md"]):
            completed = _run_cli_export_subprocess(
                cli_temp_db,
                tmp_path,
                running_session.id,
                extra_arguments=extra_arguments,
            )
            _assert_cli_export_refuses_live_session(
                completed,
                running_session.id,
                "framing",
            )

        assert _persisted_session_export_snapshot(
            cli_temp_db,
            running_session.id,
        ) == snapshot_before
        assert cli_process.poll() is None
        with pytest.raises(SessionRunLockUnavailable):
            acquire_session_run_lock(str(cli_temp_db))
    finally:
        release_path.touch()
        try:
            cli_stdout, cli_stderr = cli_process.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            cli_process.kill()
            cli_stdout, cli_stderr = cli_process.communicate(timeout=10)

    assert cli_process.returncode == cli.EXIT_SUCCESS, cli_stderr
    completed_payload = json.loads(cli_stdout)
    assert completed_payload["session"]["id"] == running_session.id
    assert completed_payload["session"]["status"] == "done"
    assert completed_payload["ideas"]

    json_export = _run_cli_export_subprocess(
        cli_temp_db,
        tmp_path,
        running_session.id,
    )
    markdown_export = _run_cli_export_subprocess(
        cli_temp_db,
        tmp_path,
        running_session.id,
        extra_arguments=["--format", "md"],
    )

    assert json_export.returncode == cli.EXIT_SUCCESS
    assert json_export.stderr == ""
    assert json.loads(json_export.stdout) == completed_payload
    rendered_markdown = render_session_export_markdown(completed_payload)
    expected_markdown = (
        rendered_markdown
        if rendered_markdown.endswith("\n")
        else f"{rendered_markdown}\n"
    )
    assert markdown_export.returncode == cli.EXIT_SUCCESS
    assert markdown_export.stderr == ""
    assert markdown_export.stdout.startswith(
        f"# izayoi brainstorming session {running_session.id}\n"
    )
    assert "- **Status:** done" in markdown_export.stdout
    assert markdown_export.stdout == expected_markdown


def test_export_refuses_stalled_provider_live_run_without_mutating_rows(
    cli_temp_db,
    tmp_path,
):
    ready_path = tmp_path / "stalled-export-ready"
    runner_removed_path = tmp_path / "stalled-export-runner-removed"
    stall_server, stall_url = _start_unresponsive_chat_completions_server()
    cli_process = _start_unresponsive_http_cli_run(
        stall_url,
        ready_path,
        runner_removed_path,
        "0",
    )
    try:
        _wait_for_subprocess_marker(ready_path, cli_process)
        running_sessions = db.list_sessions()
        assert len(running_sessions) == 1
        running_session = running_sessions[0]
        assert running_session.status == "framing"
        assert _session_has_run_claim(cli_temp_db, running_session.id)
        snapshot_before = _persisted_session_export_snapshot(
            cli_temp_db,
            running_session.id,
        )
        with pytest.raises(SessionRunLockUnavailable):
            acquire_session_run_lock(str(cli_temp_db))

        for extra_arguments in ([], ["--format", "md"]):
            completed = _run_cli_export_subprocess(
                cli_temp_db,
                tmp_path,
                running_session.id,
                extra_arguments=extra_arguments,
            )
            _assert_cli_export_refuses_live_session(
                completed,
                running_session.id,
                "framing",
            )

        assert _persisted_session_export_snapshot(
            cli_temp_db,
            running_session.id,
        ) == snapshot_before
        assert cli_process.poll() is None
        with pytest.raises(SessionRunLockUnavailable):
            acquire_session_run_lock(str(cli_temp_db))
        persisted = db.get_session(running_session.id)
        assert persisted is not None
        assert persisted.status == "framing"
    finally:
        if cli_process.poll() is None:
            cli_process.kill()
            cli_process.communicate(timeout=10)
        _stop_unresponsive_chat_completions_server(stall_server)


def test_markdown_file_uses_shared_web_export_renderer(tmp_path, monkeypatch):
    payload = _sample_export_payload()

    async def return_sample_payload(session_config, report_progress, **_kwargs):
        report_progress("completed test session")
        return payload

    monkeypatch.setattr(cli, "execute_brainstorm_session", return_sample_payload)
    output_path = tmp_path / "result.md"
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        [
            "run",
            "--theme",
            "Shared renderer",
            "--format",
            "md",
            "--output",
            str(output_path),
        ],
        stdin=io.StringIO(),
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_SUCCESS
    assert stdout.getvalue() == ""
    assert output_path.read_text(encoding="utf-8") == render_session_export_markdown(payload)
    assert "wrote results to" in stderr.getvalue()


@pytest.mark.parametrize(
    ("arguments", "stdin", "expected_error"),
    [
        (["run", "--theme", "   "], "", "--theme must not be empty"),
        (["run", "--theme", "-"], " \n", "--theme must not be empty"),
        (
            ["run", "--theme", "x", "--persona", "INTJ"],
            "",
            "--persona requires between 2 and 16",
        ),
        (
            ["run", "--theme", "x", "--persona", "INTJ", "NOPE"],
            "",
            "unknown persona type(s): NOPE",
        ),
        (
            ["run", "--theme", "x", "--provider", "missing"],
            "",
            "unknown provider 'missing'",
        ),
        (
            ["run", "--theme", "x", "--provider", "mock", "--model", "missing"],
            "",
            "unknown model 'missing'",
        ),
    ],
)
def test_invalid_run_values_exit_two_without_traceback(arguments, stdin, expected_error):
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        arguments,
        stdin=io.StringIO(stdin),
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_USAGE_ERROR
    assert stdout.getvalue() == ""
    assert expected_error in stderr.getvalue()
    assert "Traceback" not in stderr.getvalue()


@pytest.mark.parametrize(
    ("arguments", "stdin", "field_name", "normalized_value"),
    [
        (
            ["run", "--theme", f"\u3000{'t' * 2000}\u00a0"],
            "",
            "theme",
            "t" * 2000,
        ),
        (
            ["run", "--theme", "-"],
            f"\u2003{'t' * 2000}\u3000",
            "theme",
            "t" * 2000,
        ),
        (
            [
                "run",
                "--theme",
                "Valid theme",
                "--constraints",
                f"\u2003{'c' * 2000}\u3000",
            ],
            "",
            "constraints",
            "c" * 2000,
        ),
        (
            ["run", "--theme", "Valid theme", "--constraints", " \u00a0\u3000 "],
            "",
            "constraints",
            None,
        ),
    ],
    ids=(
        "theme-argument-trimmed-2000",
        "theme-stdin-trimmed-2000",
        "constraints-trimmed-2000",
        "constraints-blank-to-null",
    ),
)
def test_cli_session_fields_use_session_create_normalization(
    arguments,
    stdin,
    field_name,
    normalized_value,
):
    parsed_arguments = cli.create_cli_argument_parser().parse_args(arguments)

    options = cli.build_brainstorm_run_options(
        parsed_arguments,
        io.StringIO(stdin),
    )

    assert getattr(options.session_config, field_name) == normalized_value


@pytest.mark.parametrize(
    ("arguments", "stdin", "expected_error"),
    [
        (["run", "--theme", " \u00a0\u2003\u3000 "], "", "--theme must not be empty"),
        (["run", "--theme", "-"], " \u00a0\u3000\n", "--theme must not be empty"),
        (
            ["run", "--theme", f"\u3000{'t' * 2001}\u00a0"],
            "",
            "--theme must contain at most 2000 characters",
        ),
        (
            ["run", "--theme", "-"],
            f"\u3000{'t' * 2001}\u00a0",
            "--theme must contain at most 2000 characters",
        ),
        (
            [
                "run",
                "--theme",
                "Valid theme",
                "--constraints",
                f"\u2003{'c' * 2001}\u3000",
            ],
            "",
            "--constraints must contain at most 2000 characters",
        ),
    ],
    ids=(
        "theme-argument-unicode-blank",
        "theme-stdin-unicode-blank",
        "theme-argument-trimmed-2001",
        "theme-stdin-trimmed-2001",
        "constraints-trimmed-2001",
    ),
)
def test_cli_session_field_validation_has_no_run_side_effects(
    cli_temp_db,
    monkeypatch,
    arguments,
    stdin,
    expected_error,
):
    provider_calls = []
    session_start_calls = []

    async def observe_provider_call(*args, **kwargs):
        provider_calls.append((args, kwargs))
        raise AssertionError("provider must not run for invalid SessionCreate input")

    async def observe_session_start(session_config):
        session_start_calls.append(session_config)
        raise AssertionError("session must not start for invalid SessionCreate input")

    monkeypatch.setattr(providers, "complete", observe_provider_call)
    monkeypatch.setattr(orchestrator, "create_and_start_session", observe_session_start)
    lock_directory = session_run_lock.session_run_lock_path(str(cli_temp_db)).parent
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        arguments,
        stdin=io.StringIO(stdin),
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_USAGE_ERROR
    assert stdout.getvalue() == ""
    assert expected_error in stderr.getvalue()
    assert "Traceback" not in stderr.getvalue()
    assert provider_calls == []
    assert session_start_calls == []
    assert not cli_temp_db.exists()
    assert not lock_directory.exists()


def test_persona_and_balanced_options_are_mutually_exclusive():
    parser = cli.create_cli_argument_parser()

    with pytest.raises(SystemExit) as exit_info:
        parser.parse_args(
            ["run", "--theme", "x", "--persona", "INTJ", "ENFP", "--balanced", "4"]
        )

    assert exit_info.value.code == cli.EXIT_USAGE_ERROR


def test_run_timeout_defaults_to_900_seconds_and_accepts_zero_or_fractional():
    parser = cli.create_cli_argument_parser()

    default_options = cli.build_brainstorm_run_options(
        parser.parse_args(["run", "--theme", "Timeout default"]),
        io.StringIO(),
    )
    disabled_options = cli.build_brainstorm_run_options(
        parser.parse_args(["run", "--theme", "Timeout disabled", "--timeout", "0"]),
        io.StringIO(),
    )
    fractional_options = cli.build_brainstorm_run_options(
        parser.parse_args(["run", "--theme", "Timeout float", "--timeout", "3.5"]),
        io.StringIO(),
    )

    assert default_options.timeout_seconds == cli.CLI_RUN_DEFAULT_TIMEOUT_SECONDS
    assert disabled_options.timeout_seconds == 0
    assert fractional_options.timeout_seconds == 3.5
    assert cli.format_cli_run_timeout_reason(900) == "Timed out after 900s"
    assert cli.format_cli_run_timeout_reason(3.5) == "Timed out after 3.5s"


@pytest.mark.parametrize("value", ["-1", "abc", "nan", "inf", "-inf"])
def test_run_timeout_rejects_invalid_values(value):
    parser = cli.create_cli_argument_parser()

    with pytest.raises(SystemExit) as exit_info:
        parser.parse_args(["run", "--theme", "Invalid timeout", "--timeout", value])

    assert exit_info.value.code == cli.EXIT_USAGE_ERROR


def test_theme_stdin_does_not_prompt_when_input_is_a_tty():
    class TtyInput(io.StringIO):
        def isatty(self) -> bool:
            return True

        def read(self, size: int = -1) -> str:
            raise AssertionError("TTY input must not be read")

    stderr = io.StringIO()
    exit_code = cli.main(
        ["run", "--theme", "-"],
        stdin=TtyInput(),
        stdout=io.StringIO(),
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_USAGE_ERROR
    assert "requires piped or redirected stdin" in stderr.getvalue()


def test_running_session_is_rejected_before_creating_another(cli_temp_db, monkeypatch):
    monkeypatch.setattr("backend.cli.orchestrator.is_any_session_running", lambda: True)
    stderr = io.StringIO()

    exit_code = cli.main(
        ["run", "--theme", "No overlap"],
        stdin=io.StringIO(),
        stdout=io.StringIO(),
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_RUNTIME_ERROR
    assert "another session is already running" in stderr.getvalue()
    assert "Traceback" not in stderr.getvalue()
    assert db.list_sessions() == []


@pytest.mark.parametrize("operation", ["claim", "recover", "terminate"])
@pytest.mark.parametrize("token_kind", ["none", "forged", "released", "different-db"])
def test_session_run_capability_rejects_invalid_ownership_without_mutation(
    cli_temp_db,
    tmp_path,
    operation,
    token_kind,
):
    db.init_db()
    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    config = SessionCreate(
        theme="Capability validation target",
        agents=[agent, agent],
        facilitator=FacilitatorConfig(provider="mock", model="mock"),
    )
    target_session = db.create_session(config)
    orphaned_session = db.create_session(
        config.model_copy(update={"theme": "Capability-protected orphan"})
    )
    _leave_claimed_session_without_owner(orphaned_session.id)

    lock_to_release = None
    if token_kind == "none":
        invalid_lock = None
    elif token_kind == "forged":
        invalid_lock = object.__new__(SessionRunLock)
    elif token_kind == "released":
        invalid_lock = acquire_session_run_lock(str(cli_temp_db))
        invalid_lock.release()
    else:
        invalid_lock = acquire_session_run_lock(str(tmp_path / "different.db"))
        lock_to_release = invalid_lock

    try:
        with pytest.raises(SessionRunLockOwnershipError, match="ownership invalid"):
            if operation == "claim":
                db.claim_session_run(invalid_lock, target_session.id)
            elif operation == "recover":
                db.recover_orphaned_session_runs(invalid_lock)
            else:
                db.terminate_claimed_session_run(
                    invalid_lock,
                    orphaned_session.id,
                    "Terminated by SIGTERM",
                )
    finally:
        if lock_to_release is not None:
            lock_to_release.release()

    unchanged_target = db.get_session(target_session.id)
    unchanged_orphan = db.get_session(orphaned_session.id)
    assert unchanged_target is not None
    assert unchanged_target.status == "framing"
    assert not _session_has_run_claim(cli_temp_db, target_session.id)
    assert unchanged_orphan is not None
    assert unchanged_orphan.status == "framing"
    assert _session_has_run_claim(cli_temp_db, orphaned_session.id)


def test_session_run_lock_uses_persistent_canonical_database_namespace(
    tmp_path,
    monkeypatch,
):
    working_directory = tmp_path / "working-directory"
    temporary_directory = tmp_path / "process-temporary-directory"
    database_path = tmp_path / "missing-database-parent" / "sessions.db"
    working_directory.mkdir()
    temporary_directory.mkdir()
    monkeypatch.chdir(working_directory)
    monkeypatch.setenv("TMPDIR", str(temporary_directory))
    relative_database_path = os.path.relpath(database_path, working_directory)
    canonical_database_path = str(database_path.resolve())
    expected_lock_digest = hashlib.sha256(
        os.fsencode(canonical_database_path)
    ).hexdigest()
    expected_lock_path = (
        database_path.parent.resolve()
        / ".izayoi-run-locks"
        / f"{expected_lock_digest}.lock"
    )

    assert session_run_lock.session_run_lock_path(
        relative_database_path
    ) == expected_lock_path
    assert session_run_lock.session_run_lock_path(
        str(database_path.resolve())
    ) == expected_lock_path

    acquired_lock = acquire_session_run_lock(relative_database_path)
    acquired_lock.release()

    assert expected_lock_path.is_file()
    assert not database_path.exists()


def test_session_run_locks_for_different_databases_can_overlap(tmp_path):
    first_lock = acquire_session_run_lock(str(tmp_path / "first.db"))
    try:
        second_lock = acquire_session_run_lock(str(tmp_path / "second.db"))
        second_lock.release()
    finally:
        first_lock.release()


def test_same_canonical_database_rejects_second_cli_across_tmpdir_cwd_and_path_forms(
    cli_temp_db,
    tmp_path,
):
    first_working_directory = tmp_path / "first-working-directory"
    second_working_directory = tmp_path / "second-working-directory"
    first_temporary_directory = tmp_path / "first-process-tmp"
    second_temporary_directory = tmp_path / "second-process-tmp"
    for directory in (
        first_working_directory,
        second_working_directory,
        first_temporary_directory,
        second_temporary_directory,
    ):
        directory.mkdir()

    first_database_path_form = os.path.relpath(
        cli_temp_db,
        first_working_directory,
    )
    second_database_path_form = str(cli_temp_db.resolve())
    first_environment = _build_cli_subprocess_environment(
        first_database_path_form,
        first_temporary_directory,
    )
    second_environment = _build_cli_subprocess_environment(
        second_database_path_form,
        second_temporary_directory,
    )
    assert not Path(first_database_path_form).is_absolute()
    assert Path(second_database_path_form).is_absolute()
    assert first_environment["TMPDIR"] != second_environment["TMPDIR"]

    ready_path = tmp_path / "first-provider-started"
    release_path = tmp_path / "release-first-provider"
    second_provider_start_path = tmp_path / "second-provider-started"
    first_cli_process = _start_paused_mock_cli_run(
        ready_path,
        release_path,
        working_directory=first_working_directory,
        environment=first_environment,
    )
    first_stdout = ""
    first_stderr = ""
    try:
        _wait_for_subprocess_marker(ready_path, first_cli_process)
        running_sessions = db.list_sessions()
        assert len(running_sessions) == 1
        running_session = running_sessions[0]
        assert running_session.status == "framing"
        assert _session_has_run_claim(cli_temp_db, running_session.id)
        row_counts_before_second_run = _brainstorm_database_row_counts(cli_temp_db)

        second_cli = subprocess.run(
            [
                sys.executable,
                "-c",
                _PROVIDER_START_OBSERVER_CLI_RUN_SCRIPT,
                str(second_provider_start_path),
            ],
            cwd=second_working_directory,
            env=second_environment,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )

        assert first_cli_process.poll() is None
        assert second_cli.returncode == cli.EXIT_RUNTIME_ERROR
        assert second_cli.stdout == ""
        assert "another session is already running" in second_cli.stderr
        assert "Traceback" not in second_cli.stderr
        assert not second_provider_start_path.exists()
        assert _brainstorm_database_row_counts(
            cli_temp_db
        ) == row_counts_before_second_run
        sessions_after_second_run = db.list_sessions()
        assert [session.id for session in sessions_after_second_run] == [
            running_session.id
        ]
        assert sessions_after_second_run[0].status == "framing"
    finally:
        release_path.touch()
        try:
            first_stdout, first_stderr = first_cli_process.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            first_cli_process.kill()
            first_stdout, first_stderr = first_cli_process.communicate(timeout=10)

    assert first_cli_process.returncode == cli.EXIT_SUCCESS, first_stderr
    assert "Traceback" not in first_stderr
    first_export = json.loads(first_stdout)
    assert first_export["session"]["id"] == running_session.id
    assert first_export["session"]["status"] == "done"
    completed_session = db.get_session(running_session.id)
    assert completed_session is not None
    assert completed_session.status == "done"


def test_cross_process_session_run_lock_rejects_cli_without_phantom_session(cli_temp_db):
    first_process_lock = acquire_session_run_lock(str(cli_temp_db))
    try:
        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "backend.cli",
                "run",
                "--theme",
                "No cross-process overlap",
                "--persona",
                "INTJ",
                "ENFP",
                "--ideas-per-agent",
                "1",
                "--discussion-rounds",
                "0",
                "--no-judge",
            ],
            cwd=Path(__file__).resolve().parents[2],
            check=False,
            capture_output=True,
            text=True,
        )
    finally:
        first_process_lock.release()

    assert completed.returncode == cli.EXIT_RUNTIME_ERROR
    assert completed.stdout == ""
    assert "another session is already running" in completed.stderr
    assert "Traceback" not in completed.stderr
    assert db.list_sessions() == []


def test_web_lifespan_preserves_live_cli_session_in_another_process(
    cli_temp_db,
    tmp_path,
):
    ready_path = tmp_path / "cli-framing-ready"
    release_path = tmp_path / "release-cli-framing"
    cli_process = _start_paused_mock_cli_run(ready_path, release_path)
    cli_stdout = ""
    cli_stderr = ""
    try:
        _wait_for_subprocess_marker(ready_path, cli_process)
        running_sessions = db.list_sessions()
        assert len(running_sessions) == 1
        running_session = running_sessions[0]
        assert running_session.status == "framing"

        states_during_web_start = _read_session_states_during_web_lifespan(
            running_session.id
        )
        assert states_during_web_start[running_session.id] == {
            "status": "framing",
            "phase_progress": "Structuring goal and rules",
        }
        persisted_during_web_start = db.get_session(running_session.id)
        assert persisted_during_web_start is not None
        assert persisted_during_web_start.status == "framing"
        assert persisted_during_web_start.phase_progress != "Interrupted by server restart"
    finally:
        release_path.touch()
        try:
            cli_stdout, cli_stderr = cli_process.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            cli_process.kill()
            cli_stdout, cli_stderr = cli_process.communicate(timeout=10)

    assert cli_process.returncode == cli.EXIT_SUCCESS, cli_stderr
    exported = json.loads(cli_stdout)
    completed_session = db.get_session(exported["session"]["id"])
    assert completed_session is not None
    assert completed_session.status == "done"
    assert completed_session.phase_progress == "Session completed"


def test_live_cli_recovers_old_orphan_before_competing_web_lifespan(
    cli_temp_db,
    tmp_path,
):
    db.init_db()
    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    orphaned_session = db.create_session(
        SessionCreate(
            theme="Orphan left by a crashed process",
            agents=[agent, agent],
            facilitator=FacilitatorConfig(provider="mock", model="mock"),
        )
    )
    _leave_claimed_session_without_owner(orphaned_session.id)
    assert orphaned_session.status == "framing"
    assert _session_has_run_claim(cli_temp_db, orphaned_session.id)

    ready_path = tmp_path / "mixed-cli-framing-ready"
    release_path = tmp_path / "release-mixed-cli-framing"
    cli_process = _start_paused_mock_cli_run(ready_path, release_path)
    cli_stdout = ""
    cli_stderr = ""
    try:
        _wait_for_subprocess_marker(ready_path, cli_process)
        live_session = next(
            session
            for session in db.list_sessions()
            if session.id != orphaned_session.id
        )
        recovered_before_web_start = db.get_session(orphaned_session.id)
        assert recovered_before_web_start is not None
        assert recovered_before_web_start.status == "error"
        assert (
            recovered_before_web_start.phase_progress
            == "Interrupted by a newer session start"
        )

        states_during_web_start = _read_session_states_during_web_lifespan(
            orphaned_session.id,
            live_session.id,
        )
        assert states_during_web_start[orphaned_session.id] == {
            "status": "error",
            "phase_progress": "Interrupted by a newer session start",
        }
        assert states_during_web_start[live_session.id] == {
            "status": "framing",
            "phase_progress": "Structuring goal and rules",
        }
    finally:
        release_path.touch()
        try:
            cli_stdout, cli_stderr = cli_process.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            cli_process.kill()
            cli_stdout, cli_stderr = cli_process.communicate(timeout=10)

    assert cli_process.returncode == cli.EXIT_SUCCESS, cli_stderr
    exported = json.loads(cli_stdout)
    assert exported["session"]["id"] == live_session.id

    recovered_orphan = db.get_session(orphaned_session.id)
    completed_live_session = db.get_session(live_session.id)
    assert recovered_orphan is not None
    assert recovered_orphan.status == "error"
    assert recovered_orphan.phase_progress == "Interrupted by a newer session start"
    assert completed_live_session is not None
    assert completed_live_session.status == "done"
    assert completed_live_session.phase_progress == "Session completed"


def test_init_db_migrates_preclaim_nonterminal_row_as_recoverable_orphan(cli_temp_db):
    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    config = SessionCreate(
        theme="Legacy row must not become restartable",
        agents=[agent, agent],
        facilitator=FacilitatorConfig(provider="mock", model="mock"),
    )
    legacy_session_id = "123456789abc"
    with sqlite3.connect(cli_temp_db) as conn:
        conn.execute(
            """
            CREATE TABLE sessions(
                id TEXT PRIMARY KEY,
                theme TEXT NOT NULL,
                constraints TEXT NOT NULL DEFAULT '',
                config_json TEXT NOT NULL,
                status TEXT NOT NULL,
                phase_progress TEXT NOT NULL DEFAULT '',
                metrics_json TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?)",
            (
                legacy_session_id,
                config.theme,
                config.constraints or "",
                config.model_dump_json(),
                "framing",
                "Structuring goal and rules",
                None,
                db.utcnow(),
            ),
        )

    db.init_db()
    assert _session_has_run_claim(cli_temp_db, legacy_session_id)
    recovery_lock = acquire_session_run_lock(str(cli_temp_db))
    try:
        assert db.recover_orphaned_session_runs(recovery_lock) == 1
    finally:
        recovery_lock.release()

    recovered_session = db.get_session(legacy_session_id)
    assert recovered_session is not None
    assert recovered_session.status == "error"
    assert recovered_session.phase_progress == "Interrupted by a newer session start"


def test_web_lifespan_recovers_unlocked_running_session(cli_temp_db):
    from fastapi.testclient import TestClient

    from backend import main

    db.init_db()
    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    stale_session = db.create_session(
        SessionCreate(
            theme="Recover an orphaned session",
            agents=[agent, agent],
            facilitator=FacilitatorConfig(provider="mock", model="mock"),
        )
    )
    _leave_claimed_session_without_owner(stale_session.id)

    with TestClient(main.create_app()):
        recovered_session = db.get_session(stale_session.id)

    assert recovered_session is not None
    assert recovered_session.status == "error"
    assert recovered_session.phase_progress == "Interrupted by server restart"


def test_web_lifespan_preserves_unclaimed_created_session(cli_temp_db):
    from fastapi.testclient import TestClient

    from backend import main

    db.init_db()
    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    created_session = db.create_session(
        SessionCreate(
            theme="Start this session after the server restart",
            agents=[agent, agent],
            facilitator=FacilitatorConfig(provider="mock", model="mock"),
        )
    )

    with TestClient(main.create_app()):
        preserved_session = db.get_session(created_session.id)

    assert preserved_session is not None
    assert preserved_session.status == "framing"
    assert preserved_session.phase_progress == ""
    assert not _session_has_run_claim(cli_temp_db, created_session.id)


def test_web_start_recovers_other_orphan_and_protects_target_session(cli_temp_db):
    from fastapi.testclient import TestClient

    from backend import main

    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    target_config = SessionCreate(
        theme="Web start owns only its target row",
        agents=[agent, agent],
        facilitator=FacilitatorConfig(provider="mock", model="mock"),
        ideas_per_agent=1,
        discussion_rounds=0,
        enable_judge=False,
    )

    with TestClient(main.create_app()) as client:
        orphaned_session = db.create_session(
            target_config.model_copy(update={"theme": "Orphan created after Web lifespan"})
        )
        _leave_claimed_session_without_owner(orphaned_session.id)
        unclaimed_session = db.create_session(
            target_config.model_copy(update={"theme": "Still waiting for its first start"})
        )
        created = client.post(
            "/api/sessions",
            json=target_config.model_dump(mode="json"),
        )
        target_session_id = created.json()["id"]

        started = client.post(f"/api/sessions/{target_session_id}/start")
        recovered_orphan = db.get_session(orphaned_session.id)
        assert recovered_orphan is not None
        assert recovered_orphan.status == "error"
        assert recovered_orphan.phase_progress == "Interrupted by a newer session start"
        still_unclaimed = db.get_session(unclaimed_session.id)
        assert still_unclaimed is not None
        assert still_unclaimed.status == "framing"
        assert not _session_has_run_claim(cli_temp_db, unclaimed_session.id)

        stream = client.get(f"/api/sessions/{target_session_id}/stream")
        completed_target = db.get_session(target_session_id)

    assert created.status_code == 201
    assert started.status_code == 202
    assert stream.status_code == 200
    assert completed_target is not None
    assert completed_target.status == "done"
    assert completed_target.phase_progress == "Session completed"


def test_web_start_rejects_target_with_existing_durable_run_claim(cli_temp_db):
    from fastapi.testclient import TestClient

    from backend import main

    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    config = SessionCreate(
        theme="Do not rerun a claimed target",
        agents=[agent, agent],
        facilitator=FacilitatorConfig(provider="mock", model="mock"),
    )

    with TestClient(main.create_app()) as client:
        target_session = db.create_session(config)
        _leave_claimed_session_without_owner(target_session.id)
        response = client.post(f"/api/sessions/{target_session.id}/start")

    unchanged_target = db.get_session(target_session.id)
    assert response.status_code == 409
    assert response.json() == {"detail": "session already running"}
    assert unchanged_target is not None
    assert unchanged_target.status == "framing"
    assert _session_has_run_claim(cli_temp_db, target_session.id)
    assert db.list_ideas(target_session.id) == []
    assert db.list_messages(target_session.id) == []


def test_cross_process_session_run_lock_rejects_web_start(cli_temp_db):
    from fastapi.testclient import TestClient

    from backend import main

    parser = cli.create_cli_argument_parser()
    arguments = parser.parse_args(
        [
            "run",
            "--theme",
            "No Web and CLI overlap",
            "--persona",
            "INTJ",
            "ENFP",
        ]
    )
    options = cli.build_brainstorm_run_options(arguments, io.StringIO())

    with TestClient(main.create_app()) as client:
        created = client.post(
            "/api/sessions",
            json=options.session_config.model_dump(mode="json"),
        )
        session_id = created.json()["id"]
        lock_holder = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import sys\n"
                    "from backend.session_run_lock import acquire_session_run_lock\n"
                    "run_lock = acquire_session_run_lock(sys.argv[1])\n"
                    "print('locked', flush=True)\n"
                    "sys.stdin.readline()\n"
                    "run_lock.release()\n"
                ),
                str(cli_temp_db),
            ],
            cwd=Path(__file__).resolve().parents[2],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            assert lock_holder.stdout is not None
            assert lock_holder.stdout.readline() == "locked\n"
            response = client.post(f"/api/sessions/{session_id}/start")
        finally:
            if lock_holder.stdin is not None:
                lock_holder.stdin.close()
            lock_holder_stderr = (
                lock_holder.stderr.read() if lock_holder.stderr is not None else ""
            )
            lock_holder.wait(timeout=10)
        assert lock_holder.returncode == 0, lock_holder_stderr

    assert created.status_code == 201
    assert response.status_code == 409
    assert response.json() == {"detail": "another session is already running"}
    assert db.get_session(session_id).status == "framing"


def test_delayed_web_start_rechecks_target_after_lock_and_does_not_duplicate_results(
    cli_temp_db,
    monkeypatch,
):
    from fastapi.testclient import TestClient

    from backend import main

    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    config = SessionCreate(
        theme="One durable run despite a delayed duplicate start",
        agents=[agent, agent],
        facilitator=FacilitatorConfig(provider="mock", model="mock"),
        ideas_per_agent=1,
        discussion_rounds=0,
        enable_judge=False,
    )

    with (
        TestClient(main.create_app()) as delayed_client,
        TestClient(main.create_app()) as winning_client,
    ):
        created = winning_client.post(
            "/api/sessions",
            json=config.model_dump(mode="json"),
        )
        session_id = created.json()["id"]

        original_acquire = orchestrator.acquire_session_run_lock
        acquisition_guard = threading.Lock()
        delayed_start_at_acquire = threading.Event()
        allow_delayed_acquire = threading.Event()
        acquisition_count = 0

        def acquire_with_first_call_barrier(database_path: str):
            nonlocal acquisition_count
            with acquisition_guard:
                acquisition_count += 1
                wait_at_barrier = acquisition_count == 1
            if wait_at_barrier:
                delayed_start_at_acquire.set()
                if not allow_delayed_acquire.wait(timeout=30):
                    raise RuntimeError("Web start acquire barrier timed out")
            return original_acquire(database_path)

        monkeypatch.setattr(
            orchestrator,
            "acquire_session_run_lock",
            acquire_with_first_call_barrier,
        )
        delayed_result: dict[str, Any] = {}

        def send_delayed_start_request() -> None:
            try:
                delayed_result["response"] = delayed_client.post(
                    f"/api/sessions/{session_id}/start"
                )
            except BaseException as exc:  # surfaced in the test thread below
                delayed_result["error"] = exc

        delayed_thread = threading.Thread(target=send_delayed_start_request, daemon=True)
        delayed_thread.start()
        try:
            assert delayed_start_at_acquire.wait(timeout=10)

            winning_start = winning_client.post(f"/api/sessions/{session_id}/start")
            winning_stream = winning_client.get(f"/api/sessions/{session_id}/stream")
            completed_session = db.get_session(session_id)
            assert completed_session is not None
            assert completed_session.status == "done"
            assert winning_start.status_code == 202
            assert winning_stream.status_code == 200

            # Prove the winning runner released ownership before opening the
            # acquire barrier; the delayed request must reach the target re-read.
            ownership_probe = acquire_session_run_lock(str(cli_temp_db))
            ownership_probe.release()
            idea_count_after_winner = len(db.list_ideas(session_id))
            message_count_after_winner = len(db.list_messages(session_id))
            assert idea_count_after_winner > 0
            assert message_count_after_winner > 0
        finally:
            allow_delayed_acquire.set()
            delayed_thread.join(timeout=30)

        assert not delayed_thread.is_alive()
        if "error" in delayed_result:
            raise delayed_result["error"]
        delayed_response = delayed_result["response"]

    assert delayed_response.status_code == 409
    assert delayed_response.json() == {"detail": "session already done"}
    assert len(db.list_ideas(session_id)) == idea_count_after_winner
    assert len(db.list_messages(session_id)) == message_count_after_winner


def test_web_claim_transaction_failure_rolls_back_target_and_other_orphan(
    cli_temp_db,
):
    db.init_db()
    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    config = SessionCreate(
        theme="Rollback every session claim mutation",
        agents=[agent, agent],
        facilitator=FacilitatorConfig(provider="mock", model="mock"),
    )
    orphaned_session = db.create_session(
        config.model_copy(update={"theme": "Orphan must not be half recovered"})
    )
    _leave_claimed_session_without_owner(orphaned_session.id)
    target_session = db.create_session(config)

    with sqlite3.connect(cli_temp_db) as conn:
        conn.execute(
            "CREATE TABLE target_run_claim_failure (session_id TEXT NOT NULL)"
        )
        conn.execute(
            "INSERT INTO target_run_claim_failure (session_id) VALUES (?)",
            (target_session.id,),
        )
        conn.execute(
            """
            CREATE TRIGGER fail_target_run_claim
            BEFORE UPDATE OF run_claimed ON sessions
            WHEN NEW.id = (SELECT session_id FROM target_run_claim_failure)
                AND NEW.run_claimed = 1
            BEGIN
                SELECT RAISE(ABORT, 'forced target claim failure');
            END
            """
        )

    with pytest.raises(sqlite3.IntegrityError, match="forced target claim failure"):
        asyncio.run(orchestrator.start_session(target_session.id))

    unchanged_target = db.get_session(target_session.id)
    unchanged_orphan = db.get_session(orphaned_session.id)
    assert unchanged_target is not None
    assert unchanged_target.status == "framing"
    assert unchanged_target.phase_progress == ""
    assert not _session_has_run_claim(cli_temp_db, target_session.id)
    assert unchanged_orphan is not None
    assert unchanged_orphan.status == "framing"
    assert unchanged_orphan.phase_progress == ""
    assert _session_has_run_claim(cli_temp_db, orphaned_session.id)
    assert orchestrator.get_runner(target_session.id) is None

    released_after_rollback = acquire_session_run_lock(str(cli_temp_db))
    released_after_rollback.release()


def test_cli_create_and_claim_failure_rolls_back_phantom_and_orphan_recovery(
    cli_temp_db,
):
    db.init_db()
    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    config = SessionCreate(
        theme="Rollback the CLI session insert",
        agents=[agent, agent],
        facilitator=FacilitatorConfig(provider="mock", model="mock"),
    )
    orphaned_session = db.create_session(
        config.model_copy(update={"theme": "Orphan survives rolled-back CLI claim"})
    )
    _leave_claimed_session_without_owner(orphaned_session.id)

    with sqlite3.connect(cli_temp_db) as conn:
        conn.execute(
            """
            CREATE TRIGGER fail_new_cli_run_claim
            BEFORE UPDATE OF run_claimed ON sessions
            WHEN OLD.run_claimed = 0 AND NEW.run_claimed = 1
            BEGIN
                SELECT RAISE(ABORT, 'forced CLI claim failure');
            END
            """
        )

    with pytest.raises(sqlite3.IntegrityError, match="forced CLI claim failure"):
        asyncio.run(orchestrator.create_and_start_session(config))

    remaining_sessions = db.list_sessions()
    assert [session.id for session in remaining_sessions] == [orphaned_session.id]
    unchanged_orphan = remaining_sessions[0]
    assert unchanged_orphan.status == "framing"
    assert unchanged_orphan.phase_progress == ""
    assert _session_has_run_claim(cli_temp_db, orphaned_session.id)

    released_after_rollback = acquire_session_run_lock(str(cli_temp_db))
    released_after_rollback.release()


def test_orchestrator_error_exits_one_and_releases_run_lock(cli_temp_db, monkeypatch):
    async def fail_provider_completion(*args, **kwargs):
        raise RuntimeError("simulated provider failure")

    monkeypatch.setattr(providers, "complete", fail_provider_completion)
    stderr = io.StringIO()

    exit_code = cli.main(
        ["run", "--theme", "Error path"],
        stdin=io.StringIO(),
        stdout=io.StringIO(),
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_RUNTIME_ERROR
    assert "simulated provider failure" in stderr.getvalue()
    assert "Traceback" not in stderr.getvalue()
    reacquired_run_lock = acquire_session_run_lock(str(cli_temp_db))
    reacquired_run_lock.release()


def test_ctrl_c_releases_cli_run_lock(cli_temp_db, tmp_path):
    if sys.platform == "win32":
        pytest.skip("subprocess SIGINT delivery is POSIX-specific")

    ready_path = tmp_path / "cli-before-sigint"
    release_path = tmp_path / "release-cli-after-sigint"
    cli_process = _start_paused_mock_cli_run(ready_path, release_path)
    try:
        _wait_for_subprocess_marker(ready_path, cli_process)
        cli_process.send_signal(signal.SIGINT)
        cli_stdout, cli_stderr = cli_process.communicate(timeout=20)
    finally:
        release_path.touch()
        if cli_process.poll() is None:
            cli_process.kill()
            cli_stdout, cli_stderr = cli_process.communicate(timeout=10)

    assert cli_process.returncode == cli.EXIT_INTERRUPTED
    assert cli_stdout == ""
    assert "interrupted" in cli_stderr
    interrupted_sessions = db.list_sessions()
    assert len(interrupted_sessions) == 1
    assert interrupted_sessions[0].status == "error"
    assert interrupted_sessions[0].phase_progress == "Interrupted by user"
    reacquired_run_lock = acquire_session_run_lock(str(cli_temp_db))
    reacquired_run_lock.release()


def test_sigterm_waits_for_provider_cleanup_and_preserves_reason(
    cli_temp_db,
    tmp_path,
):
    if sys.platform == "win32":
        pytest.skip("subprocess SIGTERM delivery is POSIX-specific")

    provider_started_path = tmp_path / "sigterm-provider-started"
    provider_cancelled_path = tmp_path / "sigterm-provider-cancelled"
    allow_provider_cleanup_path = tmp_path / "allow-sigterm-provider-cleanup"
    provider_finally_path = tmp_path / "sigterm-provider-finally"
    runner_removed_path = tmp_path / "sigterm-runner-removed"
    cli_process = _start_sigterm_cleanup_cli_run(
        provider_started_path,
        provider_cancelled_path,
        allow_provider_cleanup_path,
        provider_finally_path,
        runner_removed_path,
    )
    cli_stdout = ""
    cli_stderr = ""
    try:
        _wait_for_subprocess_marker(provider_started_path, cli_process)
        claimed_sessions = db.list_sessions()
        assert len(claimed_sessions) == 1
        claimed_session = claimed_sessions[0]
        assert _session_has_run_claim(cli_temp_db, claimed_session.id)

        cli_process.send_signal(signal.SIGTERM)
        _wait_for_subprocess_marker(provider_cancelled_path, cli_process)
        with pytest.raises(SessionRunLockUnavailable):
            acquire_session_run_lock(str(cli_temp_db))
        cleanup_pending_session = db.get_session(claimed_session.id)
        assert cleanup_pending_session is not None
        assert cleanup_pending_session.status == "framing"
        assert _session_has_run_claim(cli_temp_db, claimed_session.id)

        # A repeated SIGTERM during an awaited provider finally block is an
        # idempotent notification, not a second cancellation or hard exit.
        cli_process.send_signal(signal.SIGTERM)
        time.sleep(0.1)
        assert cli_process.poll() is None
        allow_provider_cleanup_path.touch()
        cli_stdout, cli_stderr = cli_process.communicate(timeout=20)
    finally:
        allow_provider_cleanup_path.touch()
        if cli_process.poll() is None:
            cli_process.kill()
            cli_stdout, cli_stderr = cli_process.communicate(timeout=10)

    assert cli_process.returncode == cli.EXIT_SIGTERM
    assert cli_stdout == ""
    assert "Terminated by SIGTERM" in cli_stderr
    assert "Traceback" not in cli_stderr
    assert provider_finally_path.read_text(encoding="utf-8") == "finished"
    assert runner_removed_path.read_text(encoding="utf-8") == "removed"

    terminated_session = db.get_session(claimed_session.id)
    assert terminated_session is not None
    assert terminated_session.status == "error"
    assert terminated_session.phase_progress == "Terminated by SIGTERM"
    assert not _session_has_run_claim(cli_temp_db, claimed_session.id)
    released_run_lock = acquire_session_run_lock(str(cli_temp_db))
    released_run_lock.release()

    next_run = subprocess.run(
        [
            sys.executable,
            "-m",
            "backend.cli",
            "run",
            "--theme",
            "Run after graceful SIGTERM",
            "--persona",
            "INTJ",
            "ENFP",
            "--ideas-per-agent",
            "1",
            "--discussion-rounds",
            "0",
            "--no-judge",
        ],
        cwd=Path(__file__).resolve().parents[2],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert next_run.returncode == cli.EXIT_SUCCESS, next_run.stderr
    preserved_session = db.get_session(claimed_session.id)
    assert preserved_session is not None
    assert preserved_session.phase_progress == "Terminated by SIGTERM"


def test_sigterm_before_session_claim_exits_143_without_phantom_run(
    cli_temp_db,
    tmp_path,
):
    if sys.platform == "win32":
        pytest.skip("subprocess SIGTERM delivery is POSIX-specific")

    handler_active_path = tmp_path / "early-sigterm-handler-active"
    cleanup_complete_path = tmp_path / "early-sigterm-cleanup-complete"
    cli_process = subprocess.Popen(
        [
            sys.executable,
            "-c",
            _EARLY_SIGTERM_CLI_RUN_SCRIPT,
            str(handler_active_path),
            str(cleanup_complete_path),
        ],
        cwd=Path(__file__).resolve().parents[2],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        _wait_for_subprocess_marker(handler_active_path, cli_process)
        cli_process.send_signal(signal.SIGTERM)
        cli_stdout, cli_stderr = cli_process.communicate(timeout=20)
    finally:
        if cli_process.poll() is None:
            cli_process.kill()
            cli_stdout, cli_stderr = cli_process.communicate(timeout=10)

    assert cli_process.returncode == cli.EXIT_SIGTERM
    assert cli_stdout == ""
    assert "Terminated by SIGTERM" in cli_stderr
    assert cleanup_complete_path.read_text(encoding="utf-8") == "complete"
    assert db.list_sessions() == []
    released_run_lock = acquire_session_run_lock(str(cli_temp_db))
    released_run_lock.release()


def test_wait_for_cli_session_completion_cancels_shielded_runner_on_timeout(monkeypatch):
    waited: list[str] = []
    cancelled: list[tuple[str, str]] = []

    async def hang_behind_wait_shield(session_id: str) -> None:
        waited.append(session_id)
        await asyncio.Event().wait()

    async def record_runner_cancel(session_id: str, reason: str) -> None:
        cancelled.append((session_id, reason))

    monkeypatch.setattr(orchestrator, "wait_for_session_completion", hang_behind_wait_shield)
    monkeypatch.setattr(
        orchestrator,
        "cancel_and_wait_for_session_completion",
        record_runner_cancel,
    )

    started_at = time.monotonic()
    asyncio.run(cli.wait_for_cli_session_completion("abcabcabcabc", 0.2))
    elapsed_seconds = time.monotonic() - started_at

    assert waited == ["abcabcabcabc"]
    assert cancelled == [("abcabcabcabc", "Timed out after 0.2s")]
    assert 0.15 <= elapsed_seconds < 1.0


def test_wait_for_cli_session_completion_zero_disables_timeout(monkeypatch):
    cancel_calls: list[tuple[str, str]] = []

    async def finish_after_short_pause(session_id: str) -> None:
        del session_id
        await asyncio.sleep(0.2)

    async def record_runner_cancel(session_id: str, reason: str) -> None:
        cancel_calls.append((session_id, reason))

    monkeypatch.setattr(
        orchestrator,
        "wait_for_session_completion",
        finish_after_short_pause,
    )
    monkeypatch.setattr(
        orchestrator,
        "cancel_and_wait_for_session_completion",
        record_runner_cancel,
    )

    asyncio.run(cli.wait_for_cli_session_completion("abcabcabcabc", 0))

    assert cancel_calls == []


def test_run_timeout_zero_allows_slow_provider_to_finish(cli_temp_db, monkeypatch):
    original_complete = providers.complete

    async def complete_after_short_pause(*args, **kwargs):
        await asyncio.sleep(0.3)
        return await original_complete(*args, **kwargs)

    monkeypatch.setattr(providers, "complete", complete_after_short_pause)
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        [
            "run",
            "--theme",
            "Timeout disabled still completes",
            "--persona",
            "INTJ",
            "ENFP",
            "--ideas-per-agent",
            "1",
            "--discussion-rounds",
            "0",
            "--no-judge",
            "--timeout",
            "0",
        ],
        stdin=io.StringIO(),
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_SUCCESS
    assert json.loads(stdout.getvalue())["session"]["status"] == "done"
    assert "Timed out after" not in stderr.getvalue()
    assert "Traceback" not in stderr.getvalue()


def test_run_timeout_cancels_unresponsive_http_provider_and_allows_next_run(
    cli_temp_db,
    tmp_path,
):
    ready_path = tmp_path / "timeout-provider-ready"
    runner_removed_path = tmp_path / "timeout-runner-removed"
    stall_server, stall_url = _start_unresponsive_chat_completions_server()
    cli_process = _start_unresponsive_http_cli_run(
        stall_url,
        ready_path,
        runner_removed_path,
        "3",
    )
    cli_stdout = ""
    cli_stderr = ""
    started_at = time.monotonic()
    try:
        _wait_for_subprocess_marker(ready_path, cli_process)
        claimed_sessions = db.list_sessions()
        assert len(claimed_sessions) == 1
        claimed_session = claimed_sessions[0]
        assert claimed_session.status == "framing"
        assert _session_has_run_claim(cli_temp_db, claimed_session.id)
        with pytest.raises(SessionRunLockUnavailable):
            acquire_session_run_lock(str(cli_temp_db))

        cli_stdout, cli_stderr = cli_process.communicate(timeout=8)
        elapsed_seconds = time.monotonic() - started_at
    finally:
        if cli_process.poll() is None:
            cli_process.kill()
            cli_stdout, cli_stderr = cli_process.communicate(timeout=10)
        _stop_unresponsive_chat_completions_server(stall_server)

    assert cli_process.returncode == cli.EXIT_RUNTIME_ERROR
    assert cli_stdout == ""
    error_lines = [line for line in cli_stderr.splitlines() if line.startswith("izayoi: error:")]
    assert error_lines == [
        f"izayoi: error: session {claimed_session.id} failed: Timed out after 3s"
    ]
    assert "Traceback" not in cli_stderr
    assert 2.5 <= elapsed_seconds < 6.0
    assert runner_removed_path.read_text(encoding="utf-8") == "removed"

    timed_out_session = db.get_session(claimed_session.id)
    assert timed_out_session is not None
    assert timed_out_session.status == "error"
    assert timed_out_session.phase_progress == "Timed out after 3s"
    assert not _session_has_run_claim(cli_temp_db, claimed_session.id)
    released_run_lock = acquire_session_run_lock(str(cli_temp_db))
    released_run_lock.release()

    next_run = subprocess.run(
        [
            sys.executable,
            "-m",
            "backend.cli",
            "run",
            "--theme",
            "Run after stall timeout",
            "--persona",
            "INTJ",
            "ENFP",
            "--ideas-per-agent",
            "1",
            "--discussion-rounds",
            "0",
            "--no-judge",
        ],
        cwd=Path(__file__).resolve().parents[2],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert next_run.returncode == cli.EXIT_SUCCESS, next_run.stderr
    preserved_session = db.get_session(claimed_session.id)
    assert preserved_session is not None
    assert preserved_session.phase_progress == "Timed out after 3s"


def test_sigint_during_run_timeout_wait_still_exits_130(cli_temp_db, tmp_path):
    if sys.platform == "win32":
        pytest.skip("subprocess SIGINT delivery is POSIX-specific")

    ready_path = tmp_path / "timeout-sigint-ready"
    runner_removed_path = tmp_path / "timeout-sigint-runner-removed"
    stall_server, stall_url = _start_unresponsive_chat_completions_server()
    cli_process = _start_unresponsive_http_cli_run(
        stall_url,
        ready_path,
        runner_removed_path,
        "30",
    )
    cli_stdout = ""
    cli_stderr = ""
    try:
        _wait_for_subprocess_marker(ready_path, cli_process)
        cli_process.send_signal(signal.SIGINT)
        cli_stdout, cli_stderr = cli_process.communicate(timeout=20)
    finally:
        if cli_process.poll() is None:
            cli_process.kill()
            cli_stdout, cli_stderr = cli_process.communicate(timeout=10)
        _stop_unresponsive_chat_completions_server(stall_server)

    assert cli_process.returncode == cli.EXIT_INTERRUPTED
    assert cli_stdout == ""
    assert "interrupted" in cli_stderr
    assert "Timed out after" not in cli_stderr
    assert "Traceback" not in cli_stderr
    interrupted_sessions = db.list_sessions()
    assert len(interrupted_sessions) == 1
    assert interrupted_sessions[0].status == "error"
    assert interrupted_sessions[0].phase_progress == "Interrupted by user"
    assert not _session_has_run_claim(cli_temp_db, interrupted_sessions[0].id)
    released_run_lock = acquire_session_run_lock(str(cli_temp_db))
    released_run_lock.release()


@pytest.mark.parametrize(
    "outcome",
    ["success", "runtime-error", "cancelled-error"],
)
def test_cli_sigterm_handler_restores_previous_handler(outcome):
    if not hasattr(signal, "SIGTERM"):
        pytest.skip("platform does not expose SIGTERM")

    original_handler = signal.getsignal(signal.SIGTERM)

    def previous_handler(signum, frame):
        del signum, frame

    signal.signal(signal.SIGTERM, previous_handler)

    async def exercise_handler_lifecycle() -> None:
        observed_error: BaseException | None = None
        try:
            with CliSigtermCancellation.for_current_cli_run() as cancellation:
                assert cancellation.registered
                assert signal.getsignal(signal.SIGTERM) is not previous_handler
                if outcome == "runtime-error":
                    raise RuntimeError("handler restoration probe")
                if outcome == "cancelled-error":
                    raise asyncio.CancelledError
        except BaseException as exc:
            observed_error = exc

        assert signal.getsignal(signal.SIGTERM) is previous_handler
        if outcome == "success":
            assert observed_error is None
        elif outcome == "runtime-error":
            assert isinstance(observed_error, RuntimeError)
        else:
            assert isinstance(observed_error, asyncio.CancelledError)

    try:
        asyncio.run(exercise_handler_lifecycle())
    finally:
        signal.signal(signal.SIGTERM, original_handler)


def test_cli_sigterm_handler_falls_back_without_registration_in_worker_thread():
    if not hasattr(signal, "SIGTERM"):
        pytest.skip("platform does not expose SIGTERM")

    previous_handler = signal.getsignal(signal.SIGTERM)
    observation: dict[str, Any] = {}

    async def inspect_worker_thread_fallback() -> None:
        with CliSigtermCancellation.for_current_cli_run() as cancellation:
            observation["registered"] = cancellation.registered
            observation["mode"] = cancellation.registration_mode
            observation["handler"] = signal.getsignal(signal.SIGTERM)

    worker = threading.Thread(
        target=lambda: asyncio.run(inspect_worker_thread_fallback()),
    )
    worker.start()
    worker.join(timeout=10)

    assert not worker.is_alive()
    assert observation == {
        "registered": False,
        "mode": "unavailable",
        "handler": previous_handler,
    }


def test_corrupt_session_run_lock_file_does_not_break_cli_start(cli_temp_db):
    seeded_lock = acquire_session_run_lock(str(cli_temp_db))
    seeded_lock.release()
    lock_path = session_run_lock.session_run_lock_path(str(cli_temp_db))
    lock_path.write_bytes(b"not valid lock metadata: \\xff\\x00")

    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "backend.cli",
            "run",
            "--theme",
            "Ignore corrupt lock contents",
            "--persona",
            "INTJ",
            "ENFP",
            "--ideas-per-agent",
            "1",
            "--discussion-rounds",
            "0",
            "--no-judge",
        ],
        cwd=Path(__file__).resolve().parents[2],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert completed.returncode == cli.EXIT_SUCCESS, completed.stderr
    assert "Traceback" not in completed.stderr
    exported = json.loads(completed.stdout)
    assert exported["session"]["status"] == "done"


def test_new_cli_run_recovers_claimed_session_after_sigkill(cli_temp_db, tmp_path):
    if sys.platform == "win32":
        pytest.skip("subprocess SIGKILL behavior is POSIX-specific")

    ready_path = tmp_path / "cli-before-sigkill"
    release_path = tmp_path / "unused-release-after-sigkill"
    killed_cli = _start_paused_mock_cli_run(ready_path, release_path)
    try:
        _wait_for_subprocess_marker(ready_path, killed_cli)
        killed_sessions = db.list_sessions()
        assert len(killed_sessions) == 1
        killed_session = killed_sessions[0]
        assert _session_has_run_claim(cli_temp_db, killed_session.id)
        killed_cli.kill()
        _, killed_stderr = killed_cli.communicate(timeout=10)
    finally:
        if killed_cli.poll() is None:
            killed_cli.kill()
            _, killed_stderr = killed_cli.communicate(timeout=10)

    assert killed_cli.returncode is not None
    assert "started session" in killed_stderr
    assert "Traceback" not in killed_stderr
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "backend.cli",
            "run",
            "--theme",
            "Recover after SIGKILL",
            "--persona",
            "INTJ",
            "ENFP",
            "--ideas-per-agent",
            "1",
            "--discussion-rounds",
            "0",
            "--no-judge",
        ],
        cwd=Path(__file__).resolve().parents[2],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert completed.returncode == cli.EXIT_SUCCESS, completed.stderr
    recovered_session = db.get_session(killed_session.id)
    assert recovered_session is not None
    assert recovered_session.status == "error"
    assert recovered_session.phase_progress == "Interrupted by a newer session start"
    exported = json.loads(completed.stdout)
    assert exported["session"]["status"] == "done"
    assert exported["session"]["id"] != killed_session.id


def test_session_run_lock_is_reacquired_after_owner_process_crash(cli_temp_db):
    lock_holder = subprocess.Popen(
        [
            sys.executable,
            "-c",
            (
                "import sys, time\n"
                "from backend.session_run_lock import acquire_session_run_lock\n"
                "run_lock = acquire_session_run_lock(sys.argv[1])\n"
                "print('locked', flush=True)\n"
                "time.sleep(60)\n"
            ),
            str(cli_temp_db),
        ],
        cwd=Path(__file__).resolve().parents[2],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert lock_holder.stdout is not None
        assert lock_holder.stdout.readline() == "locked\n"
        lock_holder.kill()
        _, lock_holder_stderr = lock_holder.communicate(timeout=10)
    finally:
        if lock_holder.poll() is None:
            lock_holder.kill()
            _, lock_holder_stderr = lock_holder.communicate(timeout=10)

    assert lock_holder.returncode is not None
    assert lock_holder_stderr == ""
    reacquired_run_lock = acquire_session_run_lock(str(cli_temp_db))
    reacquired_run_lock.release()
    reacquired_run_lock.release()
    lock_after_idempotent_release = acquire_session_run_lock(str(cli_temp_db))
    lock_after_idempotent_release.release()


def test_provider_stdout_diagnostics_are_redirected_to_stderr(monkeypatch):
    async def print_provider_diagnostic(session_config, report_progress, **_kwargs):
        print("provider diagnostic")
        return _sample_export_payload()

    monkeypatch.setattr(cli, "execute_brainstorm_session", print_provider_diagnostic)
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        ["run", "--theme", "Clean stdout"],
        stdin=io.StringIO(),
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_SUCCESS
    assert json.loads(stdout.getvalue())["session"]["status"] == "done"
    assert "provider diagnostic" not in stdout.getvalue()
    assert "provider diagnostic" in stderr.getvalue()


def test_output_failure_exits_one_without_traceback(tmp_path, monkeypatch):
    async def return_sample_payload(session_config, report_progress, **_kwargs):
        return _sample_export_payload()

    monkeypatch.setattr(cli, "execute_brainstorm_session", return_sample_payload)
    stderr = io.StringIO()

    exit_code = cli.main(
        [
            "run",
            "--theme",
            "Output failure",
            "--output",
            str(tmp_path / "missing-parent" / "result.json"),
        ],
        stdin=io.StringIO(),
        stdout=io.StringIO(),
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_RUNTIME_ERROR
    assert "could not write result" in stderr.getvalue()
    assert "Traceback" not in stderr.getvalue()


def test_export_markdown_4096_byte_stdout_pipe_does_not_exit_120(cli_temp_db):
    """``export --format md`` into a 4096-byte pipe must not become CPython 120."""

    _require_posix_pipe_size_control()
    db.init_db()
    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    session = db.create_session(
        SessionCreate(
            theme="Broken pipe markdown export",
            agents=[agent, agent],
            facilitator=FacilitatorConfig(provider="mock", model="mock"),
        )
    )
    db.insert_idea(
        session.id,
        "INTJ",
        "divergence",
        "M" * 20000,
    )
    db.update_session_status(session.id, "done", "Session completed")

    returncode, first_line, stderr_text = _run_cli_with_short_lived_stdout_pipe(
        ["export", session.id, "--format", "md"],
        environment=_build_cli_subprocess_environment(
            str(cli_temp_db),
            cli_temp_db.parent,
        ),
        pipe_size=4096,
    )

    assert first_line.startswith("# izayoi brainstorming session ")
    _assert_cli_broken_pipe_exit_contract(returncode, stderr_text)


def test_run_merged_stdio_head_closed_pipe_does_not_exit_120_or_hold_lock(
    cli_temp_db,
):
    """``run --provider mock 2>&1 | head -n 1`` must finish without a stuck lock."""

    if sys.platform == "win32":
        pytest.skip("merged-stdio head -n 1 EPIPE behavior is POSIX-specific")

    environment = _build_cli_subprocess_environment(
        str(cli_temp_db),
        cli_temp_db.parent,
    )
    run_arguments = [
        "run",
        "--theme",
        "Broken progress pipe",
        "--provider",
        "mock",
        "--persona",
        "INTJ",
        "ENFP",
        "--ideas-per-agent",
        "1",
        "--discussion-rounds",
        "0",
        "--no-judge",
    ]
    returncode, first_line, _merged_stderr = _run_cli_with_short_lived_stdout_pipe(
        run_arguments,
        environment=environment,
        pipe_size=None,
        merge_stderr=True,
    )

    _assert_cli_broken_pipe_exit_contract(returncode, _merged_stderr)
    session_id_match = cli._SESSION_ID_PATTERN.search(first_line)
    assert session_id_match is not None, first_line
    created_session = db.get_session(session_id_match.group(0))
    assert created_session is not None
    assert created_session.status in {"done", "error"}
    released_run_lock = acquire_session_run_lock(str(cli_temp_db))
    released_run_lock.release()

    follow_up_arguments = [
        "run",
        "--theme",
        "Follow-up run after broken progress pipe",
        "--provider",
        "mock",
        "--persona",
        "INTJ",
        "ENFP",
        "--ideas-per-agent",
        "1",
        "--discussion-rounds",
        "0",
        "--no-judge",
    ]
    next_run = subprocess.run(
        [sys.executable, "-m", "backend.cli", *follow_up_arguments],
        cwd=Path(__file__).resolve().parents[2],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert next_run.returncode == cli.EXIT_SUCCESS, next_run.stderr
    assert "another session is already running" not in next_run.stderr
    assert "Traceback" not in next_run.stderr
    assert json.loads(next_run.stdout)["session"]["status"] == "done"


def test_run_continues_after_stderr_progress_pipe_closes(cli_temp_db):
    """Closing only stderr must stop progress printing and still write stdout."""

    if sys.platform == "win32":
        pytest.skip("stderr-only EPIPE progress continuation is POSIX-specific")

    environment = _build_cli_subprocess_environment(
        str(cli_temp_db),
        cli_temp_db.parent,
    )
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "backend.cli",
            "run",
            "--theme",
            "Stderr progress pipe closed",
            "--provider",
            "mock",
            "--persona",
            "INTJ",
            "ENFP",
            "--ideas-per-agent",
            "1",
            "--discussion-rounds",
            "0",
            "--no-judge",
        ],
        cwd=Path(__file__).resolve().parents[2],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stdout_text = ""
    first_progress = ""
    try:
        assert process.stderr is not None
        first_progress = process.stderr.readline()
        process.stderr.close()
        assert process.stdout is not None
        stdout_text = process.stdout.read()
        process.wait(timeout=30)
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=10)

    assert first_progress.startswith("izayoi: created session ")
    assert process.returncode == cli.EXIT_SUCCESS, stdout_text
    exported = json.loads(stdout_text)
    assert exported["session"]["status"] == "done"
    released_run_lock = acquire_session_run_lock(str(cli_temp_db))
    released_run_lock.release()


def test_repeated_epipe_catches_do_not_increase_open_file_descriptor_count():
    """Repeated stdout+stderr EPIPE catches must not leak the /dev/null source fd."""

    _require_proc_self_fd_listing()
    stdout_stream = _open_broken_cli_pipe_text_stream()
    stderr_stream = _open_broken_cli_pipe_text_stream()
    try:
        file_descriptor_count_before = _count_open_process_file_descriptors()
        for _ in range(8):
            with pytest.raises(cli.BrainstormCliRuntimeError, match="could not write result"):
                cli.write_session_export_output("result\n", "-", stdout_stream)
            try:
                print("izayoi: progress after closed pipe", file=stderr_stream, flush=True)
            except OSError as exc:
                assert cli.is_broken_cli_pipe_error(exc)
                cli.redirect_broken_cli_pipe_stream_to_devnull(stderr_stream)
            assert stat.S_ISCHR(os.fstat(stdout_stream.fileno()).st_mode)
            assert stat.S_ISCHR(os.fstat(stderr_stream.fileno()).st_mode)
            assert _count_open_process_file_descriptors() == file_descriptor_count_before
            _replace_cli_stream_fd_with_broken_pipe(stdout_stream)
            _replace_cli_stream_fd_with_broken_pipe(stderr_stream)
            assert _count_open_process_file_descriptors() == file_descriptor_count_before
        if hasattr(signal, "SIGPIPE"):
            assert signal.getsignal(signal.SIGPIPE) is not signal.SIG_DFL
    finally:
        _close_cli_pipe_text_stream(stdout_stream)
        _close_cli_pipe_text_stream(stderr_stream)


def test_redirect_broken_cli_pipe_stream_closes_devnull_when_dup2_fails():
    """A failed dup2 must still close the temporary /dev/null file descriptor."""

    _require_proc_self_fd_listing()
    stream = _open_broken_cli_pipe_text_stream()
    try:

        def fail_dup2(_source_fd: int, _destination_fd: int) -> None:
            raise OSError(errno.EBADF, "dup2 failed")

        file_descriptor_count_before = _count_open_process_file_descriptors()
        with unittest.mock.patch.object(os, "dup2", fail_dup2):
            cli.redirect_broken_cli_pipe_stream_to_devnull(stream)
        assert _count_open_process_file_descriptors() == file_descriptor_count_before
        assert stat.S_ISFIFO(os.fstat(stream.fileno()).st_mode)
    finally:
        _close_cli_pipe_text_stream(stream)


_RUNTIME_PROVIDER_FAILURE_CLI_RUN_SCRIPT = """
import io
import sys

from backend import cli, providers

async def fail_provider_completion(*args, **kwargs):
    raise RuntimeError("simulated provider failure")

providers.complete = fail_provider_completion
exit_code = cli.main(
    [
        "run",
        "--theme",
        "Runtime provider failure",
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
    stdin=io.StringIO(),
)
raise SystemExit(exit_code)
"""

_MINIMAL_CLI_RUN_PREFIX = [
    "run",
    "--theme",
    "Provider configuration",
    "--persona",
    "INTJ",
    "ENFP",
    "--ideas-per-agent",
    "1",
    "--discussion-rounds",
    "0",
    "--no-judge",
]


def _cli_environment_without_provider_api_keys(
    database_path: str,
    temporary_directory: Path,
) -> dict[str, str]:
    """Build a CLI subprocess environment with cloud provider API keys removed."""

    environment = _build_cli_subprocess_environment(database_path, temporary_directory)
    for provider in providers.detect_providers():
        for env_var in providers.required_provider_env_vars(provider.id):
            environment.pop(env_var, None)
    return environment


def _run_isolated_cli_run_subprocess(
    database_path: Path,
    temporary_directory: Path,
    arguments: list[str],
    *,
    environment_updates: dict[str, str] | None = None,
    timeout: float = 30,
) -> subprocess.CompletedProcess[str]:
    """Run ``izayoi run`` in a child process without inherited cloud provider keys."""

    environment = _cli_environment_without_provider_api_keys(
        str(database_path),
        temporary_directory,
    )
    if environment_updates:
        environment.update(environment_updates)
    return subprocess.run(
        [sys.executable, "-m", "backend.cli", *arguments],
        cwd=Path(__file__).resolve().parents[2],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _assert_cli_rejected_before_session_artifacts(
    completed: subprocess.CompletedProcess[str],
    *,
    database_path: Path,
    output_path: Path,
    expected_error: str,
) -> None:
    """Require a one-line usage rejection with no session, lock, or output file."""

    lock_path = session_run_lock.session_run_lock_path(str(database_path))
    assert completed.returncode == cli.EXIT_USAGE_ERROR
    assert completed.stdout == ""
    assert completed.stderr == f"izayoi: error: {expected_error}\n"
    assert "Traceback" not in completed.stderr
    assert not database_path.exists()
    assert not lock_path.exists()
    assert not lock_path.parent.exists()
    assert not output_path.exists()


@pytest.mark.parametrize(
    ("provider_id", "model_id", "expected_error"),
    [
        ("openai", "gpt-5-mini", "provider 'openai' requires OPENAI_API_KEY"),
        ("anthropic", "claude-haiku-4-5", "provider 'anthropic' requires ANTHROPIC_API_KEY"),
        (
            "gemini",
            "gemini-3.6-flash",
            "provider 'gemini' requires GEMINI_API_KEY or GOOGLE_API_KEY",
        ),
    ],
    ids=("openai", "anthropic", "gemini"),
)
def test_missing_provider_api_key_exits_two_before_session_or_lock(
    tmp_path,
    provider_id,
    model_id,
    expected_error,
):
    database_path = tmp_path / "missing-key.db"
    output_path = tmp_path / "missing-key.json"
    completed = _run_isolated_cli_run_subprocess(
        database_path,
        tmp_path / "tmp",
        [
            *_MINIMAL_CLI_RUN_PREFIX,
            "--provider",
            provider_id,
            "--model",
            model_id,
            "--output",
            str(output_path),
        ],
    )
    _assert_cli_rejected_before_session_artifacts(
        completed,
        database_path=database_path,
        output_path=output_path,
        expected_error=expected_error,
    )


def test_unknown_provider_exits_two_before_session_or_lock(tmp_path):
    database_path = tmp_path / "unknown-provider.db"
    output_path = tmp_path / "unknown-provider.json"
    completed = _run_isolated_cli_run_subprocess(
        database_path,
        tmp_path / "tmp",
        [
            *_MINIMAL_CLI_RUN_PREFIX,
            "--provider",
            "not-a-provider",
            "--output",
            str(output_path),
        ],
    )
    assert "unknown provider 'not-a-provider'" in completed.stderr
    _assert_cli_rejected_before_session_artifacts(
        completed,
        database_path=database_path,
        output_path=output_path,
        expected_error=completed.stderr.removeprefix("izayoi: error: ").rstrip("\n"),
    )


def test_unknown_model_exits_two_before_session_or_lock(tmp_path):
    database_path = tmp_path / "unknown-model.db"
    output_path = tmp_path / "unknown-model.json"
    completed = _run_isolated_cli_run_subprocess(
        database_path,
        tmp_path / "tmp",
        [
            *_MINIMAL_CLI_RUN_PREFIX,
            "--provider",
            "mock",
            "--model",
            "not-a-model",
            "--output",
            str(output_path),
        ],
    )
    _assert_cli_rejected_before_session_artifacts(
        completed,
        database_path=database_path,
        output_path=output_path,
        expected_error="unknown model 'not-a-model' for provider 'mock'; choose one of: mock",
    )


def test_mock_provider_starts_without_api_keys(tmp_path):
    database_path = tmp_path / "mock-control.db"
    completed = _run_isolated_cli_run_subprocess(
        database_path,
        tmp_path / "tmp",
        [
            *_MINIMAL_CLI_RUN_PREFIX,
            "--provider",
            "mock",
            "--model",
            "mock",
        ],
        timeout=60,
    )
    assert completed.returncode == cli.EXIT_SUCCESS
    assert completed.stdout.lstrip().startswith("{")
    assert "Traceback" not in completed.stderr
    assert database_path.exists()
    with sqlite3.connect(database_path) as conn:
        rows = conn.execute("SELECT status FROM sessions").fetchall()
    assert rows == [("done",)]
    reacquired_run_lock = acquire_session_run_lock(str(database_path))
    reacquired_run_lock.release()


def test_detected_openai_key_resolves_without_starting_session(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    parsed_arguments = cli.create_cli_argument_parser().parse_args(
        [
            "run",
            "--theme",
            "Ready key",
            "--provider",
            "openai",
            "--model",
            "gpt-5-mini",
        ]
    )
    options = cli.build_brainstorm_run_options(parsed_arguments, io.StringIO())
    assert options.session_config.facilitator.provider == "openai"
    assert options.session_config.facilitator.model == "gpt-5-mini"
    assert all(agent.provider == "openai" for agent in options.session_config.agents)


def test_runtime_provider_failure_exits_one_with_session_error(tmp_path):
    database_path = tmp_path / "runtime-failure.db"
    temporary_directory = tmp_path / "tmp"
    temporary_directory.mkdir()
    completed = subprocess.run(
        [sys.executable, "-c", _RUNTIME_PROVIDER_FAILURE_CLI_RUN_SCRIPT],
        cwd=Path(__file__).resolve().parents[2],
        env=_cli_environment_without_provider_api_keys(
            str(database_path),
            temporary_directory,
        ),
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert completed.returncode == cli.EXIT_RUNTIME_ERROR
    assert completed.stdout == ""
    assert "simulated provider failure" in completed.stderr
    assert "Traceback" not in completed.stderr
    assert database_path.exists()
    with sqlite3.connect(database_path) as conn:
        rows = conn.execute("SELECT status, phase_progress FROM sessions").fetchall()
    assert len(rows) == 1
    assert rows[0][0] == "error"
    assert "simulated provider failure" in rows[0][1]
    reacquired_run_lock = acquire_session_run_lock(str(database_path))
    reacquired_run_lock.release()


def test_pyproject_exposes_izayoi_console_script():
    project_root = Path(__file__).resolve().parents[2]
    project = tomllib.loads((project_root / "pyproject.toml").read_text(encoding="utf-8"))

    assert project["project"]["scripts"]["izayoi"] == "backend.cli:main"


def _sample_export_payload():
    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    session = Session(
        id="session123",
        theme="Shared renderer",
        constraints="",
        status="done",
        phase_progress="Session completed",
        agents=[agent, agent],
        created_at="2026-01-01T00:00:00+00:00",
        metrics=None,
    )
    idea = Idea(
        id="idea123",
        session_id=session.id,
        persona_type="INTJ",
        phase="divergence",
        content="Use one shared export representation.",
    )
    messages = [
        {
            "id": "message123",
            "session_id": session.id,
            "round": 0,
            "anon_name": "Facilitator",
            "persona_type": "FACILITATOR",
            "content": "Frame the shared renderer.",
            "created_at": "2026-01-01T00:00:01+00:00",
        }
    ]
    return build_session_export_payload(session, [idea], messages)

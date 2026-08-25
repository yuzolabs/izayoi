"""Subprocess coverage for the persistent session run lock namespace."""

from __future__ import annotations

import json
import os
import sqlite3
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

from backend.session_run_lock import session_run_lock_path


_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_LOCK_PROBE_SCRIPT = r"""
import json
import os
import sys
import time
from pathlib import Path

import backend.session_run_lock as session_run_lock

if expected_uid := os.environ.get("IZAYOI_TEST_EXPECTED_LOCK_UID"):
    session_run_lock.os.geteuid = lambda: int(expected_uid)
if requested_umask := os.environ.get("IZAYOI_TEST_LOCK_UMASK"):
    os.umask(int(requested_umask, 8))

database_path = sys.argv[1]
start_gate_path = None if sys.argv[2] == "-" else Path(sys.argv[2])
ready_path = None if sys.argv[3] == "-" else Path(sys.argv[3])
release_path = None if sys.argv[4] == "-" else Path(sys.argv[4])

try:
    while start_gate_path is not None and not start_gate_path.exists():
        time.sleep(0.005)
    run_lock = session_run_lock.acquire_session_run_lock(database_path)
    lock_path = session_run_lock.session_run_lock_path(database_path)
    lock_status = lock_path.stat()
    print(
        json.dumps(
            {
                "status": "acquired",
                "lock_path": str(lock_path),
                "lock_inode": lock_status.st_ino,
                "lock_mode": lock_status.st_mode & 0o7777,
                "directory_mode": lock_path.parent.stat().st_mode & 0o7777,
            }
        ),
        flush=True,
    )
    if ready_path is not None:
        ready_path.write_text("ready", encoding="utf-8")
    while release_path is not None and not release_path.exists():
        time.sleep(0.005)
    run_lock.release()
except BaseException as exc:
    print(
        json.dumps(
            {
                "status": "error",
                "error_type": type(exc).__name__,
                "message": str(exc),
            }
        ),
        flush=True,
    )
    raise SystemExit(23)
"""
_PAUSED_MOCK_CLI_RUN_SCRIPT = r"""
import asyncio
import sys
from pathlib import Path

from backend import cli, providers

ready_path = Path(sys.argv[1])
release_path = Path(sys.argv[2])
original_complete = providers.complete

async def complete_after_release(*args, **kwargs):
    ready_path.write_text("ready", encoding="utf-8")
    while not release_path.exists():
        await asyncio.sleep(0.01)
    return await original_complete(*args, **kwargs)

providers.complete = complete_after_release
raise SystemExit(
    cli.main(
        [
            "run",
            "--theme",
            sys.argv[3],
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


def _source_tree_environment(
    database_path: Path,
    **overrides: str,
) -> dict[str, str]:
    """Build an isolated source-tree environment for a lock subprocess."""

    environment = os.environ.copy()
    environment["IZAYOI_DB_PATH"] = str(database_path)
    environment["PYTHONPATH"] = os.pathsep.join(
        value
        for value in (str(_PROJECT_ROOT), environment.get("PYTHONPATH"))
        if value
    )
    environment.update(overrides)
    return environment


def _run_lock_probe(
    database_path: Path,
    *,
    start_gate_path: Path | None = None,
    ready_path: Path | None = None,
    release_path: Path | None = None,
    environment_overrides: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run one lock acquisition to completion in a fresh interpreter."""

    return subprocess.run(
        [
            sys.executable,
            "-c",
            _LOCK_PROBE_SCRIPT,
            str(database_path),
            str(start_gate_path) if start_gate_path is not None else "-",
            str(ready_path) if ready_path is not None else "-",
            str(release_path) if release_path is not None else "-",
        ],
        cwd=_PROJECT_ROOT,
        env=_source_tree_environment(
            database_path,
            **(environment_overrides or {}),
        ),
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )


def _start_lock_probe(
    database_path: Path,
    *,
    start_gate_path: Path | None = None,
    ready_path: Path | None = None,
    release_path: Path | None = None,
) -> subprocess.Popen[str]:
    """Start one lock probe that may wait on synchronization marker files."""

    return subprocess.Popen(
        [
            sys.executable,
            "-c",
            _LOCK_PROBE_SCRIPT,
            str(database_path),
            str(start_gate_path) if start_gate_path is not None else "-",
            str(ready_path) if ready_path is not None else "-",
            str(release_path) if release_path is not None else "-",
        ],
        cwd=_PROJECT_ROOT,
        env=_source_tree_environment(database_path),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _wait_for_marker(
    marker_path: Path,
    processes: list[subprocess.Popen[str]],
    timeout: float = 15.0,
) -> None:
    """Wait for a marker while surfacing any subprocess that exits early."""

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if marker_path.exists():
            return
        for process in processes:
            if process.poll() is not None:
                stdout, stderr = process.communicate()
                raise AssertionError(
                    "lock subprocess exited before marker: "
                    f"returncode={process.returncode}, stdout={stdout!r}, stderr={stderr!r}"
                )
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for lock marker {marker_path}")


def _lock_probe_payload(completed: subprocess.CompletedProcess[str]) -> dict[str, object]:
    """Decode the single JSON diagnostic emitted by a completed lock probe."""

    assert completed.stderr == ""
    assert completed.stdout.strip(), completed
    return json.loads(completed.stdout.strip().splitlines()[-1])


def _mock_cli_run_command(theme: str) -> list[str]:
    return [
        sys.executable,
        "-m",
        "backend.cli",
        "run",
        "--theme",
        theme,
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


def test_real_database_near_name_max_uses_fixed_length_hashed_lock(tmp_path: Path):
    """A real SQLite run must not append a lock suffix to a near-limit DB name."""

    try:
        filename_limit = os.pathconf(tmp_path, "PC_NAME_MAX")
    except (AttributeError, OSError, ValueError):
        pytest.skip("the filesystem does not report NAME_MAX")
    if filename_limit < 64:
        pytest.skip("the filesystem NAME_MAX is too small for this regression test")

    # SQLite may create a same-directory "-journal" file. Leaving exactly that
    # suffix length available isolates the old, one-byte-too-long ".run.lock"
    # failure while still exercising a real database.
    database_filename_length = filename_limit - len("-journal")
    database_filename = (
        "n" * (database_filename_length - len(".db")) + ".db"
    )
    database_path = tmp_path / database_filename
    assert len(os.fsencode(database_path.name)) == database_filename_length
    assert len(os.fsencode(f"{database_path.name}.run.lock")) > filename_limit

    completed = subprocess.run(
        _mock_cli_run_command("Near NAME_MAX database"),
        cwd=_PROJECT_ROOT,
        env=_source_tree_environment(database_path),
        check=False,
        capture_output=True,
        text=True,
        timeout=45,
    )

    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout)["session"]["status"] == "done"
    assert database_path.is_file()
    lock_path = session_run_lock_path(str(database_path))
    assert lock_path.parent == tmp_path / ".izayoi-run-locks"
    assert len(os.fsencode(lock_path.name)) == 64 + len(".lock")
    assert lock_path.is_file()
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1


def test_suffix_named_database_runs_concurrently_in_separate_lock_namespace(
    tmp_path: Path,
):
    """A database named like the legacy sidecar must remain an independent DB."""

    first_database_path = tmp_path / "sessions.db"
    suffix_database_path = tmp_path / "sessions.db.run.lock"
    first_ready_path = tmp_path / "first-ready"
    suffix_ready_path = tmp_path / "suffix-ready"
    first_release_path = tmp_path / "release-first"
    suffix_release_path = tmp_path / "release-suffix"

    def start_paused_cli(
        database_path: Path,
        ready_path: Path,
        release_path: Path,
        theme: str,
    ) -> subprocess.Popen[str]:
        return subprocess.Popen(
            [
                sys.executable,
                "-c",
                _PAUSED_MOCK_CLI_RUN_SCRIPT,
                str(ready_path),
                str(release_path),
                theme,
            ],
            cwd=_PROJECT_ROOT,
            env=_source_tree_environment(database_path),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    first_process = start_paused_cli(
        first_database_path,
        first_ready_path,
        first_release_path,
        "Primary database run",
    )
    suffix_process: subprocess.Popen[str] | None = None
    try:
        _wait_for_marker(first_ready_path, [first_process])
        suffix_process = start_paused_cli(
            suffix_database_path,
            suffix_ready_path,
            suffix_release_path,
            "Legacy suffix database run",
        )
        _wait_for_marker(suffix_ready_path, [first_process, suffix_process])
        assert first_process.poll() is None
        assert suffix_process.poll() is None
    finally:
        first_release_path.touch()
        suffix_release_path.touch()

    first_stdout, first_stderr = first_process.communicate(timeout=30)
    assert suffix_process is not None
    suffix_stdout, suffix_stderr = suffix_process.communicate(timeout=30)
    assert first_process.returncode == 0, first_stderr
    assert suffix_process.returncode == 0, suffix_stderr
    assert json.loads(first_stdout)["session"]["theme"] == "Primary database run"
    assert json.loads(suffix_stdout)["session"]["theme"] == "Legacy suffix database run"
    assert first_database_path.is_file()
    assert suffix_database_path.is_file()
    first_lock_path = session_run_lock_path(str(first_database_path))
    suffix_lock_path = session_run_lock_path(str(suffix_database_path))
    assert first_lock_path != suffix_lock_path
    assert first_lock_path.is_file()
    assert suffix_lock_path.is_file()
    with sqlite3.connect(first_database_path) as first_connection:
        assert first_connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1
    with sqlite3.connect(suffix_database_path) as suffix_connection:
        assert suffix_connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1


def test_same_database_blocks_while_different_database_acquires_in_subprocesses(
    tmp_path: Path,
):
    first_database_path = tmp_path / "first.db"
    different_database_path = tmp_path / "different.db"
    ready_path = tmp_path / "first-lock-ready"
    release_path = tmp_path / "release-first-lock"
    holder = _start_lock_probe(
        first_database_path,
        ready_path=ready_path,
        release_path=release_path,
    )
    holder_stdout = ""
    holder_stderr = ""
    try:
        _wait_for_marker(ready_path, [holder])
        same_database_probe = _run_lock_probe(first_database_path)
        different_database_probe = _run_lock_probe(different_database_path)

        same_payload = _lock_probe_payload(same_database_probe)
        different_payload = _lock_probe_payload(different_database_probe)
        assert same_database_probe.returncode == 23
        assert same_payload["error_type"] == "SessionRunLockUnavailable"
        assert "another session is already running" in str(same_payload["message"])
        assert different_database_probe.returncode == 0
        assert different_payload["status"] == "acquired"
        assert holder.poll() is None
    finally:
        release_path.touch()
        try:
            holder_stdout, holder_stderr = holder.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            holder.kill()
            holder_stdout, holder_stderr = holder.communicate(timeout=10)

    assert holder.returncode == 0, holder_stderr
    assert json.loads(holder_stdout)["status"] == "acquired"


def test_concurrent_subprocesses_create_absent_lock_directory_without_mkdir_race(
    tmp_path: Path,
):
    database_parent = tmp_path / "shared-database-parent"
    database_parent.mkdir()
    start_gate_path = tmp_path / "start-lock-race"
    processes = [
        _start_lock_probe(
            database_parent / f"database-{index}.db",
            start_gate_path=start_gate_path,
        )
        for index in range(8)
    ]
    assert not (database_parent / ".izayoi-run-locks").exists()
    start_gate_path.touch()

    results: list[tuple[int, str, str]] = []
    for process in processes:
        try:
            stdout, stderr = process.communicate(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate(timeout=10)
        results.append((process.returncode, stdout, stderr))

    assert all(returncode == 0 for returncode, _, _ in results), results
    assert all(stderr == "" for _, _, stderr in results)
    payloads = [json.loads(stdout) for _, stdout, _ in results]
    assert all(payload["status"] == "acquired" for payload in payloads)
    lock_directory_path = database_parent / ".izayoi-run-locks"
    assert stat.S_IMODE(lock_directory_path.stat().st_mode) == 0o700
    assert len(list(lock_directory_path.glob("*.lock"))) == len(processes)


@pytest.mark.parametrize("collision_kind", ["regular-file", "symbolic-link"])
def test_lock_directory_collision_is_rejected_untouched_by_subprocess(
    tmp_path: Path,
    collision_kind: str,
):
    database_parent = tmp_path / collision_kind
    database_parent.mkdir()
    lock_directory_path = database_parent / ".izayoi-run-locks"
    symlink_target_path = tmp_path / f"{collision_kind}-target"
    if collision_kind == "regular-file":
        original_bytes = b"do not modify lock directory collision"
        lock_directory_path.write_bytes(original_bytes)
    else:
        symlink_target_path.mkdir()
        try:
            lock_directory_path.symlink_to(symlink_target_path, target_is_directory=True)
        except (NotImplementedError, OSError) as exc:
            pytest.skip(f"symbolic links are unavailable: {exc}")
    original_status = lock_directory_path.lstat()
    original_link_target = (
        os.readlink(lock_directory_path)
        if collision_kind == "symbolic-link"
        else None
    )

    completed = _run_lock_probe(database_parent / "sessions.db")

    payload = _lock_probe_payload(completed)
    resulting_status = lock_directory_path.lstat()
    assert completed.returncode == 23
    assert payload["status"] == "error"
    assert "Session run lock directory rejected" in str(payload["message"])
    assert "remove or rename" in str(payload["message"])
    assert resulting_status.st_ino == original_status.st_ino
    assert stat.S_IFMT(resulting_status.st_mode) == stat.S_IFMT(original_status.st_mode)
    if collision_kind == "regular-file":
        assert lock_directory_path.read_bytes() == original_bytes
    else:
        assert lock_directory_path.is_symlink()
        assert os.readlink(lock_directory_path) == original_link_target
        assert list(symlink_target_path.iterdir()) == []


def test_private_modes_and_persistent_inode_survive_subprocess_reacquisition(
    tmp_path: Path,
):
    database_path = tmp_path / "permissions.db"
    first_probe = _run_lock_probe(
        database_path,
        environment_overrides={"IZAYOI_TEST_LOCK_UMASK": "000"},
    )
    first_payload = _lock_probe_payload(first_probe)
    assert first_probe.returncode == 0
    lock_path = Path(str(first_payload["lock_path"]))
    first_lock_status = lock_path.stat()
    lock_path.parent.chmod(0o777)
    lock_path.chmod(0o666)

    second_probe = _run_lock_probe(database_path)

    second_payload = _lock_probe_payload(second_probe)
    second_lock_status = lock_path.stat()
    assert second_probe.returncode == 0
    assert first_payload["lock_inode"] == second_payload["lock_inode"]
    assert second_lock_status.st_ino == first_lock_status.st_ino
    assert stat.S_IMODE(lock_path.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(second_lock_status.st_mode) == 0o600
    assert list(lock_path.parent.iterdir()) == [lock_path]


@pytest.mark.skipif(not hasattr(os, "geteuid"), reason="POSIX uid ownership is required")
def test_wrong_owner_lock_directory_is_rejected_without_mutation_in_subprocess(
    tmp_path: Path,
):
    database_path = tmp_path / "wrong-owner.db"
    lock_directory_path = tmp_path / ".izayoi-run-locks"
    lock_directory_path.mkdir(mode=0o700)
    original_status = lock_directory_path.stat()
    expected_other_uid = os.geteuid() + 1

    completed = _run_lock_probe(
        database_path,
        environment_overrides={
            "IZAYOI_TEST_EXPECTED_LOCK_UID": str(expected_other_uid),
        },
    )

    payload = _lock_probe_payload(completed)
    resulting_status = lock_directory_path.stat()
    assert completed.returncode == 23
    assert "ownership rejected" in str(payload["message"])
    assert f"found uid {os.geteuid()}" in str(payload["message"])
    assert f"expected effective uid {expected_other_uid}" in str(payload["message"])
    assert resulting_status.st_ino == original_status.st_ino
    assert stat.S_IMODE(resulting_status.st_mode) == 0o700
    assert list(lock_directory_path.iterdir()) == []

"""File-system safety tests for CLI output destinations and atomic writes."""

from __future__ import annotations

import io
import json
import os
import sqlite3
import stat
from pathlib import Path

import pytest

from backend import cli, cli_output, db, providers
from backend.models import AgentConfig, FacilitatorConfig, SessionCreate
from backend.session_run_lock import acquire_session_run_lock, session_run_lock_path


@pytest.fixture()
def persisted_cli_output_database(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Create one exportable session in an isolated CLI database."""

    database_path = tmp_path / "cli-output.db"
    monkeypatch.setenv("IZAYOI_DB_PATH", str(database_path))
    db.init_db()
    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    session = db.create_session(
        SessionCreate(
            theme="CLI output safety",
            agents=[agent, agent],
            facilitator=FacilitatorConfig(provider="mock", model="mock"),
        )
    )
    db.update_session_status(session.id, "done", "Session completed")
    return database_path, session.id


@pytest.mark.parametrize("command_name", ["run", "export"])
@pytest.mark.parametrize("protected_name", ["database", "run-lock"])
@pytest.mark.parametrize("alias_kind", ["direct", "symlink", "hardlink"])
def test_cli_rejects_database_and_lock_output_aliases_before_side_effects(
    persisted_cli_output_database,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    command_name: str,
    protected_name: str,
    alias_kind: str,
):
    database_path, session_id = persisted_cli_output_database
    protected_path = _prepare_cli_protected_path(database_path, protected_name)
    output_path = _create_cli_output_alias(
        protected_path,
        tmp_path / f"{protected_name}-{alias_kind}.out",
        alias_kind,
    )
    row_counts_before = _cli_database_row_counts(database_path)
    protected_bytes_before = protected_path.read_bytes()
    protected_mtime_before = protected_path.stat().st_mtime_ns
    provider_call_count = 0

    async def observe_provider_call(*args, **kwargs):
        nonlocal provider_call_count
        provider_call_count += 1
        raise AssertionError("provider must not run for an unsafe --output")

    monkeypatch.setattr(providers, "complete", observe_provider_call)
    if command_name == "run":
        arguments = ["run", "--theme", "Reject unsafe output", "--output", str(output_path)]
    else:
        arguments = ["export", session_id, "--output", str(output_path)]
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        arguments,
        stdin=io.StringIO(),
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_RUNTIME_ERROR
    assert stdout.getvalue() == ""
    assert "CLI output destination is unsafe" in stderr.getvalue()
    assert "aliases the session" in stderr.getvalue()
    assert "choose another file or use --output -" in stderr.getvalue()
    assert "Traceback" not in stderr.getvalue()
    assert provider_call_count == 0
    assert _cli_database_row_counts(database_path) == row_counts_before
    assert protected_path.read_bytes() == protected_bytes_before
    assert protected_path.stat().st_mtime_ns == protected_mtime_before
    assert os.path.samefile(output_path, protected_path)


@pytest.mark.parametrize("protected_name", ["database", "run-lock"])
def test_output_validation_does_not_create_missing_database_or_lock(
    tmp_path: Path,
    protected_name: str,
):
    database_path = tmp_path / "missing.db"
    lock_path = session_run_lock_path(str(database_path))
    output_path = database_path if protected_name == "database" else lock_path

    with pytest.raises(cli_output.CliOutputSafetyError, match="destination is unsafe"):
        cli_output.validate_cli_output_destination(str(output_path), str(database_path))

    assert not database_path.exists()
    assert not lock_path.exists()
    assert list(tmp_path.iterdir()) == []


def test_output_alias_guard_reserves_hashed_lock_not_legacy_suffix(tmp_path: Path):
    """The old sidecar spelling remains available as an independent DB path."""

    database_path = tmp_path / "sessions.db"
    hashed_lock_path = session_run_lock_path(str(database_path))
    legacy_suffix_path = Path(f"{database_path}.run.lock")

    assert hashed_lock_path != legacy_suffix_path
    with pytest.raises(cli_output.CliOutputSafetyError, match="session run lock"):
        cli_output.validate_cli_output_destination(
            str(hashed_lock_path),
            str(database_path),
        )

    cli_output.validate_cli_output_destination(
        str(legacy_suffix_path),
        str(database_path),
    )
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("failure_stage", ["write", "fsync", "replace"])
def test_atomic_output_failure_preserves_existing_bytes_and_removes_temp_file(
    persisted_cli_output_database,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure_stage: str,
):
    _, session_id = persisted_cli_output_database
    output_path = tmp_path / "existing-result.json"
    original_output_bytes = b"existing output\x00\xff\n"
    output_path.write_bytes(original_output_bytes)
    output_path.chmod(0o640)
    original_output_status = output_path.stat()

    if failure_stage == "write":

        def fail_output_write(*args, **kwargs):
            raise OSError("forced temp write failure")

        monkeypatch.setattr(cli_output, "_write_all_cli_output_bytes", fail_output_write)
    elif failure_stage == "fsync":

        def fail_output_fsync(file_descriptor: int):
            raise OSError("forced temp fsync failure")

        monkeypatch.setattr(cli_output.os, "fsync", fail_output_fsync)
    else:

        def fail_output_replace(source, destination):
            raise OSError("forced atomic replace failure")

        monkeypatch.setattr(cli_output.os, "replace", fail_output_replace)

    stdout = io.StringIO()
    stderr = io.StringIO()
    exit_code = cli.main(
        ["export", session_id, "--output", str(output_path)],
        stdin=io.StringIO(),
        stdout=stdout,
        stderr=stderr,
    )

    result_output_status = output_path.stat()
    assert exit_code == cli.EXIT_RUNTIME_ERROR
    assert stdout.getvalue() == ""
    assert output_path.read_bytes() == original_output_bytes
    assert (
        result_output_status.st_ino,
        result_output_status.st_uid,
        result_output_status.st_gid,
        stat.S_IMODE(result_output_status.st_mode),
        result_output_status.st_mtime_ns,
    ) == (
        original_output_status.st_ino,
        original_output_status.st_uid,
        original_output_status.st_gid,
        stat.S_IMODE(original_output_status.st_mode),
        original_output_status.st_mtime_ns,
    )
    assert list(tmp_path.glob(".izayoi-output-*.tmp")) == []
    assert "could not write result" in stderr.getvalue()
    assert f"forced temp {failure_stage} failure" in stderr.getvalue() or (
        failure_stage == "replace" and "forced atomic replace failure" in stderr.getvalue()
    )
    assert "parent directory exists and is writable" in stderr.getvalue()
    assert "Traceback" not in stderr.getvalue()


def test_atomic_output_overwrite_is_exact_private_and_preserves_existing_mode(
    persisted_cli_output_database,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    _, session_id = persisted_cli_output_database
    output_path = tmp_path / "result.json"
    output_path.write_bytes(b"old output must disappear")
    output_path.chmod(0o640)
    original_output_status = output_path.stat()
    expected_payload = cli.load_persisted_session_export(session_id)
    expected_output = f"{cli.render_session_export_output(expected_payload, 'json')}\n"
    observed_temporary_modes: list[int] = []
    fsync_call_count = 0
    original_write_all = cli_output._write_all_cli_output_bytes
    original_fsync = cli_output.os.fsync

    def observe_private_temp_mode(temporary_file, output_bytes):
        observed_temporary_modes.append(
            stat.S_IMODE(os.fstat(temporary_file.fileno()).st_mode)
        )
        original_write_all(temporary_file, output_bytes)

    def observe_fsync(file_descriptor: int):
        nonlocal fsync_call_count
        fsync_call_count += 1
        return original_fsync(file_descriptor)

    monkeypatch.setattr(cli_output, "_write_all_cli_output_bytes", observe_private_temp_mode)
    monkeypatch.setattr(cli_output.os, "fsync", observe_fsync)
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        ["export", session_id, "--output", str(output_path)],
        stdin=io.StringIO(),
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_SUCCESS
    assert stdout.getvalue() == ""
    assert stderr.getvalue() == ""
    assert output_path.read_bytes() == expected_output.encode("utf-8")
    assert json.loads(output_path.read_text(encoding="utf-8")) == expected_payload
    assert observed_temporary_modes == [0o600]
    result_output_status = output_path.stat()
    assert result_output_status.st_uid == original_output_status.st_uid
    assert result_output_status.st_gid == original_output_status.st_gid
    assert stat.S_IMODE(result_output_status.st_mode) == 0o640
    assert fsync_call_count >= 1
    if os.name != "nt":
        assert fsync_call_count >= 2
    assert list(tmp_path.glob(".izayoi-output-*.tmp")) == []


@pytest.mark.skipif(
    not hasattr(os, "fchown") or not hasattr(os, "fchmod"),
    reason="file-descriptor ownership and mode operations are required",
)
def test_existing_output_applies_owner_then_mode_before_fsync_and_replace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    output_path = tmp_path / "ordered-metadata.txt"
    output_path.write_text("old output", encoding="utf-8")
    output_path.chmod(0o640)
    existing_status = output_path.stat()
    publication_events: list[str] = []
    observed_owner: tuple[int, int] | None = None
    observed_mode: int | None = None
    original_fchown = cli_output.os.fchown
    original_fchmod = cli_output.os.fchmod
    original_fsync = cli_output.os.fsync
    original_replace = cli_output.os.replace

    def observe_fchown(file_descriptor: int, uid: int, gid: int):
        nonlocal observed_owner
        publication_events.append("fchown")
        observed_owner = (uid, gid)
        return original_fchown(file_descriptor, uid, gid)

    def observe_fchmod(file_descriptor: int, mode: int):
        nonlocal observed_mode
        publication_events.append("fchmod")
        observed_mode = mode
        return original_fchmod(file_descriptor, mode)

    def observe_fsync(file_descriptor: int):
        descriptor_mode = os.fstat(file_descriptor).st_mode
        publication_events.append(
            "file-fsync" if stat.S_ISREG(descriptor_mode) else "directory-fsync"
        )
        return original_fsync(file_descriptor)

    def observe_replace(source, destination):
        publication_events.append("replace")
        return original_replace(source, destination)

    monkeypatch.setattr(cli_output.os, "fchown", observe_fchown)
    monkeypatch.setattr(cli_output.os, "fchmod", observe_fchmod)
    monkeypatch.setattr(cli_output.os, "fsync", observe_fsync)
    monkeypatch.setattr(cli_output.os, "replace", observe_replace)

    cli_output.write_cli_output_atomically("new output", str(output_path))

    assert publication_events[:4] == ["fchown", "fchmod", "file-fsync", "replace"]
    assert observed_owner == (existing_status.st_uid, existing_status.st_gid)
    assert observed_mode == stat.S_IMODE(existing_status.st_mode)
    result_status = output_path.stat()
    assert result_status.st_uid == existing_status.st_uid
    assert result_status.st_gid == existing_status.st_gid
    assert stat.S_IMODE(result_status.st_mode) == stat.S_IMODE(
        existing_status.st_mode
    )


@pytest.mark.skipif(
    not hasattr(os, "fchown") or not hasattr(os, "fchmod"),
    reason="file-descriptor ownership and mode operations are required",
)
@pytest.mark.parametrize("metadata_operation", ["fchown", "fchmod"])
def test_metadata_application_failure_rolls_back_existing_output(
    persisted_cli_output_database,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    metadata_operation: str,
):
    _, session_id = persisted_cli_output_database
    output_path = tmp_path / "metadata-failure.json"
    original_output_bytes = b"preserve bytes and metadata\x00\xff"
    output_path.write_bytes(original_output_bytes)
    output_path.chmod(0o604)
    original_status = output_path.stat()

    def fail_metadata_application(*args, **kwargs):
        raise OSError(f"forced {metadata_operation} failure")

    monkeypatch.setattr(cli_output.os, metadata_operation, fail_metadata_application)
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        ["export", session_id, "--output", str(output_path)],
        stdin=io.StringIO(),
        stdout=stdout,
        stderr=stderr,
    )

    result_status = output_path.stat()
    assert exit_code == cli.EXIT_RUNTIME_ERROR
    assert stdout.getvalue() == ""
    assert f"forced {metadata_operation} failure" in stderr.getvalue()
    assert "Traceback" not in stderr.getvalue()
    assert output_path.read_bytes() == original_output_bytes
    assert (
        result_status.st_ino,
        result_status.st_uid,
        result_status.st_gid,
        stat.S_IMODE(result_status.st_mode),
        result_status.st_mtime_ns,
    ) == (
        original_status.st_ino,
        original_status.st_uid,
        original_status.st_gid,
        stat.S_IMODE(original_status.st_mode),
        original_status.st_mtime_ns,
    )
    assert list(tmp_path.glob(".izayoi-output-*.tmp")) == []


@pytest.mark.skipif(
    not all(hasattr(os, name) for name in ("chown", "geteuid", "getegid", "getgroups")),
    reason="POSIX supplementary groups are required",
)
def test_existing_output_preserves_alternate_group_and_complete_mode(tmp_path: Path):
    alternate_groups = sorted(set(os.getgroups()) - {os.getegid()})
    if not alternate_groups:
        pytest.skip("the process has no alternate supplementary group")

    output_path = tmp_path / "alternate-group.txt"
    output_path.write_text("old group-owned output", encoding="utf-8")
    alternate_gid = alternate_groups[0]
    try:
        os.chown(output_path, os.geteuid(), alternate_gid)
        output_path.chmod(0o2640)
    except OSError as exc:
        pytest.skip(f"cannot create alternate-group output: {exc}")
    existing_status = output_path.stat()
    if stat.S_IMODE(existing_status.st_mode) != 0o2640:
        pytest.skip("the filesystem did not retain the setgid mode bit")

    cli_output.write_cli_output_atomically("new group-owned output", str(output_path))

    result_status = output_path.stat()
    assert output_path.read_text(encoding="utf-8") == "new group-owned output"
    assert result_status.st_uid == existing_status.st_uid
    assert result_status.st_gid == alternate_gid
    assert stat.S_IMODE(result_status.st_mode) == 0o2640
    assert list(tmp_path.glob(".izayoi-output-*.tmp")) == []


@pytest.mark.skipif(
    not hasattr(os, "geteuid") or os.geteuid() != 0,
    reason="changing an output file to an alternate uid requires root",
)
def test_existing_output_preserves_alternate_uid_when_running_as_root(tmp_path: Path):
    output_path = tmp_path / "alternate-owner.txt"
    output_path.write_text("old owner output", encoding="utf-8")
    alternate_uid = 1 if os.geteuid() != 1 else 2
    alternate_gid = 1 if os.getegid() != 1 else 2
    os.chown(output_path, alternate_uid, alternate_gid)
    output_path.chmod(0o640)

    cli_output.write_cli_output_atomically("new owner output", str(output_path))

    result_status = output_path.stat()
    assert result_status.st_uid == alternate_uid
    assert result_status.st_gid == alternate_gid
    assert stat.S_IMODE(result_status.st_mode) == 0o640
    assert output_path.read_text(encoding="utf-8") == "new owner output"
    assert list(tmp_path.glob(".izayoi-output-*.tmp")) == []


def test_new_output_keeps_secure_default_metadata(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    output_path = tmp_path / "new-output.txt"

    def reject_existing_metadata_application(*args, **kwargs):
        raise AssertionError("new output must keep secure temp-file metadata")

    monkeypatch.setattr(
        cli_output,
        "_apply_existing_regular_cli_output_metadata",
        reject_existing_metadata_application,
    )
    original_umask = os.umask(0)
    try:
        cli_output.write_cli_output_atomically("new output", str(output_path))
    finally:
        os.umask(original_umask)

    result_status = output_path.stat()
    assert output_path.read_text(encoding="utf-8") == "new output"
    assert stat.S_IMODE(result_status.st_mode) == 0o600
    if hasattr(os, "geteuid"):
        assert result_status.st_uid == os.geteuid()
    if hasattr(os, "getegid"):
        assert result_status.st_gid == os.getegid()
    assert list(tmp_path.glob(".izayoi-output-*.tmp")) == []


def test_ordinary_symlink_output_is_rejected_without_replacing_link(
    persisted_cli_output_database,
    tmp_path: Path,
):
    _, session_id = persisted_cli_output_database
    symlink_target = tmp_path / "ordinary-target.json"
    original_target_bytes = b"ordinary symlink target must remain"
    symlink_target.write_bytes(original_target_bytes)
    symlink_target.chmod(0o640)
    output_path = tmp_path / "ordinary-output-link.json"
    try:
        output_path.symlink_to(symlink_target)
    except (NotImplementedError, OSError) as exc:
        pytest.skip(f"symbolic links are unavailable: {exc}")
    original_link_target = os.readlink(output_path)
    original_link_status = output_path.lstat()
    original_target_status = symlink_target.stat()
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        ["export", session_id, "--output", str(output_path)],
        stdin=io.StringIO(),
        stdout=stdout,
        stderr=stderr,
    )

    result_link_status = output_path.lstat()
    result_target_status = symlink_target.stat()
    assert exit_code == cli.EXIT_RUNTIME_ERROR
    assert stdout.getvalue() == ""
    assert "symbolic link" in stderr.getvalue()
    assert "Traceback" not in stderr.getvalue()
    assert output_path.is_symlink()
    assert os.readlink(output_path) == original_link_target
    assert result_link_status.st_ino == original_link_status.st_ino
    assert symlink_target.read_bytes() == original_target_bytes
    assert (
        result_target_status.st_ino,
        result_target_status.st_uid,
        result_target_status.st_gid,
        stat.S_IMODE(result_target_status.st_mode),
        result_target_status.st_mtime_ns,
    ) == (
        original_target_status.st_ino,
        original_target_status.st_uid,
        original_target_status.st_gid,
        stat.S_IMODE(original_target_status.st_mode),
        original_target_status.st_mtime_ns,
    )
    assert list(tmp_path.glob(".izayoi-output-*.tmp")) == []


def test_ordinary_hardlink_output_detaches_only_published_name(
    persisted_cli_output_database,
    tmp_path: Path,
):
    _, session_id = persisted_cli_output_database
    output_path = tmp_path / "ordinary-hardlink-output.json"
    sibling_hardlink = tmp_path / "ordinary-hardlink-sibling.json"
    original_output_bytes = b"shared hardlink bytes"
    output_path.write_bytes(original_output_bytes)
    output_path.chmod(0o640)
    try:
        os.link(output_path, sibling_hardlink)
    except (NotImplementedError, OSError) as exc:
        pytest.skip(f"hard links are unavailable: {exc}")
    original_status = output_path.stat()
    expected_payload = cli.load_persisted_session_export(session_id)
    expected_output = f"{cli.render_session_export_output(expected_payload, 'json')}\n"
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        ["export", session_id, "--output", str(output_path)],
        stdin=io.StringIO(),
        stdout=stdout,
        stderr=stderr,
    )

    result_status = output_path.stat()
    sibling_status = sibling_hardlink.stat()
    assert exit_code == cli.EXIT_SUCCESS
    assert stdout.getvalue() == ""
    assert stderr.getvalue() == ""
    assert output_path.read_bytes() == expected_output.encode("utf-8")
    assert sibling_hardlink.read_bytes() == original_output_bytes
    assert not os.path.samefile(output_path, sibling_hardlink)
    assert result_status.st_ino != original_status.st_ino
    assert sibling_status.st_ino == original_status.st_ino
    assert result_status.st_uid == original_status.st_uid
    assert result_status.st_gid == original_status.st_gid
    assert stat.S_IMODE(result_status.st_mode) == 0o640
    assert list(tmp_path.glob(".izayoi-output-*.tmp")) == []


@pytest.mark.skipif(os.name == "nt", reason="directory fsync requires POSIX descriptors")
def test_parent_directory_fsync_failure_keeps_committed_success(
    persisted_cli_output_database,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    _, session_id = persisted_cli_output_database
    output_path = tmp_path / "committed-despite-directory-fsync.json"
    expected_payload = cli.load_persisted_session_export(session_id)
    expected_output = f"{cli.render_session_export_output(expected_payload, 'json')}\n"
    original_fsync = cli_output.os.fsync
    fsync_events: list[str] = []

    def fail_only_directory_fsync(file_descriptor: int):
        descriptor_mode = os.fstat(file_descriptor).st_mode
        if stat.S_ISDIR(descriptor_mode):
            fsync_events.append("directory-fsync-failed-after-commit")
            raise OSError("forced parent directory fsync failure")
        fsync_events.append("file-fsync-succeeded-before-commit")
        return original_fsync(file_descriptor)

    monkeypatch.setattr(cli_output.os, "fsync", fail_only_directory_fsync)
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        ["export", session_id, "--output", str(output_path)],
        stdin=io.StringIO(),
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_SUCCESS
    assert stdout.getvalue() == ""
    assert stderr.getvalue() == ""
    assert fsync_events == [
        "file-fsync-succeeded-before-commit",
        "directory-fsync-failed-after-commit",
    ]
    assert output_path.read_bytes() == expected_output.encode("utf-8")
    assert list(tmp_path.glob(".izayoi-output-*.tmp")) == []


def test_stdout_output_bypasses_atomic_file_writer(
    persisted_cli_output_database,
    monkeypatch: pytest.MonkeyPatch,
):
    _, session_id = persisted_cli_output_database

    def reject_file_writer_call(*args, **kwargs):
        raise AssertionError("stdout output must not use the atomic file writer")

    monkeypatch.setattr(cli, "write_cli_output_atomically", reject_file_writer_call)
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        ["export", session_id, "--output", "-"],
        stdin=io.StringIO(),
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_SUCCESS
    assert json.loads(stdout.getvalue())["session"]["id"] == session_id
    assert stdout.getvalue().endswith("\n")
    assert stderr.getvalue() == ""


def test_output_directory_path_exits_one_without_traceback(
    persisted_cli_output_database,
    tmp_path: Path,
):
    _, session_id = persisted_cli_output_database
    output_directory = tmp_path / "not-a-result-file"
    output_directory.mkdir()
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = cli.main(
        ["export", session_id, "--output", str(output_directory)],
        stdin=io.StringIO(),
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == cli.EXIT_RUNTIME_ERROR
    assert stdout.getvalue() == ""
    assert output_directory.is_dir()
    assert list(output_directory.iterdir()) == []
    assert list(tmp_path.glob(".izayoi-output-*.tmp")) == []
    assert "could not write result" in stderr.getvalue()
    assert str(output_directory) in stderr.getvalue()
    assert "regular file" in stderr.getvalue()
    assert "Traceback" not in stderr.getvalue()


@pytest.mark.skipif(os.name == "nt", reason="POSIX directory permissions are required")
def test_nonwritable_output_directory_exits_one_and_preserves_target(
    persisted_cli_output_database,
    tmp_path: Path,
):
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        pytest.skip("root can bypass the nonwritable directory mode")

    _, session_id = persisted_cli_output_database
    output_directory = tmp_path / "read-only"
    output_directory.mkdir()
    output_path = output_directory / "result.json"
    original_output_bytes = b"keep this output"
    output_path.write_bytes(original_output_bytes)
    output_directory.chmod(0o500)
    stdout = io.StringIO()
    stderr = io.StringIO()
    try:
        exit_code = cli.main(
            ["export", session_id, "--output", str(output_path)],
            stdin=io.StringIO(),
            stdout=stdout,
            stderr=stderr,
        )
    finally:
        output_directory.chmod(0o700)

    assert exit_code == cli.EXIT_RUNTIME_ERROR
    assert stdout.getvalue() == ""
    assert output_path.read_bytes() == original_output_bytes
    assert list(output_directory.glob(".izayoi-output-*.tmp")) == []
    assert "could not write result" in stderr.getvalue()
    assert "writable" in stderr.getvalue()
    assert "Traceback" not in stderr.getvalue()


def _prepare_cli_protected_path(database_path: Path, protected_name: str) -> Path:
    if protected_name == "database":
        return database_path

    run_lock = acquire_session_run_lock(str(database_path))
    run_lock.release()
    return session_run_lock_path(str(database_path))


def _create_cli_output_alias(
    protected_path: Path,
    alias_path: Path,
    alias_kind: str,
) -> Path:
    if alias_kind == "direct":
        return protected_path
    try:
        if alias_kind == "symlink":
            alias_path.symlink_to(protected_path)
        else:
            os.link(protected_path, alias_path)
    except (NotImplementedError, OSError) as exc:
        pytest.skip(f"{alias_kind} aliases are unavailable: {exc}")
    return alias_path


def _cli_database_row_counts(database_path: Path) -> tuple[int, int, int]:
    with sqlite3.connect(database_path) as connection:
        session_count = connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        idea_count = connection.execute("SELECT COUNT(*) FROM ideas").fetchone()[0]
        message_count = connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    return session_count, idea_count, message_count

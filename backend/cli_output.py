"""Safe destination validation and atomic file writes for CLI result output."""

from __future__ import annotations

import os
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from .session_run_lock import resolve_session_database_path, session_run_lock_path


class CliOutputSafetyError(RuntimeError):
    """Raised when CLI output could overwrite the session database or run lock."""


class CliOutputWriteError(RuntimeError):
    """Raised when an atomic CLI output file replacement cannot be completed."""


@dataclass(frozen=True)
class _ExistingRegularCliOutputMetadata:
    """Ownership and mode copied from an existing regular CLI output file."""

    uid: int
    gid: int
    mode: int


def validate_cli_output_destination(output_path: str, database_path: str) -> None:
    """Reject a file output that aliases the canonical database or its run lock.

    This check only resolves and stats paths. It never creates or modifies the
    database, run lock, output destination, or any parent directory.
    """

    if output_path == "-":
        return

    output_destination = Path(output_path).expanduser()
    try:
        canonical_database_path = Path(resolve_session_database_path(database_path))
        protected_destinations = tuple(
            (protected_name, protected_path, _resolve_cli_path_identity(protected_path))
            for protected_name, protected_path in (
                ("session database", canonical_database_path),
                ("session run lock", session_run_lock_path(database_path)),
            )
        )
        resolved_output_identity = _resolve_cli_path_identity(output_destination)
    except (OSError, RuntimeError) as exc:
        raise CliOutputSafetyError(
            f"CLI output validation failed for --output {output_path!r}: {exc}; "
            "choose a resolvable file path or use --output -"
        ) from exc

    for protected_name, protected_path, protected_identity in protected_destinations:
        if resolved_output_identity == protected_identity:
            raise _cli_output_alias_error(output_path, protected_name, protected_path)

        try:
            paths_share_inode = os.path.samefile(output_destination, protected_path)
        except FileNotFoundError:
            # A missing output or protected file cannot yet share an inode. The
            # resolved equality check above still rejects their direct paths.
            paths_share_inode = False
        except OSError as exc:
            raise CliOutputSafetyError(
                f"CLI output validation failed for --output {output_path!r}: "
                f"could not compare it with the {protected_name} at "
                f"'{protected_path}': {exc}; choose another file path or use --output -"
            ) from exc

        if paths_share_inode:
            raise _cli_output_alias_error(output_path, protected_name, protected_path)


def write_cli_output_atomically(output_text: str, output_path: str) -> None:
    """Atomically publish durable UTF-8 output with explicit link semantics.

    An existing regular file contributes its uid, gid, and complete permission
    mode to the private temp file. Replacement detaches an ordinary hardlink
    name from its old inode, leaving sibling hardlinks unchanged. Symbolic links
    and other non-regular destinations are refused rather than replaced.

    ``os.replace`` is the commit point. Every earlier failure removes the temp
    file and leaves the destination unchanged. Parent-directory durability is
    attempted after commit, but cannot turn published output into a retryable
    failure.
    """

    output_destination = Path(output_path).expanduser()
    output_bytes: bytes
    temporary_fd: int | None = None
    temporary_path: Path | None = None

    try:
        output_bytes = output_text.encode("utf-8")
        existing_metadata = _read_existing_regular_cli_output_metadata(
            output_destination
        )
        temporary_fd, temporary_name = tempfile.mkstemp(
            prefix=".izayoi-output-",
            suffix=".tmp",
            dir=output_destination.parent,
        )
        temporary_path = Path(temporary_name)

        temporary_file = os.fdopen(temporary_fd, "wb")
        temporary_fd = None
        with temporary_file:
            _write_all_cli_output_bytes(temporary_file, output_bytes)
            temporary_file.flush()
            if existing_metadata is not None:
                _apply_existing_regular_cli_output_metadata(
                    temporary_file.fileno(), existing_metadata
                )
            os.fsync(temporary_file.fileno())

        os.replace(temporary_path, output_destination)
        temporary_path = None
    except Exception as exc:
        raise CliOutputWriteError(
            f"CLI output write failed: could not write result to --output "
            f"{output_path!r}: {exc}; choose a regular file whose parent directory "
            "exists and is writable"
        ) from exc
    finally:
        if temporary_fd is not None:
            try:
                os.close(temporary_fd)
            except OSError:
                pass
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                # The original write error is more actionable. Cleanup is
                # best-effort only when the filesystem itself rejects unlink.
                pass

    _best_effort_fsync_cli_output_parent_directory(output_destination.parent)


def _resolve_cli_path_identity(path: Path) -> str:
    return os.path.normcase(str(path.resolve()))


def _cli_output_alias_error(
    output_path: str,
    protected_name: str,
    protected_path: Path,
) -> CliOutputSafetyError:
    return CliOutputSafetyError(
        f"CLI output destination is unsafe: --output {output_path!r} aliases the "
        f"{protected_name} at '{protected_path}'; choose another file or use --output -"
    )


def _read_existing_regular_cli_output_metadata(
    output_destination: Path,
) -> _ExistingRegularCliOutputMetadata | None:
    """Read metadata only from a regular path, never through a symbolic link."""

    try:
        destination_status = output_destination.lstat()
    except FileNotFoundError:
        return None

    if not stat.S_ISREG(destination_status.st_mode):
        destination_kind = (
            "symbolic link"
            if stat.S_ISLNK(destination_status.st_mode)
            else "non-regular file"
        )
        raise OSError(
            f"CLI output destination type rejected: {output_destination} is a "
            f"{destination_kind}; use a new path or an existing regular file"
        )

    return _ExistingRegularCliOutputMetadata(
        uid=destination_status.st_uid,
        gid=destination_status.st_gid,
        mode=stat.S_IMODE(destination_status.st_mode),
    )


def _apply_existing_regular_cli_output_metadata(
    temporary_fd: int,
    existing_metadata: _ExistingRegularCliOutputMetadata,
) -> None:
    """Apply existing ownership before mode so chown cannot clear mode bits."""

    file_owner_setter = getattr(os, "fchown", None)
    file_mode_setter = getattr(os, "fchmod", None)
    if file_owner_setter is None or file_mode_setter is None:
        raise OSError(
            "CLI output metadata preservation unavailable: fchown and fchmod "
            "are required to overwrite an existing regular file"
        )

    file_owner_setter(temporary_fd, existing_metadata.uid, existing_metadata.gid)
    file_mode_setter(temporary_fd, existing_metadata.mode)


def _write_all_cli_output_bytes(temporary_file: BinaryIO, output_bytes: bytes) -> None:
    remaining_output = memoryview(output_bytes)
    while remaining_output:
        written_byte_count = temporary_file.write(remaining_output)
        if written_byte_count is None or written_byte_count <= 0:
            raise OSError("CLI output temp file write made no progress")
        remaining_output = remaining_output[written_byte_count:]


def _best_effort_fsync_cli_output_parent_directory(parent_directory: Path) -> None:
    """Try to persist the committed directory entry without reporting failure.

    Atomic replacement has already published the output, so an unsupported or
    failed directory fsync must not encourage callers to repeat side effects.
    """

    directory_fd: int | None = None
    try:
        open_flags = os.O_RDONLY
        open_flags |= getattr(os, "O_DIRECTORY", 0)
        open_flags |= getattr(os, "O_CLOEXEC", 0)
        directory_fd = os.open(parent_directory, open_flags)
        os.fsync(directory_fd)
    except OSError:
        # Some supported filesystems and Windows do not permit directory
        # descriptors or directory fsync. The file replacement is complete.
        pass
    finally:
        if directory_fd is not None:
            try:
                os.close(directory_fd)
            except OSError:
                pass

"""Cross-process capability enforcing the one-running-session constraint."""

from __future__ import annotations

import errno
import hashlib
import os
import stat
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, Iterator


class SessionRunLockUnavailable(RuntimeError):
    """Raised when another process already owns the session run lock."""


class SessionRunLockOwnershipError(RuntimeError):
    """Raised when a token is not the current lock owner for the selected database."""


_SESSION_RUN_LOCK_CONSTRUCTION_KEY = object()
_SESSION_RUN_LOCK_REGISTRY_GUARD = threading.Lock()
_SESSION_RUN_LOCK_DIRECTORY_NAME = ".izayoi-run-locks"
_SESSION_RUN_LOCK_FILE_SUFFIX = ".lock"
_ACQUIRED_SESSION_RUN_LOCKS: dict[int, SessionRunLock] = {}


class SessionRunLock:
    """Capability for one acquired lock, canonical database path, and owner process."""

    def __init__(
        self,
        lock_file: BinaryIO,
        canonical_database_path: str,
        construction_key: object,
    ) -> None:
        if construction_key is not _SESSION_RUN_LOCK_CONSTRUCTION_KEY:
            raise TypeError("SessionRunLock construction is restricted to lock acquisition")
        self._lock_file = lock_file
        self._canonical_database_path = canonical_database_path
        self._owner_pid = os.getpid()
        self._released = False
        self._lifecycle_guard = threading.RLock()

    def release(self) -> None:
        """Release this session run lock; repeated releases are harmless."""

        with self._lifecycle_guard:
            if self._released:
                return
            self._released = True
            with _SESSION_RUN_LOCK_REGISTRY_GUARD:
                registered_lock = _ACQUIRED_SESSION_RUN_LOCKS.get(id(self))
                if registered_lock is self:
                    del _ACQUIRED_SESSION_RUN_LOCKS[id(self)]

            # A forked child must not explicitly unlock the parent's shared
            # open-file description. Closing only the child's descriptor keeps
            # the parent process's ownership intact.
            if self._owner_pid != os.getpid():
                self._lock_file.close()
                return

            try:
                _unlock_session_run_file(self._lock_file)
            finally:
                self._lock_file.close()


def acquire_session_run_lock(database_path: str) -> SessionRunLock:
    """Acquire a non-blocking OS lock for the canonical SQLite database path.

    Lock-file bytes are deliberately ignored, so stale or corrupt contents
    cannot create metadata parsing failures or become the source of ownership.
    """

    canonical_database_path = resolve_session_database_path(database_path)
    lock_path = _session_run_lock_path_for_canonical_database(
        canonical_database_path
    )
    lock_file = _open_persistent_session_run_lock_file(lock_path)

    try:
        _lock_session_run_file_nonblocking(lock_file)
    except OSError as exc:
        lock_file.close()
        if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
            raise SessionRunLockUnavailable(
                "another session is already running"
            ) from exc
        raise RuntimeError(
            f"Session run lock acquisition failed at '{lock_path}': {exc}"
        ) from exc

    session_run_lock = SessionRunLock(
        lock_file,
        canonical_database_path,
        _SESSION_RUN_LOCK_CONSTRUCTION_KEY,
    )
    with _SESSION_RUN_LOCK_REGISTRY_GUARD:
        _ACQUIRED_SESSION_RUN_LOCKS[id(session_run_lock)] = session_run_lock
    return session_run_lock


@contextmanager
def hold_session_run_lock_ownership(
    session_run_lock: SessionRunLock | None,
    database_path: str,
) -> Iterator[str]:
    """Hold verified lock ownership for the canonical database path until exit."""

    if not isinstance(session_run_lock, SessionRunLock):
        raise SessionRunLockOwnershipError(
            "Session run lock ownership invalid: an acquired SessionRunLock is required"
        )

    with _SESSION_RUN_LOCK_REGISTRY_GUARD:
        registered_lock = _ACQUIRED_SESSION_RUN_LOCKS.get(id(session_run_lock))
    if registered_lock is not session_run_lock:
        raise SessionRunLockOwnershipError(
            "Session run lock ownership invalid: token is forged or released"
        )

    # release() takes this same guard. The second registry check closes the
    # race between the first lookup and acquiring the per-token lifecycle guard.
    with session_run_lock._lifecycle_guard:
        with _SESSION_RUN_LOCK_REGISTRY_GUARD:
            registered_lock = _ACQUIRED_SESSION_RUN_LOCKS.get(id(session_run_lock))
        if (
            registered_lock is not session_run_lock
            or session_run_lock._released
            or session_run_lock._lock_file.closed
            or session_run_lock._owner_pid != os.getpid()
        ):
            raise SessionRunLockOwnershipError(
                "Session run lock ownership invalid: token is not currently acquired"
            )

        canonical_database_path = resolve_session_database_path(database_path)
        if canonical_database_path != session_run_lock._canonical_database_path:
            raise SessionRunLockOwnershipError(
                "Session run lock ownership invalid: token belongs to a different database"
            )
        yield canonical_database_path


def resolve_session_database_path(database_path: str) -> str:
    """Return the absolute, symlink-resolved identity of a session database path."""

    resolved_database_path = Path(database_path).expanduser().resolve()
    return os.path.normcase(str(resolved_database_path))


def session_run_lock_path(database_path: str) -> Path:
    """Return the fixed-length persistent run lock for a canonical database.

    Hashing the canonical database path's filesystem bytes keeps the lock name
    below ``NAME_MAX`` and gives every database its own lock namespace. The
    lock file must never be unlinked during release: one deterministic inode is
    the cross-process serialization point.
    """

    canonical_database_path = resolve_session_database_path(database_path)
    return _session_run_lock_path_for_canonical_database(canonical_database_path)


def _session_run_lock_path_for_canonical_database(
    canonical_database_path: str,
) -> Path:
    """Map already-canonical database bytes to one fixed-length lock path."""

    database_identity_digest = hashlib.sha256(
        os.fsencode(canonical_database_path)
    ).hexdigest()
    return (
        Path(canonical_database_path).parent
        / _SESSION_RUN_LOCK_DIRECTORY_NAME
        / f"{database_identity_digest}{_SESSION_RUN_LOCK_FILE_SUFFIX}"
    )


def _open_persistent_session_run_lock_file(lock_path: Path) -> BinaryIO:
    """Open one private persistent lock inode without following lock-path links."""

    database_parent = lock_path.parent.parent
    try:
        database_parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise RuntimeError(
            f"Session run lock database parent could not be created at "
            f"'{database_parent}': {exc}; create a writable database parent and retry"
        ) from exc

    if _session_run_lock_dir_fd_operations_supported():
        return _open_session_run_lock_file_relative_to_parent(
            database_parent,
            lock_path,
        )
    return _open_session_run_lock_file_portably(lock_path)


def _session_run_lock_dir_fd_operations_supported() -> bool:
    """Report whether this platform supports no-follow relative lock operations."""

    return (
        os.name != "nt"
        and hasattr(os, "O_DIRECTORY")
        and hasattr(os, "O_NOFOLLOW")
        and all(
            operation in os.supports_dir_fd
            for operation in (os.mkdir, os.open, os.stat)
        )
    )


def _open_session_run_lock_file_relative_to_parent(
    database_parent: Path,
    lock_path: Path,
) -> BinaryIO:
    """Open a lock via pinned parent and lock-directory descriptors."""

    parent_descriptor: int | None = None
    lock_directory_descriptor: int | None = None
    try:
        parent_descriptor = os.open(
            database_parent,
            _session_run_lock_directory_open_flags(),
        )
        _verify_open_session_run_lock_path_identity(
            database_parent,
            os.stat(database_parent, follow_symlinks=False),
            os.fstat(parent_descriptor),
        )
        lock_directory_descriptor = _open_private_session_run_lock_directory(
            parent_descriptor,
            lock_path.parent,
        )
        return _open_private_session_run_lock_inode(
            lock_directory_descriptor,
            lock_path,
        )
    except RuntimeError:
        raise
    except OSError as exc:
        raise RuntimeError(
            f"Session run lock path could not be opened safely at '{lock_path}': "
            f"{exc}; verify that its database parent is a real accessible directory"
        ) from exc
    finally:
        if lock_directory_descriptor is not None:
            os.close(lock_directory_descriptor)
        if parent_descriptor is not None:
            os.close(parent_descriptor)


def _open_private_session_run_lock_directory(
    database_parent_descriptor: int,
    lock_directory_path: Path,
) -> int:
    """Create or open the private lock directory across concurrent mkdir calls."""

    try:
        os.mkdir(
            _SESSION_RUN_LOCK_DIRECTORY_NAME,
            mode=0o700,
            dir_fd=database_parent_descriptor,
        )
    except FileExistsError:
        # Another process may have won the mkdir race. The no-follow stat and
        # descriptor checks below decide whether its entry is the expected one.
        pass
    except OSError as exc:
        raise RuntimeError(
            f"Session run lock directory could not be created at "
            f"'{lock_directory_path}': {exc}; ensure the database parent is writable"
        ) from exc

    directory_entry_status = _stat_session_run_lock_entry(
        database_parent_descriptor,
        _SESSION_RUN_LOCK_DIRECTORY_NAME,
        lock_directory_path,
        "directory",
    )
    _validate_session_run_lock_directory_status(
        directory_entry_status,
        lock_directory_path,
    )

    try:
        lock_directory_descriptor = os.open(
            _SESSION_RUN_LOCK_DIRECTORY_NAME,
            _session_run_lock_directory_open_flags(),
            dir_fd=database_parent_descriptor,
        )
    except OSError as exc:
        raise RuntimeError(
            f"Session run lock directory could not be opened safely at "
            f"'{lock_directory_path}': {exc}; it must be a real directory owned "
            "by the current user"
        ) from exc

    try:
        opened_directory_status = os.fstat(lock_directory_descriptor)
        _validate_session_run_lock_directory_status(
            opened_directory_status,
            lock_directory_path,
        )
        _verify_open_session_run_lock_path_identity(
            lock_directory_path,
            directory_entry_status,
            opened_directory_status,
        )
        _set_private_session_run_lock_mode(
            lock_directory_descriptor,
            lock_directory_path,
            0o700,
            "directory",
        )
        current_directory_status = _stat_session_run_lock_entry(
            database_parent_descriptor,
            _SESSION_RUN_LOCK_DIRECTORY_NAME,
            lock_directory_path,
            "directory",
        )
        _verify_open_session_run_lock_path_identity(
            lock_directory_path,
            current_directory_status,
            os.fstat(lock_directory_descriptor),
        )
    except BaseException:
        os.close(lock_directory_descriptor)
        raise
    return lock_directory_descriptor


def _open_private_session_run_lock_inode(
    lock_directory_descriptor: int,
    lock_path: Path,
) -> BinaryIO:
    """Open and validate the persistent regular file used for OS locking."""

    lock_filename = lock_path.name
    existing_status: os.stat_result | None
    try:
        existing_status = os.stat(
            lock_filename,
            dir_fd=lock_directory_descriptor,
            follow_symlinks=False,
        )
    except FileNotFoundError:
        existing_status = None
    except OSError as exc:
        raise RuntimeError(
            f"Session run lock file could not be inspected at '{lock_path}': "
            f"{exc}; verify the lock directory is accessible"
        ) from exc

    if existing_status is not None:
        _validate_session_run_lock_file_status(existing_status, lock_path)

    lock_descriptor: int | None = None
    try:
        lock_descriptor = os.open(
            lock_filename,
            _session_run_lock_file_open_flags(),
            mode=0o600,
            dir_fd=lock_directory_descriptor,
        )
        opened_file_status = os.fstat(lock_descriptor)
        _validate_session_run_lock_file_status(opened_file_status, lock_path)
        if existing_status is not None:
            _verify_open_session_run_lock_path_identity(
                lock_path,
                existing_status,
                opened_file_status,
            )
        current_file_status = _stat_session_run_lock_entry(
            lock_directory_descriptor,
            lock_filename,
            lock_path,
            "file",
        )
        _verify_open_session_run_lock_path_identity(
            lock_path,
            current_file_status,
            opened_file_status,
        )
        _set_private_session_run_lock_mode(
            lock_descriptor,
            lock_path,
            0o600,
            "file",
        )
        _verify_open_session_run_lock_path_identity(
            lock_path,
            _stat_session_run_lock_entry(
                lock_directory_descriptor,
                lock_filename,
                lock_path,
                "file",
            ),
            os.fstat(lock_descriptor),
        )
        lock_file = os.fdopen(lock_descriptor, "r+b")
        lock_descriptor = None
        return lock_file
    except RuntimeError:
        raise
    except OSError as exc:
        raise RuntimeError(
            f"Session run lock file could not be opened safely at '{lock_path}': "
            f"{exc}; it must be one regular file owned by the current user"
        ) from exc
    finally:
        if lock_descriptor is not None:
            os.close(lock_descriptor)


def _open_session_run_lock_file_portably(lock_path: Path) -> BinaryIO:
    """Use lstat and descriptor checks where relative no-follow APIs are absent."""

    lock_directory_path = lock_path.parent
    try:
        lock_directory_path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    except OSError as exc:
        raise RuntimeError(
            f"Session run lock directory could not be created at "
            f"'{lock_directory_path}': {exc}; ensure the database parent is writable"
        ) from exc

    try:
        directory_status = lock_directory_path.lstat()
    except OSError as exc:
        raise RuntimeError(
            f"Session run lock directory could not be inspected at "
            f"'{lock_directory_path}': {exc}"
        ) from exc
    _validate_session_run_lock_directory_status(
        directory_status,
        lock_directory_path,
    )
    if os.name != "nt" and stat.S_IMODE(directory_status.st_mode) != 0o700:
        lock_directory_path.chmod(0o700)

    existing_status: os.stat_result | None
    try:
        existing_status = lock_path.lstat()
    except FileNotFoundError:
        existing_status = None
    if existing_status is not None:
        _validate_session_run_lock_file_status(existing_status, lock_path)

    lock_descriptor: int | None = None
    try:
        lock_descriptor = os.open(
            lock_path,
            _session_run_lock_file_open_flags(),
            0o600,
        )
        opened_file_status = os.fstat(lock_descriptor)
        _validate_session_run_lock_file_status(opened_file_status, lock_path)
        if existing_status is not None:
            _verify_open_session_run_lock_path_identity(
                lock_path,
                existing_status,
                opened_file_status,
            )
        _verify_open_session_run_lock_path_identity(
            lock_path,
            lock_path.lstat(),
            opened_file_status,
        )
        _set_private_session_run_lock_mode(
            lock_descriptor,
            lock_path,
            0o600,
            "file",
        )
        lock_file = os.fdopen(lock_descriptor, "r+b")
        lock_descriptor = None
        return lock_file
    except RuntimeError:
        raise
    except OSError as exc:
        raise RuntimeError(
            f"Session run lock file could not be opened safely at '{lock_path}': "
            f"{exc}; it must be one regular file owned by the current user"
        ) from exc
    finally:
        if lock_descriptor is not None:
            os.close(lock_descriptor)


def _session_run_lock_directory_open_flags() -> int:
    return (
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0)
    )


def _session_run_lock_file_open_flags() -> int:
    return (
        os.O_RDWR
        | os.O_CREAT
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )


def _stat_session_run_lock_entry(
    parent_descriptor: int,
    entry_name: str,
    entry_path: Path,
    entry_kind: str,
) -> os.stat_result:
    try:
        return os.stat(
            entry_name,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
    except OSError as exc:
        raise RuntimeError(
            f"Session run lock {entry_kind} could not be inspected at "
            f"'{entry_path}': {exc}; retry after checking the containing directory"
        ) from exc


def _validate_session_run_lock_directory_status(
    entry_status: os.stat_result,
    lock_directory_path: Path,
) -> None:
    if not stat.S_ISDIR(entry_status.st_mode):
        entry_kind = _session_run_lock_entry_kind(entry_status.st_mode)
        raise RuntimeError(
            f"Session run lock directory rejected at '{lock_directory_path}': "
            f"expected a real directory, found {entry_kind}; remove or rename that "
            "entry and retry"
        )
    _validate_session_run_lock_entry_owner(
        entry_status,
        lock_directory_path,
        "directory",
    )


def _validate_session_run_lock_file_status(
    entry_status: os.stat_result,
    lock_path: Path,
) -> None:
    if not stat.S_ISREG(entry_status.st_mode):
        entry_kind = _session_run_lock_entry_kind(entry_status.st_mode)
        raise RuntimeError(
            f"Session run lock file rejected at '{lock_path}': expected a regular "
            f"file, found {entry_kind}; remove or rename that entry and retry"
        )
    _validate_session_run_lock_entry_owner(entry_status, lock_path, "file")
    if entry_status.st_nlink != 1:
        raise RuntimeError(
            f"Session run lock file rejected at '{lock_path}': expected one private "
            f"name, found {entry_status.st_nlink} hard links; remove the extra links "
            "or the lock file and retry"
        )


def _validate_session_run_lock_entry_owner(
    entry_status: os.stat_result,
    entry_path: Path,
    entry_kind: str,
) -> None:
    effective_uid_getter = getattr(os, "geteuid", None)
    if effective_uid_getter is None:
        return
    effective_uid = effective_uid_getter()
    if entry_status.st_uid != effective_uid:
        raise RuntimeError(
            f"Session run lock {entry_kind} ownership rejected at '{entry_path}': "
            f"found uid {entry_status.st_uid}, expected effective uid {effective_uid}; "
            "ask the owner to remove or relocate that entry and retry"
        )


def _set_private_session_run_lock_mode(
    entry_descriptor: int,
    entry_path: Path,
    required_mode: int,
    entry_kind: str,
) -> None:
    current_mode = stat.S_IMODE(os.fstat(entry_descriptor).st_mode)
    if current_mode == required_mode or os.name == "nt":
        return
    try:
        os.fchmod(entry_descriptor, required_mode)
    except OSError as exc:
        raise RuntimeError(
            f"Session run lock {entry_kind} permissions could not be secured at "
            f"'{entry_path}': expected mode {required_mode:#05o}: {exc}; fix its "
            "permissions or remove it and retry"
        ) from exc
    resulting_mode = stat.S_IMODE(os.fstat(entry_descriptor).st_mode)
    if resulting_mode != required_mode:
        raise RuntimeError(
            f"Session run lock {entry_kind} permissions rejected at '{entry_path}': "
            f"found mode {resulting_mode:#05o}, expected {required_mode:#05o}; use a "
            "filesystem that supports private owner-only permissions"
        )


def _verify_open_session_run_lock_path_identity(
    entry_path: Path,
    path_status: os.stat_result,
    descriptor_status: os.stat_result,
) -> None:
    if (path_status.st_dev, path_status.st_ino) != (
        descriptor_status.st_dev,
        descriptor_status.st_ino,
    ):
        raise RuntimeError(
            f"Session run lock path changed while opening '{entry_path}'; secure the "
            "database parent against concurrent renames and retry"
        )


def _session_run_lock_entry_kind(entry_mode: int) -> str:
    if stat.S_ISLNK(entry_mode):
        return "a symbolic link"
    if stat.S_ISREG(entry_mode):
        return "a regular file"
    if stat.S_ISDIR(entry_mode):
        return "a directory"
    if stat.S_ISFIFO(entry_mode):
        return "a FIFO"
    if stat.S_ISSOCK(entry_mode):
        return "a socket"
    if stat.S_ISCHR(entry_mode):
        return "a character device"
    if stat.S_ISBLK(entry_mode):
        return "a block device"
    return "an unsupported filesystem entry"


def _lock_session_run_file_nonblocking(lock_file: BinaryIO) -> None:
    if os.name == "nt":
        import msvcrt

        lock_file.seek(0)
        if lock_file.read(1) == b"":
            lock_file.write(b"\0")
            lock_file.flush()
        lock_file.seek(0)
        msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
        return

    import fcntl

    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock_session_run_file(lock_file: BinaryIO) -> None:
    try:
        if os.name == "nt":
            import msvcrt

            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            return

        import fcntl

        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    except OSError:
        # Closing the descriptor below is the final lock-release mechanism on
        # both supported platform families; cleanup must not mask run results.
        pass

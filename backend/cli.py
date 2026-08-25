"""Non-interactive command line entry point for brainstorming runs and exports."""

from __future__ import annotations

import argparse
import asyncio
import errno
import math
import os
import re
import stat
import sys
from collections.abc import Callable, Sequence
from contextlib import redirect_stdout
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, TextIO

from pydantic import ValidationError

from . import db, orchestrator, personas, providers
from .cli_output import (
    CliOutputSafetyError,
    CliOutputWriteError,
    validate_cli_output_destination,
    write_cli_output_atomically,
)
from .cli_sigterm import (
    CLI_SIGTERM_REASON,
    CliSigtermCancellation,
    CliSigtermReceived,
)
from .cli_version import PrintIzayoiCliVersionAction
from .models import AgentConfig, FacilitatorConfig, SessionCreate
from .session_export import (
    SessionExportPayload,
    build_session_export_payload,
    render_session_export_markdown,
    serialize_session_export_json,
)
from .session_live_phase import unexportable_session_status_message

EXIT_SUCCESS = 0
EXIT_RUNTIME_ERROR = 1
EXIT_USAGE_ERROR = 2
EXIT_INTERRUPTED = 130
EXIT_SIGTERM = 143

# Wall-clock seconds ``izayoi run`` waits after create/start. ``0`` disables.
CLI_RUN_DEFAULT_TIMEOUT_SECONDS = 900

# CPython overwrites a handled BrokenPipeError with this status when it flushes
# a still-open broken stdout or stderr pipe during interpreter shutdown.
EXIT_BROKEN_PIPE_SHUTDOWN = 120


_SESSION_ID_PATTERN = re.compile(r"[0-9a-f]{12}")


def is_broken_cli_pipe_error(error: BaseException) -> bool:
    """Return True for BrokenPipeError or an OSError whose errno is EPIPE."""

    if isinstance(error, BrokenPipeError):
        return True
    return isinstance(error, OSError) and error.errno == errno.EPIPE


def redirect_broken_cli_pipe_stream_to_devnull(stream: TextIO) -> None:
    """Replace a live broken stdout or stderr pipe with /dev/null.

    Catching BrokenPipeError or EPIPE is not enough. CPython still flushes the
    original descriptor during interpreter shutdown, prints ``Exception ignored
    on flushing sys.stdout`` (or stderr), and overwrites the process exit status
    with 120. Do not install ``SIGPIPE`` ``SIG_DFL`` to paper over this: the
    first progress line is emitted after create/start, so a default SIGPIPE
    would kill the process and leave an orphan run.

    The temporary /dev/null file descriptor is closed after dup2 so a repeated
    EPIPE catch cannot leak open file descriptors. O_CLOEXEC keeps that source
    fd from surviving an unexpected exec between open and close.
    """

    fileno = getattr(stream, "fileno", None)
    if fileno is None:
        return
    try:
        fd = fileno()
    except (OSError, ValueError):
        return
    try:
        devnull_fd = os.open(os.devnull, os.O_WRONLY | getattr(os, "O_CLOEXEC", 0))
        try:
            os.dup2(devnull_fd, fd)
        finally:
            os.close(devnull_fd)
    except OSError:
        return


def redirect_cli_stdio_pipes_before_cpython_shutdown(*streams: TextIO) -> None:
    """Flush CLI stdio, then detach any pipe before CPython finalize can exit 120."""

    for stream in streams:
        try:
            stream.flush()
        except OSError as exc:
            if not is_broken_cli_pipe_error(exc):
                raise
            redirect_broken_cli_pipe_stream_to_devnull(stream)
            continue
        if _cli_stream_is_pipe(stream):
            redirect_broken_cli_pipe_stream_to_devnull(stream)


def _cli_stream_is_pipe(stream: TextIO) -> bool:
    """Return True when a CLI stream still points at a FIFO / pipe."""

    fileno = getattr(stream, "fileno", None)
    if fileno is None:
        return False
    try:
        return stat.S_ISFIFO(os.fstat(fileno()).st_mode)
    except (OSError, ValueError):
        return False


class _CliHelpFormatter(
    argparse.ArgumentDefaultsHelpFormatter,
    argparse.RawDescriptionHelpFormatter,
):
    def _get_help_string(self, action: argparse.Action) -> str:
        if action.help is not None and action.default in (None, "", argparse.SUPPRESS):
            return action.help
        return super()._get_help_string(action)


class BrainstormCliUsageError(ValueError):
    """Raised for a CLI value combination that argparse cannot validate alone."""


class BrainstormCliRuntimeError(RuntimeError):
    """Raised for an expected operational failure in a CLI command."""


@dataclass(frozen=True)
class BrainstormRunOptions:
    """Validated session and output options for one non-interactive CLI run."""

    session_config: SessionCreate
    output_format: Literal["json", "md"]
    output_path: str
    timeout_seconds: float


@dataclass(frozen=True)
class SessionExportOptions:
    """Validated lookup and output options for one persisted session export."""

    session_id: str
    output_format: Literal["json", "md"]
    output_path: str


def create_cli_argument_parser() -> argparse.ArgumentParser:
    """Create the stable ``izayoi`` command line argument contract.

    ``--version`` / ``-V`` are top-level only and print the distribution version.
    """

    parser = argparse.ArgumentParser(
        prog="izayoi",
        description=(
            "Run MBTI-persona brainstorms and export persisted sessions without "
            "starting the Web server."
        ),
        formatter_class=_CliHelpFormatter,
        epilog=(
            "version:\n"
            "  izayoi --version\n"
            "  izayoi -V\n"
            "  Version flags are top-level only; izayoi run --version is not accepted.\n\n"
            "examples:\n"
            "  izayoi run --theme \"Improve onboarding\"\n"
            "  izayoi export SESSION_ID\n"
            "  printf 'Improve onboarding' | izayoi run --theme - --format md\n\n"
            "defaults:\n"
            "  run: 4 balanced personas, 3 ideas per agent, 2 discussion rounds,\n"
            "       judge on, mock provider/model, 900s run timeout (0 disables),\n"
            "       JSON to stdout\n"
            "  export: JSON to stdout; database from IZAYOI_DB_PATH (default: izayoi.db)\n\n"
            "streams and exit status:\n"
            "  --output - writes only result data to stdout. Run progress and all errors\n"
            "  go to stderr; a successful export to a file is quiet. Exit status is 0\n"
            "  on success, 1 on runtime failure (including a run timeout), 2 on invalid\n"
            "  usage (unknown provider or model, or a cloud provider whose required API\n"
            "  key environment variable is unset), 130 on SIGINT, and 143 after graceful\n"
            "  SIGTERM cleanup. A closed stdout pipe during a result write is a runtime\n"
            "  failure (exit 1). A closed stderr progress pipe stops progress printing\n"
            "  and lets the run finish; it does not install SIGPIPE SIG_DFL or exit 120.\n\n"
            "provider keys:\n"
            "  Cloud providers need a process environment key before izayoi run creates a\n"
            "  session, lock, or provider call. Missing keys exit 2 with one stderr line\n"
            "  such as provider 'openai' requires OPENAI_API_KEY.\n"
            f"{_format_cli_provider_key_requirement_help()}\n"
            "  Mock needs no key and starts immediately. Runtime provider authentication\n"
            "  failures stay a session error and exit 1."
        ),
    )
    parser.add_argument(
        "-V",
        "--version",
        action=PrintIzayoiCliVersionAction,
        help=(
            "print the izayoi version and exit (top-level only; "
            "not accepted after run or export)"
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    run_parser = subparsers.add_parser(
        "run",
        help="create, start, wait for, and print one brainstorming session",
        description="Create, start, wait for, and print one brainstorming session.",
        formatter_class=_CliHelpFormatter,
        epilog=(
            "examples:\n"
            "  izayoi run --theme \"Improve onboarding\"\n"
            "  printf 'Improve onboarding' | izayoi run --theme -\n"
            "  izayoi run --theme \"Improve onboarding\" --format md --output session.md\n\n"
            "defaults:\n"
            "  4 balanced personas, 3 ideas per agent, 2 discussion rounds, judge on,\n"
            "  mock provider/model, 900s run timeout (0 disables), and JSON written\n"
            "  to stdout.\n\n"
            "streams:\n"
            "  --output - writes only the JSON or Markdown result to stdout. Progress and\n"
            "  errors go to stderr; no interactive prompts are used.\n\n"
            "provider keys:\n"
            "  Cloud providers need a process environment key before izayoi run creates a\n"
            "  session, lock, or provider call. Missing keys, unknown providers, and\n"
            "  unknown models exit 2 with one stderr line such as\n"
            "  provider 'openai' requires OPENAI_API_KEY.\n"
            f"{_format_cli_provider_key_requirement_help()}\n"
            "  Mock needs no key and starts immediately. Runtime provider authentication\n"
            "  failures stay a session error and exit 1.\n\n"
            "version:\n"
            "  Use izayoi --version or izayoi -V. Version flags are top-level only;\n"
            "  izayoi run --version is not accepted."
        ),
    )
    run_parser.add_argument(
        "--theme",
        required=True,
        metavar="TEXT|-",
        help="brainstorming theme, or '-' to read the complete theme from non-TTY stdin",
    )
    run_parser.add_argument(
        "--constraints",
        default="",
        metavar="TEXT",
        help="constraints applied to framing and idea generation (default: none)",
    )

    persona_group = run_parser.add_mutually_exclusive_group()
    persona_group.add_argument(
        "--persona",
        "--personas",
        dest="persona_groups",
        action="append",
        nargs="+",
        metavar="TYPE",
        help="explicit persona IDs (2-16); repeat the option or list multiple IDs",
    )
    persona_group.add_argument(
        "--balanced",
        type=_bounded_integer("--balanced", 4, 6),
        metavar="COUNT",
        help="select 4-6 personas with the existing balanced selector (default: 4)",
    )
    run_parser.add_argument(
        "--ideas-per-agent",
        type=_bounded_integer("--ideas-per-agent", 1, 10),
        default=3,
        metavar="COUNT",
        help="independent ideas requested from each persona",
    )
    run_parser.add_argument(
        "--discussion-rounds",
        type=_bounded_integer("--discussion-rounds", 0, 3),
        default=2,
        metavar="COUNT",
        help="anonymous discussion rounds; 0 skips discussion",
    )

    judge_group = run_parser.add_mutually_exclusive_group()
    judge_group.add_argument(
        "--judge",
        nargs="?",
        choices=("on", "off"),
        const="on",
        default="on",
        metavar="on|off",
        help="turn convergence scoring on or off",
    )
    judge_group.add_argument(
        "--no-judge",
        dest="judge",
        action="store_const",
        const="off",
        help="alias for --judge off",
    )
    run_parser.add_argument(
        "--provider",
        default="mock",
        metavar="ID",
        help=(
            "provider ID from the existing provider registry; "
            "cloud IDs require their API key environment variable"
        ),
    )
    run_parser.add_argument(
        "--model",
        metavar="ID",
        help="registered provider model (default: the provider's first listed model)",
    )
    run_parser.add_argument(
        "--format",
        choices=("json", "md"),
        default="json",
        metavar="json|md",
        help="result serialization",
    )
    run_parser.add_argument(
        "--output",
        default="-",
        metavar="PATH|-",
        help="result destination; '-' writes to stdout",
    )
    run_parser.add_argument(
        "--timeout",
        type=_parse_cli_run_timeout_seconds,
        default=CLI_RUN_DEFAULT_TIMEOUT_SECONDS,
        metavar="SECONDS",
        help="fail the run after this many seconds; 0 disables the limit",
    )

    export_parser = subparsers.add_parser(
        "export",
        help="render one persisted session from the configured database",
        description="Render one persisted session with the shared Web export format.",
        formatter_class=_CliHelpFormatter,
        epilog=(
            "examples:\n"
            "  izayoi export SESSION_ID\n"
            "  izayoi export SESSION_ID --format md --output session.md\n\n"
            "defaults:\n"
            "  JSON to stdout; database from IZAYOI_DB_PATH (default: izayoi.db).\n\n"
            "streams and exit status:\n"
            "  --output - writes only export data to stdout. A successful file export is\n"
            "  quiet; errors go to stderr. Missing sessions and write failures exit 1;\n"
            "  malformed session IDs and other invalid usage exit 2. A closed stdout\n"
            "  pipe during the result write is a write failure (exit 1), not CPython\n"
            "  exit 120.\n\n"
            "running sessions:\n"
            "  A live-phase status (framing, divergence, discussion, or convergence) is\n"
            "  not written as a finished transcript. Export then prints one stderr line\n"
            "  such as session '<id>' is still running (status=framing), exits 1, and\n"
            "  leaves stdout empty. Terminal done and error sessions export the complete\n"
            "  payload. An unknown status is also refused with exit 1. Export does not\n"
            "  take the run lock or change session, idea, or message rows.\n\n"
            "version:\n"
            "  Use izayoi --version or izayoi -V. Version flags are top-level only;\n"
            "  izayoi export --version is not accepted."
        ),
    )
    export_parser.add_argument(
        "session_id",
        metavar="SESSION_ID",
        help="12-character lowercase hexadecimal session ID",
    )
    export_parser.add_argument(
        "--format",
        choices=("json", "md"),
        default="json",
        metavar="json|md",
        help="export serialization",
    )
    export_parser.add_argument(
        "--output",
        default="-",
        metavar="PATH|-",
        help="export destination; '-' writes to stdout",
    )
    return parser


def build_brainstorm_run_options(
    arguments: argparse.Namespace,
    input_stream: TextIO,
) -> BrainstormRunOptions:
    """Validate CLI values and translate them to the existing SessionCreate model."""

    theme = _read_brainstorm_theme(arguments.theme, input_stream)

    provider_id, model_id = _resolve_provider_model(arguments.provider, arguments.model)
    persona_types = _resolve_persona_types(arguments.persona_groups, arguments.balanced)
    agents = [
        AgentConfig(
            persona_type=persona_type,
            provider=provider_id,
            model=model_id,
            role="participant",
        )
        for persona_type in persona_types
    ]
    try:
        session_config = SessionCreate(
            theme=theme,
            constraints=arguments.constraints,
            ideas_per_agent=arguments.ideas_per_agent,
            discussion_rounds=arguments.discussion_rounds,
            agents=agents,
            facilitator=FacilitatorConfig(provider=provider_id, model=model_id),
            enable_judge=arguments.judge == "on",
        )
    except ValidationError as exc:
        raise _session_create_cli_usage_error(exc) from exc

    return BrainstormRunOptions(
        session_config=session_config,
        output_format=arguments.format,
        output_path=arguments.output,
        timeout_seconds=float(arguments.timeout),
    )


def build_session_export_options(arguments: argparse.Namespace) -> SessionExportOptions:
    """Validate a persisted session ID and its requested export destination."""

    if _SESSION_ID_PATTERN.fullmatch(arguments.session_id) is None:
        raise BrainstormCliUsageError(
            "invalid session ID; expected 12 lowercase hexadecimal characters"
        )
    return SessionExportOptions(
        session_id=arguments.session_id,
        output_format=arguments.format,
        output_path=arguments.output,
    )


def format_cli_run_timeout_reason(timeout_seconds: float) -> str:
    """Build the ``Timed out after`` phase progress for a CLI run timeout."""

    seconds = float(timeout_seconds)
    display = str(int(seconds)) if seconds.is_integer() else str(seconds)
    return f"Timed out after {display}s"


async def wait_for_cli_session_completion(
    session_id: str,
    timeout_seconds: float,
) -> None:
    """Wait for one CLI session, cancelling the runner if the run timeout fires.

    ``timeout_seconds`` is wall-clock seconds for the wait path after create/start.
    ``0`` disables the limit and waits indefinitely. A fired timeout must cancel
    the runner explicitly: ``wait_for_session_completion`` only shields the task,
    so a timeout CancelledError would otherwise leave the runner running.
    SIGINT and SIGTERM still take priority if they cancel this wait first.
    """

    if timeout_seconds <= 0:
        await orchestrator.wait_for_session_completion(session_id)
        return

    try:
        async with asyncio.timeout(timeout_seconds):
            await orchestrator.wait_for_session_completion(session_id)
    except TimeoutError:
        current_task = asyncio.current_task()
        if current_task is not None and current_task.cancelling():
            raise asyncio.CancelledError from None
        await orchestrator.cancel_and_wait_for_session_completion(
            session_id,
            format_cli_run_timeout_reason(timeout_seconds),
        )


async def execute_brainstorm_session(
    session_config: SessionCreate,
    report_progress: Callable[[str], None],
    *,
    timeout_seconds: float = CLI_RUN_DEFAULT_TIMEOUT_SECONDS,
) -> SessionExportPayload:
    """Run one CLI session with scoped SIGTERM cancellation, timeout, and cleanup."""

    session_id: str | None = None
    with CliSigtermCancellation.for_current_cli_run() as sigterm_cancellation:
        try:
            db.init_db()
            if orchestrator.is_any_session_running():
                # Fast same-process UX check only; create_and_start_session repeats the
                # cross-process lock acquisition before its atomic create-and-claim.
                raise BrainstormCliRuntimeError("another session is already running")
            try:
                session = await orchestrator.create_and_start_session(session_config)
            except orchestrator.SessionAlreadyRunningError as exc:
                raise BrainstormCliRuntimeError(str(exc)) from exc
            except Exception as exc:
                message = _single_line_error_message(exc)
                raise BrainstormCliRuntimeError(
                    f"could not create and start session: {message}"
                ) from exc

            session_id = session.id
            report_progress(f"created session {session.id}")
            report_progress(f"started session {session.id}; waiting for completion")
            try:
                await wait_for_cli_session_completion(session.id, timeout_seconds)
            except Exception as exc:
                message = _single_line_error_message(exc)
                current_session = db.get_session(session.id)
                if current_session and current_session.status not in ("done", "error"):
                    db.update_session_status(
                        session.id,
                        "error",
                        f"Session wait failed: {message}"[:500],
                    )
                raise BrainstormCliRuntimeError(
                    f"session {session.id} could not finish: {message}"
                ) from exc

            completed_session = db.get_session(session.id)
            if completed_session is None:
                raise BrainstormCliRuntimeError(
                    f"session {session.id} disappeared from the database"
                )
            if completed_session.status == "error":
                detail = (
                    completed_session.phase_progress
                    or "orchestrator reported an unspecified error"
                )
                raise BrainstormCliRuntimeError(
                    f"session {session.id} failed: {detail}"
                )
            if completed_session.status != "done":
                raise BrainstormCliRuntimeError(
                    f"session {session.id} stopped with unexpected status "
                    f"'{completed_session.status}'"
                )

            ideas = db.list_ideas(session.id)
            if not ideas:
                raise BrainstormCliRuntimeError(
                    f"session {session.id} completed without any ideas"
                )
            messages = db.list_messages(session.id)
            report_progress(f"completed session {session.id} with {len(ideas)} ideas")
            return build_session_export_payload(completed_session, ideas, messages)
        except asyncio.CancelledError:
            cancellation_reason = sigterm_cancellation.reason or "Interrupted by user"
            if session_id is not None:
                await orchestrator.cancel_and_wait_for_session_completion(
                    session_id,
                    cancellation_reason,
                )
            if sigterm_cancellation.reason == CLI_SIGTERM_REASON:
                raise CliSigtermReceived(CLI_SIGTERM_REASON) from None
            raise


def require_existing_export_database(database_path: str) -> None:
    """Refuse export when the selected database file does not exist.

    ``izayoi export`` must not create a missing ``IZAYOI_DB_PATH``. A directory
    or already-present unreadable file is left for ``init_db()`` so those
    rejections stay unchanged.
    """

    try:
        Path(database_path).stat()
    except FileNotFoundError:
        raise BrainstormCliRuntimeError(
            f"database '{database_path}' does not exist"
        ) from None


def load_persisted_session_export(session_id: str) -> SessionExportPayload:
    """Load one finished session export from the database selected by ``IZAYOI_DB_PATH``.

    Schema initialization runs only after the selected path already exists, so a
    missing database cannot become an empty SQLite file or a false not-found.
    A live-phase or unknown status is refused before ideas or messages are read.
    """

    require_existing_export_database(db.db_path())
    db.init_db()
    session_status = db.get_persisted_session_status(session_id)
    if session_status is None:
        raise BrainstormCliRuntimeError(f"session '{session_id}' not found")
    refusal_message = unexportable_session_status_message(session_id, session_status)
    if refusal_message is not None:
        raise BrainstormCliRuntimeError(refusal_message)
    session = db.get_session(session_id)
    if session is None:
        raise BrainstormCliRuntimeError(f"session '{session_id}' not found")
    return build_session_export_payload(
        session,
        db.list_ideas(session_id),
        db.list_messages(session_id),
    )


def render_session_export_output(
    payload: SessionExportPayload,
    output_format: Literal["json", "md"],
) -> str:
    """Render one CLI result with the shared Web JSON or Markdown renderer."""

    if output_format == "json":
        return serialize_session_export_json(payload)
    return render_session_export_markdown(payload)


def write_session_export_output(
    rendered_output: str,
    output_path: str,
    output_stream: TextIO,
) -> None:
    """Write exactly one result to stdout or one UTF-8 file, always newline-terminated."""

    newline_terminated_output = (
        rendered_output if rendered_output.endswith("\n") else f"{rendered_output}\n"
    )
    if output_path != "-":
        write_cli_output_atomically(newline_terminated_output, output_path)
        return

    try:
        output_stream.write(newline_terminated_output)
        output_stream.flush()
    except (OSError, UnicodeError) as exc:
        if is_broken_cli_pipe_error(exc):
            redirect_broken_cli_pipe_stream_to_devnull(output_stream)
        raise BrainstormCliRuntimeError(f"could not write result to stdout: {exc}") from exc


def run_brainstorm_command(
    arguments: argparse.Namespace,
    input_stream: TextIO,
    output_stream: TextIO,
    error_stream: TextIO,
) -> int:
    """Execute the parsed ``izayoi run`` command and return its process exit code."""

    # This side-effect-free guard must run before provider resolution, session
    # creation, or run-lock acquisition so an unsafe destination has no phantom run.
    validate_cli_output_destination(arguments.output, db.db_path())
    options = build_brainstorm_run_options(arguments, input_stream)

    def report_progress(message: str) -> None:
        # A closed progress pipe must stop printing and let the run finish.
        # Raising here would abort after create/start and look like a crash.
        try:
            print(f"izayoi: {message}", file=error_stream, flush=True)
        except OSError as exc:
            if not is_broken_cli_pipe_error(exc):
                raise
            redirect_broken_cli_pipe_stream_to_devnull(error_stream)

    # Keep third-party provider diagnostics out of the machine-readable stdout
    # contract even if a provider writes directly to ``sys.stdout``.
    with redirect_stdout(error_stream):
        payload = asyncio.run(
            execute_brainstorm_session(
                options.session_config,
                report_progress,
                timeout_seconds=options.timeout_seconds,
            )
        )
    rendered_output = render_session_export_output(payload, options.output_format)
    write_session_export_output(rendered_output, options.output_path, output_stream)
    if options.output_path != "-":
        report_progress(f"wrote results to {Path(options.output_path).expanduser()}")
    return EXIT_SUCCESS


def run_session_export_command(
    arguments: argparse.Namespace,
    output_stream: TextIO,
) -> int:
    """Execute ``izayoi export`` for a terminal session without file diagnostics.

    Live-phase and unknown statuses fail before a finished transcript is written.
    This command does not acquire the session run lock.
    """

    options = build_session_export_options(arguments)
    validate_cli_output_destination(options.output_path, db.db_path())
    payload = load_persisted_session_export(options.session_id)
    rendered_output = render_session_export_output(payload, options.output_format)
    write_session_export_output(rendered_output, options.output_path, output_stream)
    return EXIT_SUCCESS


def main(
    argv: Sequence[str] | None = None,
    *,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    """Run the CLI without exposing tracebacks for user or operational errors."""

    input_stream = stdin or sys.stdin
    output_stream = stdout or sys.stdout
    error_stream = stderr or sys.stderr
    exit_code = EXIT_RUNTIME_ERROR
    try:
        parser = create_cli_argument_parser()
        arguments = parser.parse_args(argv)
        try:
            if arguments.command == "run":
                exit_code = run_brainstorm_command(
                    arguments,
                    input_stream,
                    output_stream,
                    error_stream,
                )
            elif arguments.command == "export":
                exit_code = run_session_export_command(arguments, output_stream)
            else:
                raise BrainstormCliUsageError(f"unknown command: {arguments.command}")
        except BrainstormCliUsageError as exc:
            _print_cli_error(error_stream, exc)
            exit_code = EXIT_USAGE_ERROR
        except CliSigtermReceived as exc:
            _print_cli_error(error_stream, exc)
            exit_code = EXIT_SIGTERM
        except KeyboardInterrupt:
            _print_cli_error(error_stream, "interrupted")
            exit_code = EXIT_INTERRUPTED
        except (BrainstormCliRuntimeError, CliOutputSafetyError, CliOutputWriteError) as exc:
            _print_cli_error(error_stream, exc)
            exit_code = EXIT_RUNTIME_ERROR
        except BrokenPipeError:
            redirect_broken_cli_pipe_stream_to_devnull(output_stream)
            redirect_broken_cli_pipe_stream_to_devnull(error_stream)
            exit_code = EXIT_RUNTIME_ERROR
        except Exception as exc:
            if is_broken_cli_pipe_error(exc):
                redirect_broken_cli_pipe_stream_to_devnull(output_stream)
                redirect_broken_cli_pipe_stream_to_devnull(error_stream)
            else:
                _print_cli_error(error_stream, _single_line_error_message(exc))
            exit_code = EXIT_RUNTIME_ERROR
    except BrokenPipeError:
        redirect_broken_cli_pipe_stream_to_devnull(output_stream)
        redirect_broken_cli_pipe_stream_to_devnull(error_stream)
        exit_code = EXIT_RUNTIME_ERROR
    except OSError as exc:
        if not is_broken_cli_pipe_error(exc):
            raise
        redirect_broken_cli_pipe_stream_to_devnull(output_stream)
        redirect_broken_cli_pipe_stream_to_devnull(error_stream)
        exit_code = EXIT_RUNTIME_ERROR
    finally:
        redirect_cli_stdio_pipes_before_cpython_shutdown(output_stream, error_stream)
    return exit_code


def _parse_cli_run_timeout_seconds(value: str) -> float:
    """Parse ``--timeout`` as wall-clock seconds; ``0`` disables the limit."""

    try:
        parsed = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--timeout must be a number of seconds") from exc
    if parsed < 0 or not math.isfinite(parsed):
        raise argparse.ArgumentTypeError(
            "--timeout must be 0 or a positive finite number of seconds"
        )
    return parsed


def _bounded_integer(option_name: str, minimum: int, maximum: int) -> Callable[[str], int]:
    def parse_bounded_integer(value: str) -> int:
        try:
            parsed = int(value)
        except ValueError as exc:
            raise argparse.ArgumentTypeError(f"{option_name} must be an integer") from exc
        if not minimum <= parsed <= maximum:
            raise argparse.ArgumentTypeError(
                f"{option_name} must be between {minimum} and {maximum}"
            )
        return parsed

    return parse_bounded_integer


def _read_brainstorm_theme(theme_argument: str, input_stream: TextIO) -> str:
    if theme_argument != "-":
        return theme_argument
    if input_stream.isatty():
        raise BrainstormCliUsageError(
            "--theme - requires piped or redirected stdin; no interactive prompt is available"
        )
    try:
        return input_stream.read()
    except (OSError, UnicodeError) as exc:
        raise BrainstormCliUsageError(f"could not read --theme from stdin: {exc}") from exc


def _session_create_cli_usage_error(
    validation_error: ValidationError,
) -> BrainstormCliUsageError:
    """Translate SessionCreate validation details without duplicating its field rules."""

    first_error = validation_error.errors()[0]
    location_parts = tuple(first_error["loc"])
    field_option = {
        ("theme",): "--theme",
        ("constraints",): "--constraints",
    }.get(location_parts)
    error_type = first_error["type"]
    if field_option == "--theme" and error_type == "string_too_short":
        return BrainstormCliUsageError("--theme must not be empty")
    if field_option is not None and error_type == "string_too_long":
        maximum_length = first_error.get("ctx", {}).get("max_length", 2000)
        return BrainstormCliUsageError(
            f"{field_option} must contain at most {maximum_length} characters"
        )

    location = ".".join(str(part) for part in location_parts)
    return BrainstormCliUsageError(
        f"invalid run configuration at {location}: {first_error['msg']}"
    )


def _format_cli_provider_key_requirement_help() -> str:
    """List each cloud provider's required API key environment variable for CLI help."""

    lines: list[str] = []
    for provider in providers.detect_providers():
        required_env_vars = providers.required_provider_env_vars(provider.id)
        if required_env_vars:
            lines.append(
                f"  {provider.id} requires {' or '.join(required_env_vars)}"
            )
    return "\n".join(lines)


def _missing_provider_api_key_usage_error(provider_id: str) -> BrainstormCliUsageError:
    """Usage error when a key-backed provider is specified without its API key environment variable."""

    required_env_vars = providers.required_provider_env_vars(provider_id)
    if not required_env_vars:
        return BrainstormCliUsageError(f"provider '{provider_id}' is not available")
    return BrainstormCliUsageError(
        f"provider '{provider_id}' requires {' or '.join(required_env_vars)}"
    )


def _resolve_provider_model(provider_id: str, model_id: str | None) -> tuple[str, str]:
    provider_index = {provider.id: provider for provider in providers.detect_providers()}
    provider = provider_index.get(provider_id)
    if provider is None:
        choices = ", ".join(sorted(provider_index))
        raise BrainstormCliUsageError(
            f"unknown provider '{provider_id}'; choose one of: {choices}"
        )

    resolved_model = model_id or provider.models[0]
    if resolved_model not in provider.models:
        choices = ", ".join(provider.models)
        raise BrainstormCliUsageError(
            f"unknown model '{resolved_model}' for provider '{provider_id}';"
            f" choose one of: {choices}"
        )
    if not provider.available:
        raise _missing_provider_api_key_usage_error(provider_id)
    return provider_id, resolved_model


def _resolve_persona_types(
    persona_groups: list[list[str]] | None,
    balanced_count: int | None,
) -> list[str]:
    if persona_groups is None:
        return personas.balanced_select(balanced_count or 4)

    persona_types = [
        persona_type.strip().upper()
        for group in persona_groups
        for value in group
        for persona_type in value.split(",")
        if persona_type.strip()
    ]
    if not 2 <= len(persona_types) <= 16:
        raise BrainstormCliUsageError("--persona requires between 2 and 16 persona IDs")
    if len(set(persona_types)) != len(persona_types):
        raise BrainstormCliUsageError("--persona must not contain duplicate persona IDs")

    known_personas = {persona["type"] for persona in personas.load_personas()}
    unknown_personas = [
        persona_type for persona_type in persona_types if persona_type not in known_personas
    ]
    if unknown_personas:
        raise BrainstormCliUsageError(
            f"unknown persona type(s): {', '.join(unknown_personas)};"
            " use MBTI IDs such as INTJ or ENFP"
        )
    return persona_types


def _single_line_error_message(error: object) -> str:
    message = " ".join(str(error).splitlines()).strip()
    return (message or error.__class__.__name__)[:500]


def _print_cli_error(error_stream: TextIO, error: object) -> None:
    try:
        print(
            f"izayoi: error: {_single_line_error_message(error)}",
            file=error_stream,
            flush=True,
        )
    except OSError as exc:
        if not is_broken_cli_pipe_error(exc):
            raise
        redirect_broken_cli_pipe_stream_to_devnull(error_stream)


def _exit_after_uncaught_broken_cli_pipe() -> int:
    """Last-resort BrokenPipe / EPIPE net for ``python -m backend.cli``."""

    redirect_broken_cli_pipe_stream_to_devnull(sys.stdout)
    redirect_broken_cli_pipe_stream_to_devnull(sys.stderr)
    return EXIT_RUNTIME_ERROR


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        raise SystemExit(_exit_after_uncaught_broken_cli_pipe()) from None
    except OSError as exc:
        if not is_broken_cli_pipe_error(exc):
            raise
        raise SystemExit(_exit_after_uncaught_broken_cli_pipe()) from None

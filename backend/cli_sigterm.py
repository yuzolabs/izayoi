"""SIGTERM cancellation scoped to one CLI run event loop."""

from __future__ import annotations

import asyncio
import signal
import threading
from types import FrameType
from typing import Any, Literal

CLI_SIGTERM_REASON = "Terminated by SIGTERM"


class CliSigtermReceived(Exception):
    """Report that one CLI run handled SIGTERM and completed graceful cleanup."""


class CliSigtermCancellation:
    """Install a restorable SIGTERM-to-task bridge for one CLI run.

    The running loop's signal API is preferred on POSIX. Platforms without that
    API fall back to ``signal.signal`` plus ``call_soon_threadsafe``. Python
    cannot install process signal handlers outside the main thread, so that
    case leaves the previous handler untouched and reports ``registered=False``.
    """

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        run_task: asyncio.Task[Any],
    ) -> None:
        self.reason: str | None = None
        self.registered = False
        self.registration_mode: Literal["event-loop", "signal", "unavailable"] = (
            "unavailable"
        )
        self._loop = loop
        self._run_task = run_task
        self._sigterm: signal.Signals | None = None
        self._previous_handler: Any = None

    @classmethod
    def for_current_cli_run(cls) -> CliSigtermCancellation:
        """Create a SIGTERM bridge bound to the current CLI run task and loop."""

        run_task = asyncio.current_task()
        if run_task is None:  # pragma: no cover - requires a broken asyncio runtime
            raise RuntimeError("CLI SIGTERM handler requires a running asyncio task")
        return cls(asyncio.get_running_loop(), run_task)

    def __enter__(self) -> CliSigtermCancellation:
        self._install_sigterm_handler()
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self._restore_previous_sigterm_handler()

    def _install_sigterm_handler(self) -> None:
        if threading.current_thread() is not threading.main_thread():
            return

        sigterm = getattr(signal, "SIGTERM", None)
        if sigterm is None:  # pragma: no cover - Python platforms normally define SIGTERM
            return

        self._sigterm = sigterm
        self._previous_handler = signal.getsignal(sigterm)
        try:
            self._loop.add_signal_handler(sigterm, self._record_sigterm_and_cancel_run)
        except (NotImplementedError, RuntimeError):
            try:
                signal.signal(sigterm, self._handle_sigterm_with_signal_module)
            except (OSError, RuntimeError, ValueError):
                self._sigterm = None
                self._previous_handler = None
                return
            self.registration_mode = "signal"
        else:
            self.registration_mode = "event-loop"
        self.registered = True

    def _handle_sigterm_with_signal_module(
        self,
        signum: int,
        frame: FrameType | None,
    ) -> None:
        del signum, frame
        if self.reason is not None:
            return
        self.reason = CLI_SIGTERM_REASON
        if not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._cancel_run_task)

    def _record_sigterm_and_cancel_run(self) -> None:
        if self.reason is not None:
            return
        self.reason = CLI_SIGTERM_REASON
        self._cancel_run_task()

    def _cancel_run_task(self) -> None:
        if not self._run_task.done():
            self._run_task.cancel()

    def _restore_previous_sigterm_handler(self) -> None:
        if not self.registered or self._sigterm is None:
            return

        if self.registration_mode == "event-loop":
            self._loop.remove_signal_handler(self._sigterm)
        signal.signal(self._sigterm, self._previous_handler)
        self.registered = False

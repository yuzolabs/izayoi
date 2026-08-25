"""Session live-phase and terminal-status classification.

A session live phase is a still-running status. Export and recovery treat
these four values as in progress, and treat only done and error as terminal.
Unknown statuses are neither live nor terminal so callers can refuse them
instead of guessing.
"""

from __future__ import annotations

# Keep these literals whole so a search for a status name lands here.
SESSION_LIVE_PHASES = ("framing", "divergence", "discussion", "convergence")
SESSION_TERMINAL_STATUSES = ("done", "error")


def session_status_is_live_phase(status: str) -> bool:
    """Return True when a session status is a live phase (still running)."""

    return status in SESSION_LIVE_PHASES


def session_status_is_terminal(status: str) -> bool:
    """Return True when a session status is a terminal done or error state."""

    return status in SESSION_TERMINAL_STATUSES


def unexportable_session_status_message(session_id: str, status: str) -> str | None:
    """Return the export refusal for a live-phase or unknown session status.

    Terminal done and error statuses return None so the caller can write the
    complete export payload. The live-phase message keeps the
    ``is still running (status=`` prefix stable for logs and tests.
    """

    if session_status_is_live_phase(status):
        return f"session '{session_id}' is still running (status={status})"
    if not session_status_is_terminal(status):
        return f"session '{session_id}' has unknown status '{status}'"
    return None

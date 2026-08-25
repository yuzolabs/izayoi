"""Unit tests for session live-phase and terminal-status classification."""

from __future__ import annotations

from backend.session_live_phase import (
    SESSION_LIVE_PHASES,
    SESSION_TERMINAL_STATUSES,
    session_status_is_live_phase,
    session_status_is_terminal,
    unexportable_session_status_message,
)


def test_session_status_is_live_phase_matches_still_running_statuses():
    for status in SESSION_LIVE_PHASES:
        assert session_status_is_live_phase(status)
        assert not session_status_is_terminal(status)


def test_session_status_is_terminal_matches_done_and_error():
    for status in SESSION_TERMINAL_STATUSES:
        assert session_status_is_terminal(status)
        assert not session_status_is_live_phase(status)


def test_unknown_session_status_is_neither_live_nor_terminal():
    assert not session_status_is_live_phase("paused-by-future-version")
    assert not session_status_is_terminal("paused-by-future-version")


def test_unexportable_session_status_message_covers_live_and_unknown():
    assert (
        unexportable_session_status_message("abcabcabcabc", "framing")
        == "session 'abcabcabcabc' is still running (status=framing)"
    )
    assert (
        unexportable_session_status_message("abcabcabcabc", "paused-by-future-version")
        == "session 'abcabcabcabc' has unknown status 'paused-by-future-version'"
    )
    assert unexportable_session_status_message("abcabcabcabc", "done") is None
    assert unexportable_session_status_message("abcabcabcabc", "error") is None

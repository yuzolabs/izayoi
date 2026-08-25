"""Shared JSON and Markdown representation for persisted brainstorming sessions."""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any, TypedDict

from .models import Idea, Session


class SessionExportPayload(TypedDict):
    """Stable Web and CLI export object with session, ideas, and messages keys."""

    session: dict[str, Any]
    ideas: list[dict[str, Any]]
    messages: list[dict[str, Any]]


def build_session_export_payload(
    session: Session,
    ideas: Sequence[Idea],
    messages: Sequence[dict[str, Any]],
) -> SessionExportPayload:
    """Build the single persisted-session export object shared by Web and CLI."""

    return {
        "session": session.model_dump(mode="json"),
        "ideas": [idea.model_dump(mode="json") for idea in ideas],
        "messages": [dict(message) for message in messages],
    }


def serialize_session_export_json(payload: SessionExportPayload) -> str:
    """Serialize a session export as deterministic, UTF-8-friendly JSON."""

    return json.dumps(payload, ensure_ascii=False, indent=2)


def _longest_markdown_backtick_run(text: str) -> int:
    """Return the longest consecutive backtick run so a closing fence can outrun it."""

    longest_run = 0
    current_run = 0
    for character in text:
        if character == "`":
            current_run += 1
            if current_run > longest_run:
                longest_run = current_run
        else:
            current_run = 0
    return longest_run


def _fence_user_markdown(text: str) -> str:
    """Fence user Markdown in a closed code fence that cannot steal export headings.

    Normalize CR LF and bare CR to LF first. Wrap the body in a backtick fence
    one longer than the longest backtick run in the text, using at least three
    backticks. Empty text is left unfenced because it is already structurally
    safe and must not invent a fence block.
    """

    if text == "":
        return ""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    fence = "`" * max(3, _longest_markdown_backtick_run(normalized) + 1)
    return f"{fence}\n{normalized}\n{fence}"


def _append_fenced_user_markdown_block(lines: list[str], text: str | None) -> None:
    """Append one independent fenced user Markdown block, or nothing if empty."""

    if text is None or text == "":
        return
    fenced = _fence_user_markdown(text)
    if fenced == "":
        return
    if lines and lines[-1] != "":
        lines.append("")
    lines.append(fenced)
    lines.append("")


def _session_export_idea_score_text(scores: dict[str, Any] | None) -> str:
    """Format idea novelty, feasibility, and clarity scores for the summary line."""

    if not scores:
        return "not scored"
    return (
        f"N{scores['novelty']} / F{scores['feasibility']} / C{scores['clarity']}"
        f" (total {scores['total']})"
    )


def render_session_export_markdown(payload: SessionExportPayload) -> str:
    """Render the shared session export as the Web and CLI Markdown format.

    Official headings stay renderer-owned. Every user string is an independent
    fenced Markdown block so theme, constraints, framing, idea content,
    synthesized text, notes, and discussion messages cannot inject headings.
    """

    session = payload["session"]
    ideas = payload["ideas"]
    messages = payload["messages"]
    lines: list[str] = [
        f"# izayoi brainstorming session {session['id']}",
        "",
        "- **Theme:**",
    ]
    _append_fenced_user_markdown_block(lines, session["theme"])
    constraints = session.get("constraints") or ""
    if constraints:
        lines.append("- **Constraints:**")
        _append_fenced_user_markdown_block(lines, constraints)
    else:
        lines.append("- **Constraints:** (none)")
    lines += [
        f"- **Status:** {session['status']}",
        f"- **Created:** {session['created_at']}",
        "",
    ]
    metrics = session.get("metrics")
    if metrics:
        lines += [
            "## Metrics",
            "",
            f"- Total ideas: {metrics['total_ideas']}",
            f"- Unique ideas: {metrics['unique_ideas']}",
            f"- Non-duplicate ratio: {metrics['non_duplicate_ratio']}",
            f"- Semantic dispersion: {metrics['semantic_dispersion']}",
            f"- Collapse alert: {metrics['collapse_alert']}",
            "",
        ]
    framing = [message for message in messages if message["round"] == 0]
    if framing:
        lines += ["## Framing", ""]
        _append_fenced_user_markdown_block(lines, framing[0].get("content") or "")

    lines += ["## Ideas", ""]
    clusters: dict[Any, list[dict[str, Any]]] = {}
    for idea in ideas:
        clusters.setdefault(idea.get("cluster_id"), []).append(idea)
    for cluster_id, members in sorted(
        clusters.items(), key=lambda item: (item[0] is None, item[0])
    ):
        title = f"Cluster {cluster_id}" if cluster_id is not None else "Unclustered"
        lines += [f"### {title}", ""]
        for member in members:
            if member.get("synthesized"):
                lines += ["**Synthesized:**", ""]
                _append_fenced_user_markdown_block(lines, member["synthesized"])
            score_text = _session_export_idea_score_text(member.get("scores"))
            lines.append(
                f"- [{member['decision']}] ({member['persona_type']}, {member['phase']})"
                f" — *{score_text}*"
            )
            _append_fenced_user_markdown_block(lines, member.get("content") or "")
            note = member.get("note") or ""
            if note:
                lines.append("- Note:")
                _append_fenced_user_markdown_block(lines, note)
        if lines and lines[-1] != "":
            lines.append("")

    discussion = [message for message in messages if message["round"] >= 1]
    if discussion:
        lines += ["## Discussion log", ""]
        for message in discussion:
            lines.append(
                f"- **Round {message['round']} — {message['anon_name']}:**"
            )
            _append_fenced_user_markdown_block(lines, message.get("content") or "")
        lines.append("")
    return "\n".join(lines)

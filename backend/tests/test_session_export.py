"""Session export Markdown structure, JSON fidelity, and CLI/Web byte identity."""

from __future__ import annotations

import io
import json

import pytest
from fastapi.testclient import TestClient
from markdown_it import MarkdownIt
from markdown_it.token import Token

from backend import cli, db, main, providers
from backend.models import (
    AgentConfig,
    FacilitatorConfig,
    Idea,
    IdeaScores,
    Session,
    SessionCreate,
    SessionMetrics,
)
from backend.session_export import (
    _fence_user_markdown,
    build_session_export_payload,
    render_session_export_markdown,
    serialize_session_export_json,
)

FAKE_THEME_HEADING = "# Fake Heading\n\n---\n\n## Another"
UNCLOSED_IDEA_CODE_FENCE = "before\n```\nstill open"
STOLEN_NOTE_HEADING = "### Stolen Note Heading"
DISCUSSION_HIJACK_HEADING = "### Discussion Hijack"
ZWSP_VT_CRLF_TEXT = "zero\u200bwidth\u000bvt\r\nand more"
STRUCTURAL_2000 = ("# H\n---\n## X\n```\n" * 200)[:2000]
OFFICIAL_HOSTILE_HEADINGS = [
    ("h1", "izayoi brainstorming session sess-export"),
    ("h2", "Metrics"),
    ("h2", "Framing"),
    ("h2", "Ideas"),
    ("h3", "Cluster 1"),
    ("h2", "Discussion log"),
]
SESSION_EXPORT_HEADING_OPEN_TYPE = "heading_open"
SESSION_EXPORT_HEADING_TAGS = frozenset({"h1", "h2", "h3", "h4", "h5", "h6"})
SESSION_EXPORT_HEADING_TEXT_TOKEN_TYPES = frozenset({"text", "code_inline"})


def _is_session_export_heading_open_token(token: Token) -> bool:
    """True when a token opens a heading (markdown-it heading_open plus h1-h6 tag)."""

    if token.type == SESSION_EXPORT_HEADING_OPEN_TYPE:
        return True
    return token.nesting == 1 and token.tag in SESSION_EXPORT_HEADING_TAGS


def _session_export_heading_inline_text(inline: Token | None) -> str:
    """Join text and code_inline children of the heading's following inline token."""

    children = [] if inline is None else (inline.children or [])
    return "".join(
        child.content
        for child in children
        if child.type in SESSION_EXPORT_HEADING_TEXT_TOKEN_TYPES
    )


def parse_session_export_markdown_with_markdown_it(markdown: str) -> dict[str, object]:
    """Parse session export Markdown with markdown-it-py so fenced user text cannot count."""

    tokens = MarkdownIt().parse(markdown)
    headings: list[dict[str, str]] = []
    fences: list[str] = []
    hrs = 0
    for index, token in enumerate(tokens):
        if _is_session_export_heading_open_token(token):
            inline = tokens[index + 1] if index + 1 < len(tokens) else None
            headings.append(
                {"tag": token.tag, "text": _session_export_heading_inline_text(inline)}
            )
        elif token.type == "fence":
            fences.append(token.content)
        elif token.type == "hr":
            hrs += 1
    return {"headings": headings, "fences": fences, "hrs": hrs}


def _hostile_session_export_payload() -> dict[str, object]:
    """Build one export whose user fields try to steal Markdown headings."""

    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    session = Session(
        id="sess-export",
        theme=FAKE_THEME_HEADING,
        constraints=STRUCTURAL_2000,
        status="done",
        phase_progress="Session completed",
        agents=[agent, agent],
        created_at="2026-01-01T00:00:00+00:00",
        metrics=SessionMetrics(
            total_ideas=1,
            unique_ideas=1,
            non_duplicate_ratio=1.0,
            semantic_dispersion=0.1,
            collapse_alert=False,
        ),
    )
    idea = Idea(
        id="idea-export",
        session_id=session.id,
        persona_type="INTJ",
        phase="divergence",
        content=UNCLOSED_IDEA_CODE_FENCE,
        cluster_id=1,
        synthesized="## Synth Hijack",
        scores=IdeaScores(novelty=5, feasibility=7, clarity=8, total=20),
        decision="adopted",
        note=STOLEN_NOTE_HEADING,
    )
    messages = [
        {
            "id": "message-framing",
            "session_id": session.id,
            "round": 0,
            "anon_name": "Facilitator",
            "persona_type": "FACILITATOR",
            "content": "## Framing Hijack\n```",
            "created_at": "2026-01-01T00:00:01+00:00",
        },
        {
            "id": "message-hijack",
            "session_id": session.id,
            "round": 1,
            "anon_name": "Anon-1",
            "persona_type": "INTJ",
            "content": DISCUSSION_HIJACK_HEADING,
            "created_at": "2026-01-01T00:00:02+00:00",
        },
        {
            "id": "message-zwsp",
            "session_id": session.id,
            "round": 1,
            "anon_name": "Anon-2",
            "persona_type": "ENFP",
            "content": ZWSP_VT_CRLF_TEXT,
            "created_at": "2026-01-01T00:00:03+00:00",
        },
    ]
    return build_session_export_payload(session, [idea], messages)


def _assert_official_export_headings_only(markdown: str) -> dict[str, object]:
    """Require markdown-it headings to be the official export outline only."""

    parsed = parse_session_export_markdown_with_markdown_it(markdown)
    headings = [(item["tag"], item["text"]) for item in parsed["headings"]]
    assert headings == OFFICIAL_HOSTILE_HEADINGS
    assert parsed["hrs"] == 0
    fence_bodies = parsed["fences"]
    assert any(FAKE_THEME_HEADING.replace("\r\n", "\n") in body for body in fence_bodies)
    assert any(
        STRUCTURAL_2000.replace("\r\n", "\n").replace("\r", "\n") in body
        for body in fence_bodies
    )
    assert any(UNCLOSED_IDEA_CODE_FENCE in body for body in fence_bodies)
    assert any(STOLEN_NOTE_HEADING in body for body in fence_bodies)
    assert any(DISCUSSION_HIJACK_HEADING in body for body in fence_bodies)
    assert any(
        ZWSP_VT_CRLF_TEXT.replace("\r\n", "\n").replace("\r", "\n") in body
        for body in fence_bodies
    )
    return parsed


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("", ""),
        ("plain", "```\nplain\n```"),
        ("```", "````\n```\n````"),
        ("````already", "`````\n````already\n`````"),
        ("a\r\nb\rc", "```\na\nb\nc\n```"),
    ],
    ids=(
        "empty-unfenced",
        "minimum-three-backticks",
        "closed-code-fence",
        "longest-run-plus-one",
        "crlf-and-cr-normalized",
    ),
)
def test_fence_user_markdown_normalizes_and_outruns_backticks(text, expected):
    assert _fence_user_markdown(text) == expected


def test_render_session_export_markdown_keeps_official_headings_only():
    payload = _hostile_session_export_payload()
    markdown = render_session_export_markdown(payload)
    _assert_official_export_headings_only(markdown)
    assert (
        "- [adopted] (INTJ, divergence) — *N5 / F7 / C8 (total 20)*" in markdown
    )
    assert f"- **Theme:** {FAKE_THEME_HEADING.splitlines()[0]}" not in markdown
    assert f"- Note: {STOLEN_NOTE_HEADING}" not in markdown


def test_serialize_session_export_json_round_trips_original_user_strings():
    payload = _hostile_session_export_payload()
    serialized = serialize_session_export_json(payload)
    parsed = json.loads(serialized)
    assert parsed == payload
    assert parsed["session"]["theme"] == FAKE_THEME_HEADING
    assert parsed["session"]["constraints"] == STRUCTURAL_2000
    assert parsed["ideas"][0]["content"] == UNCLOSED_IDEA_CODE_FENCE
    assert parsed["ideas"][0]["note"] == STOLEN_NOTE_HEADING
    assert parsed["messages"][1]["content"] == DISCUSSION_HIJACK_HEADING
    assert parsed["messages"][2]["content"] == ZWSP_VT_CRLF_TEXT
    assert "\\u200b" not in serialized
    assert "\u200b" in serialized


@pytest.fixture()
def export_temp_db(tmp_path, monkeypatch):
    """Point shared Web and CLI export at one throwaway database."""

    database_path = tmp_path / "export.db"
    monkeypatch.setenv("IZAYOI_DB_PATH", str(database_path))
    monkeypatch.delenv("EMBEDDING_MODEL", raising=False)

    async def no_cloud_embeddings(texts):
        return None

    monkeypatch.setattr(providers, "embed_texts", no_cloud_embeddings)
    db.init_db()
    return database_path


def _persist_hostile_export_session() -> str:
    """Store a finished hostile session for CLI and Web export comparison."""

    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    session = db.create_session(
        SessionCreate(
            theme=FAKE_THEME_HEADING,
            constraints=STRUCTURAL_2000,
            agents=[agent, agent],
            facilitator=FacilitatorConfig(provider="mock", model="mock"),
        )
    )
    idea = db.insert_idea(session.id, "INTJ", "divergence", UNCLOSED_IDEA_CODE_FENCE)
    db.update_idea_convergence(
        idea.id,
        1,
        "## Synth Hijack",
        IdeaScores(novelty=5, feasibility=7, clarity=8, total=20),
    )
    db.update_idea_decision(idea.id, "adopted", STOLEN_NOTE_HEADING)
    db.insert_message(
        session.id,
        0,
        "Facilitator",
        "FACILITATOR",
        "## Framing Hijack\n```",
    )
    db.insert_message(session.id, 1, "Anon-1", "INTJ", DISCUSSION_HIJACK_HEADING)
    db.insert_message(session.id, 1, "Anon-2", "ENFP", ZWSP_VT_CRLF_TEXT)
    db.update_session_metrics(
        session.id,
        SessionMetrics(
            total_ideas=1,
            unique_ideas=1,
            non_duplicate_ratio=1.0,
            semantic_dispersion=0.1,
            collapse_alert=False,
        ),
    )
    db.update_session_status(session.id, "done", "Session completed")
    return session.id


def test_cli_and_web_markdown_export_are_byte_identical(export_temp_db):
    session_id = _persist_hostile_export_session()
    persisted = db.get_session(session_id)
    assert persisted is not None
    payload = build_session_export_payload(
        persisted,
        db.list_ideas(session_id),
        db.list_messages(session_id),
    )
    rendered_markdown = render_session_export_markdown(payload)
    expected_headings = [
        ("h1", f"izayoi brainstorming session {session_id}"),
        ("h2", "Metrics"),
        ("h2", "Framing"),
        ("h2", "Ideas"),
        ("h3", "Cluster 1"),
        ("h2", "Discussion log"),
    ]

    client = TestClient(main.create_app())
    web_markdown = client.get(
        f"/api/sessions/{session_id}/export",
        params={"format": "md"},
    )
    web_json = client.get(
        f"/api/sessions/{session_id}/export",
        params={"format": "json"},
    )
    client.close()

    cli_stdout = io.StringIO()
    cli_stderr = io.StringIO()
    cli_exit = cli.main(
        ["export", session_id, "--format", "md"],
        stdin=io.StringIO(),
        stdout=cli_stdout,
        stderr=cli_stderr,
    )
    json_stdout = io.StringIO()
    json_exit = cli.main(
        ["export", session_id, "--format", "json"],
        stdin=io.StringIO(),
        stdout=json_stdout,
        stderr=io.StringIO(),
    )

    assert web_markdown.status_code == 200
    assert web_json.status_code == 200
    assert cli_exit == cli.EXIT_SUCCESS
    assert json_exit == cli.EXIT_SUCCESS
    assert cli_stderr.getvalue() == ""
    assert web_markdown.text == rendered_markdown
    assert cli_stdout.getvalue() == rendered_markdown
    assert web_markdown.content == cli_stdout.getvalue().encode("utf-8")
    assert json.loads(web_json.text) == payload
    assert json.loads(json_stdout.getvalue()) == payload
    assert json.loads(web_json.text)["session"]["theme"] == FAKE_THEME_HEADING
    assert json.loads(web_json.text)["messages"][2]["content"] == ZWSP_VT_CRLF_TEXT
    parsed = parse_session_export_markdown_with_markdown_it(web_markdown.text)
    assert [(item["tag"], item["text"]) for item in parsed["headings"]] == expected_headings
    assert parsed["hrs"] == 0
    assert len(STRUCTURAL_2000) == 2000


def test_empty_constraints_and_note_stay_unfenced():
    agent = AgentConfig(persona_type="INTJ", provider="mock", model="mock")
    session = Session(
        id="sess-empty",
        theme="Safe theme",
        constraints="",
        status="done",
        phase_progress="Session completed",
        agents=[agent, agent],
        created_at="2026-01-01T00:00:00+00:00",
    )
    idea = Idea(
        id="idea-empty",
        session_id=session.id,
        persona_type="INTJ",
        phase="divergence",
        content="Plain idea",
        note="",
    )
    payload = build_session_export_payload(session, [idea], [])
    markdown = render_session_export_markdown(payload)
    assert "- **Constraints:** (none)" in markdown
    assert "- Note:" not in markdown
    parsed = parse_session_export_markdown_with_markdown_it(markdown)
    assert [(item["tag"], item["text"]) for item in parsed["headings"]] == [
        ("h1", "izayoi brainstorming session sess-empty"),
        ("h2", "Ideas"),
        ("h3", "Unclustered"),
    ]

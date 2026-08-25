"""Backend test suite (SPEC section 11 in the original plan).

Every test runs on the Mock provider only: no external API calls and no
litellm dependency are required (cloud embedding calls are stubbed out so the
numpy TF-IDF fallback is exercised deterministically).
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import Counter

import pytest
from fastapi.testclient import TestClient

from backend import db, main, personas, providers, session_run_lock
from backend.session_export import _fence_user_markdown
from backend.models import SessionCreate
from backend.personas import REQUIRED_FIELDS

ALL_ENV_KEYS = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "XAI_API_KEY",
    "ZAI_API_KEY",
]


@pytest.fixture()
def temp_db(tmp_path, monkeypatch):
    """Point the DB layer at a throwaway file and keep embeddings offline."""

    monkeypatch.setenv("IZAYOI_DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.delenv("EMBEDDING_MODEL", raising=False)

    async def no_cloud_embeddings(texts):  # deterministic offline vectorization
        return None

    monkeypatch.setattr(providers, "embed_texts", no_cloud_embeddings)
    db.init_db()
    yield tmp_path / "test.db"


# ---------------------------------------------------------------------------
# 1. Provider detection
# ---------------------------------------------------------------------------


def test_mock_provider_always_available(monkeypatch):
    for key in ALL_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    detected = {p.id: p for p in providers.detect_providers()}
    assert detected["mock"].available is True
    assert detected["mock"].env_var is None
    assert detected["mock"].models == ["mock"]
    # No local-inference provider is ever listed (C2).
    assert "ollama" not in detected


def test_cloud_providers_follow_env_vars(monkeypatch):
    for key in ALL_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    detected = {p.id: p for p in providers.detect_providers()}
    for pid in ("openai", "anthropic", "gemini", "xai", "zai"):
        assert detected[pid].available is False, pid

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("GOOGLE_API_KEY", "goog-test")  # alternative gemini key
    detected = {p.id: p for p in providers.detect_providers()}
    assert detected["openai"].available is True
    assert detected["gemini"].available is True
    assert detected["anthropic"].available is False


def test_required_provider_env_vars_follow_registry():
    assert providers.required_provider_env_vars("mock") == ()
    assert providers.required_provider_env_vars("openai") == ("OPENAI_API_KEY",)
    assert providers.required_provider_env_vars("gemini") == (
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
    )
    assert providers.required_provider_env_vars("not-a-provider") == ()


# ---------------------------------------------------------------------------
# 2. Persona JSON completeness
# ---------------------------------------------------------------------------


def test_persona_json_has_16_types_with_11_fields():
    data = personas.load_personas()
    assert len(data) == 16
    types = {p["type"] for p in data}
    assert len(types) == 16  # all distinct
    for entry in data:
        for field in REQUIRED_FIELDS:
            assert entry.get(field), f"{entry['type']} missing {field}"
    assert len(REQUIRED_FIELDS) == 11


# ---------------------------------------------------------------------------
# 3. Balanced selection
# ---------------------------------------------------------------------------


def test_balanced_selection_minimizes_axis_bias():
    for count in (4, 5, 6):
        selected = personas.balanced_select(count)
        assert len(selected) == count
        assert len(set(selected)) == count
        # Per-axis imbalance must be minimal: 0 for even counts, <=1 for odd.
        axis_positions = {"EI": 0, "TF": 2, "JP": 3}
        for axis, pos in axis_positions.items():
            first = sum(1 for t in selected if t[pos] == axis[0])
            imbalance = abs(2 * first - count)
            assert imbalance <= count % 2, (count, axis, selected, imbalance)

    # Even counts achieve a perfectly balanced total score of zero.
    assert personas.balanced_select(4) == ["ENFJ", "ENFP", "INTJ", "INTP"]
    # Invalid sizes are rejected.
    with pytest.raises(ValueError):
        personas.balanced_select(3)


# ---------------------------------------------------------------------------
# 4. End-to-end session over REST (Mock provider)
# ---------------------------------------------------------------------------

E2E_PAYLOAD = {
    "theme": "Improve remote team collaboration",
    "constraints": "Small budget, security-conscious team",
    "ideas_per_agent": 2,
    "discussion_rounds": 2,
    "agents": [
        {"persona_type": "INTJ", "provider": "mock", "model": "mock", "role": "participant"},
        {"persona_type": "ENFP", "provider": "mock", "model": "mock", "role": "participant"},
        {"persona_type": "ISTJ", "provider": "mock", "model": "mock", "role": "devils_advocate"},
    ],
    "facilitator": {"provider": "mock", "model": "mock"},
    "enable_judge": True,
}


def build_session_create_api_payload(**updates: object) -> dict:
    """Copy the valid REST fixture and replace fields for contract tests."""

    payload = dict(E2E_PAYLOAD)
    payload.update(updates)
    return payload


@pytest.mark.parametrize(
    ("field_name", "invalid_value"),
    [
        ("theme", " \u00a0\u2003\u3000 "),
        ("theme", f"\u3000{'t' * 2001}\u00a0"),
        ("constraints", f"\u2003{'c' * 2001}\u3000"),
    ],
    ids=("theme-unicode-blank", "theme-trimmed-2001", "constraints-trimmed-2001"),
)
def test_session_create_api_validation_has_field_location_without_side_effects(
    tmp_path,
    monkeypatch,
    field_name,
    invalid_value,
):
    database_path = tmp_path / "invalid-session-create.db"
    monkeypatch.setenv("IZAYOI_DB_PATH", str(database_path))
    db.init_db()
    lock_directory = session_run_lock.session_run_lock_path(str(database_path)).parent
    assert not lock_directory.exists()

    side_effect_calls = []
    original_load_personas = personas.load_personas
    original_require_available = main._require_available
    original_create_session = db.create_session
    original_provider_complete = providers.complete

    def observe_persona_lookup():
        side_effect_calls.append("persona lookup")
        return original_load_personas()

    def observe_provider_availability(provider_id):
        side_effect_calls.append("provider availability")
        return original_require_available(provider_id)

    def observe_database_create(payload):
        side_effect_calls.append("database create")
        return original_create_session(payload)

    async def observe_provider_call(*args, **kwargs):
        side_effect_calls.append("provider call")
        return await original_provider_complete(*args, **kwargs)

    monkeypatch.setattr(personas, "load_personas", observe_persona_lookup)
    monkeypatch.setattr(main, "_require_available", observe_provider_availability)
    monkeypatch.setattr(db, "create_session", observe_database_create)
    monkeypatch.setattr(providers, "complete", observe_provider_call)

    client = TestClient(main.create_app())
    response = client.post(
        "/api/sessions",
        json=build_session_create_api_payload(**{field_name: invalid_value}),
    )
    client.close()

    assert response.status_code == 422
    assert [error["loc"] for error in response.json()["detail"]] == [
        ["body", field_name]
    ]
    assert side_effect_calls == []
    assert db.list_sessions() == []
    assert not lock_directory.exists()


@pytest.mark.parametrize(
    ("field_name", "raw_value", "stored_value"),
    [
        ("theme", f"\u3000{'t' * 2000}\u00a0", "t" * 2000),
        ("constraints", f"\u2003{'c' * 2000}\u3000", "c" * 2000),
    ],
    ids=("theme-trimmed-2000", "constraints-trimmed-2000"),
)
def test_session_create_api_stores_and_exports_trimmed_2000_character_fields(
    temp_db,
    field_name,
    raw_value,
    stored_value,
):
    client = TestClient(main.create_app())
    created = client.post(
        "/api/sessions",
        json=build_session_create_api_payload(**{field_name: raw_value}),
    )

    assert created.status_code == 201, created.text
    session = created.json()
    assert session[field_name] == stored_value

    exported = client.get(
        f"/api/sessions/{session['id']}/export",
        params={"format": "json"},
    )
    client.close()

    assert exported.status_code == 200
    assert exported.json()["session"][field_name] == stored_value


@pytest.mark.parametrize("constraints", [None, "", " \u00a0\u2003\u3000 "])
def test_session_create_api_persists_null_or_blank_constraints_as_empty_text(
    temp_db,
    constraints,
):
    client = TestClient(main.create_app())
    created = client.post(
        "/api/sessions",
        json=build_session_create_api_payload(constraints=constraints),
    )
    client.close()

    assert created.status_code == 201, created.text
    session = created.json()
    assert session["constraints"] == ""
    assert db.get_session_config(session["id"])["constraints"] is None


def seed_idea_for_decision_note_contract(note: str = "Keep the original note.") -> tuple[str, str]:
    """Insert one session idea used by decision-note PATCH contract tests."""

    session = db.create_session(
        SessionCreate.model_validate(build_session_create_api_payload())
    )
    idea = db.insert_idea(session.id, "INTJ", "divergence", "Seed idea for decision note")
    updated = db.update_idea_decision(idea.id, "held", note)
    assert updated is not None
    return session.id, updated.id


@pytest.mark.parametrize(
    "invalid_note",
    ["n" * 2001, f"\u3000{'n' * 2001}\u00a0"],
    ids=("note-2001", "note-trimmed-2001"),
)
def test_decision_update_api_validation_has_field_location_without_side_effects(
    tmp_path,
    monkeypatch,
    invalid_note,
):
    database_path = tmp_path / "invalid-decision-update.db"
    monkeypatch.setenv("IZAYOI_DB_PATH", str(database_path))
    db.init_db()
    session_id, idea_id = seed_idea_for_decision_note_contract()
    original_idea = db.get_idea(idea_id)
    original_session = db.get_session(session_id)
    assert original_idea is not None
    assert original_session is not None
    lock_directory = session_run_lock.session_run_lock_path(str(database_path)).parent
    assert not lock_directory.exists()

    side_effect_calls = []
    original_update_idea_decision = db.update_idea_decision
    original_provider_complete = providers.complete

    def observe_decision_update(*args, **kwargs):
        side_effect_calls.append("decision update")
        return original_update_idea_decision(*args, **kwargs)

    async def observe_provider_call(*args, **kwargs):
        side_effect_calls.append("provider call")
        return await original_provider_complete(*args, **kwargs)

    monkeypatch.setattr(db, "update_idea_decision", observe_decision_update)
    monkeypatch.setattr(main.db, "update_idea_decision", observe_decision_update)
    monkeypatch.setattr(providers, "complete", observe_provider_call)

    client = TestClient(main.create_app())
    response = client.patch(
        f"/api/ideas/{idea_id}/decision",
        json={"decision": "adopted", "note": invalid_note},
    )
    client.close()

    assert response.status_code == 422
    assert [error["loc"] for error in response.json()["detail"]] == [["body", "note"]]
    assert response.json()["detail"][0]["type"] == "string_too_long"
    assert side_effect_calls == []
    assert db.get_idea(idea_id) == original_idea
    assert db.get_session(session_id) == original_session
    assert [session.id for session in db.list_sessions()] == [session_id]
    assert not lock_directory.exists()


@pytest.mark.parametrize(
    ("raw_note", "stored_note"),
    [
        (f"\u3000{'n' * 2000}\u00a0", "n" * 2000),
        (" \u00a0\u2003\u3000 ", ""),
        ("\u00a0\u3000  Keep this note  \u2003", "Keep this note"),
    ],
    ids=("note-trimmed-2000", "note-unicode-blank-clear", "note-unicode-strip"),
)
def test_decision_update_api_stores_and_exports_normalized_note(
    temp_db,
    raw_note,
    stored_note,
):
    session_id, idea_id = seed_idea_for_decision_note_contract()
    client = TestClient(main.create_app())
    patched = client.patch(
        f"/api/ideas/{idea_id}/decision",
        json={"decision": "adopted", "note": raw_note},
    )

    assert patched.status_code == 200, patched.text
    assert patched.json()["decision"] == "adopted"
    assert patched.json()["note"] == stored_note
    persisted = db.get_idea(idea_id)
    assert persisted is not None
    assert persisted.note == stored_note

    exported_json = client.get(
        f"/api/sessions/{session_id}/export",
        params={"format": "json"},
    )
    exported_markdown = client.get(
        f"/api/sessions/{session_id}/export",
        params={"format": "md"},
    )
    client.close()

    assert exported_json.status_code == 200
    assert exported_markdown.status_code == 200
    exported_idea = next(
        idea for idea in exported_json.json()["ideas"] if idea["id"] == idea_id
    )
    assert exported_idea["note"] == stored_note
    if stored_note:
        assert "- Note:" in exported_markdown.text
        assert _fence_user_markdown(stored_note) in exported_markdown.text
        assert f"- Note: {stored_note}" not in exported_markdown.text
    else:
        assert "- Note:" not in exported_markdown.text


@pytest.mark.parametrize(
    "payload",
    [
        {"decision": "rejected"},
        {"decision": "rejected", "note": None},
    ],
    ids=("note-omitted", "note-null"),
)
def test_decision_update_api_omitted_or_null_note_leaves_existing_note(temp_db, payload):
    session_id, idea_id = seed_idea_for_decision_note_contract()
    client = TestClient(main.create_app())
    patched = client.patch(f"/api/ideas/{idea_id}/decision", json=payload)
    client.close()

    assert patched.status_code == 200, patched.text
    assert patched.json()["decision"] == "rejected"
    assert patched.json()["note"] == "Keep the original note."
    persisted = db.get_idea(idea_id)
    assert persisted is not None
    assert persisted.decision == "rejected"
    assert persisted.note == "Keep the original note."
    assert db.get_session(session_id) is not None


def _wait_until_done(client: TestClient, session_id: str, timeout: float = 90.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        session = client.get(f"/api/sessions/{session_id}").json()
        if session["status"] in ("done", "error"):
            return session
        time.sleep(0.2)
    raise AssertionError("session did not finish in time")


def test_e2e_session_lifecycle(temp_db):
    with TestClient(main.create_app()) as client:
        created = client.post("/api/sessions", json=E2E_PAYLOAD)
        assert created.status_code == 201, created.text
        session_id = created.json()["id"]

        assert client.post(f"/api/sessions/{session_id}/start").status_code == 202
        session = _wait_until_done(client, session_id)
        assert session["status"] == "done", session["phase_progress"]

        ideas = client.get(f"/api/sessions/{session_id}/ideas").json()["ideas"]
        divergence = [i for i in ideas if i["phase"] == "divergence"]
        assert len(divergence) >= 6  # 3 agents x 2 ideas
        for idea in ideas:
            assert idea["scores"] is not None, idea
            assert idea["cluster_id"] is not None, idea
            total = idea["scores"]
            assert total["total"] == total["novelty"] + total["feasibility"] + total["clarity"]

        metrics = session["metrics"]
        assert metrics is not None
        assert metrics["total_ideas"] == len(ideas)
        assert 0.0 < metrics["non_duplicate_ratio"] <= 1.0
        assert metrics["semantic_dispersion"] >= 0.0

        # Human final decision + note.
        target = ideas[0]
        patched = client.patch(
            f"/api/ideas/{target['id']}/decision",
            json={"decision": "adopted", "note": "Ship this first."},
        )
        assert patched.status_code == 200
        assert patched.json()["decision"] == "adopted"
        assert patched.json()["note"] == "Ship this first."

        # Export in both formats.
        md = client.get(f"/api/sessions/{session_id}/export", params={"format": "md"})
        assert md.status_code == 200
        assert "Improve remote team collaboration" in md.text
        assert "Ship this first." in md.text
        js = client.get(f"/api/sessions/{session_id}/export", params={"format": "json"})
        assert js.status_code == 200
        exported = js.json()
        assert exported["session"]["id"] == session_id
        assert len(exported["ideas"]) == len(ideas)

        # History lists the finished session.
        history = client.get("/api/sessions").json()["sessions"]
        assert any(s["id"] == session_id and s["status"] == "done" for s in history)


# ---------------------------------------------------------------------------
# 5. SSE: fan-out to two subscribers + terminal-state consistency (P1/P2)
# ---------------------------------------------------------------------------


def _parse_sse(body: str) -> list[dict]:
    events = []
    for block in body.split("\n\n"):
        for line in block.splitlines():
            if line.startswith("data: "):
                events.append(json.loads(line[len("data: ") :]))
    return events


def test_sse_two_subscribers_and_terminal_consistency(temp_db):
    import httpx

    async def run() -> tuple[list[dict], list[dict], str]:
        app = main.create_app()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://testserver", timeout=httpx.Timeout(None)
        ) as client:
            created = await client.post("/api/sessions", json=E2E_PAYLOAD)
            session_id = created.json()["id"]
            started = await client.post(f"/api/sessions/{session_id}/start")
            assert started.status_code == 202

            async def collect() -> list[dict]:
                async with client.stream(
                    "GET", f"/api/sessions/{session_id}/stream"
                ) as response:
                    body = await response.aread()
                return _parse_sse(body.decode("utf-8"))

            first, second = await asyncio.gather(collect(), collect())
            return first, second, session_id

    first, second, session_id = asyncio.run(run())

    # Both subscribers received the identical event stream (P1).
    assert [json.dumps(e, sort_keys=True) for e in first] == [
        json.dumps(e, sort_keys=True) for e in second
    ]
    assert first, "subscriber received no events"

    # P2: each idea id appears at most twice (creation + convergence update),
    # and the final event state matches the DB.
    idea_events = [e for e in first if e["type"] == "idea"]
    counts = Counter(e["idea"]["id"] for e in idea_events)
    assert counts, "no idea events streamed"
    assert max(counts.values()) <= 2
    final_state = {e["idea"]["id"]: e["idea"] for e in idea_events}
    db_ideas = {i.id: i for i in db.list_ideas(session_id)}
    assert set(final_state) == set(db_ideas)
    for idea_id, idea in final_state.items():
        assert idea["cluster_id"] == db_ideas[idea_id].cluster_id
        assert idea["scores"] == (
            db_ideas[idea_id].scores.model_dump() if db_ideas[idea_id].scores else None
        )

    # The stream ends with the done phase and includes metrics.
    assert first[-1] == {"type": "phase", "phase": "done", "label": "Done"}
    assert any(e["type"] == "metrics" for e in first)


def test_sse_completed_session_replays_from_db(temp_db):
    import httpx

    async def run() -> tuple[str, list[dict]]:
        app = main.create_app()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://testserver", timeout=httpx.Timeout(None)
        ) as client:
            created = await client.post("/api/sessions", json=E2E_PAYLOAD)
            session_id = created.json()["id"]
            await client.post(f"/api/sessions/{session_id}/start")
            async with client.stream("GET", f"/api/sessions/{session_id}/stream") as r:
                await r.aread()  # drain the live stream to completion
            # The session is finished now: reconnecting must replay from the DB.
            async with client.stream("GET", f"/api/sessions/{session_id}/stream") as r:
                body = await r.aread()
            return session_id, _parse_sse(body.decode("utf-8"))

    session_id, events = asyncio.run(run())
    phases = [e.get("phase") for e in events if e["type"] == "phase"]
    assert phases[0] == "framing"
    assert phases[-1] == "done"
    idea_ids = [e["idea"]["id"] for e in events if e["type"] == "idea"]
    assert len(idea_ids) == len(set(idea_ids))  # replay sends final state once
    assert any(e["type"] == "metrics" for e in events)
    assert any(e["type"] == "message" for e in events)
    # Replay matches DB contents.
    assert set(idea_ids) == {i.id for i in db.list_ideas(session_id)}


# ---------------------------------------------------------------------------
# 6. SPA fallback (P3)
# ---------------------------------------------------------------------------


def test_spa_fallback_serves_index_html(temp_db, tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html><body>izayoi spa</body></html>", encoding="utf-8")
    monkeypatch.setenv("IZAYOI_FRONTEND_DIST", str(dist))

    with TestClient(main.create_app()) as client:
        deep = client.get("/session/some-deep-link")
        assert deep.status_code == 200
        assert "izayoi spa" in deep.text
        # API 404s stay honest JSON.
        missing = client.get("/api/sessions/does-not-exist")
        assert missing.status_code == 404
        assert missing.headers["content-type"].startswith("application/json")

"""Four-phase brainstorming orchestration with fan-out SSE (SPEC section 2).

Pitfall P1 countermeasure: each session run keeps an in-memory **history list**
plus a **per-subscriber queue**. Publishing appends to the history and fans out
to every queue; subscribing creates a dedicated queue pre-seeded with the
history under a lock, so no event is ever lost, doubled, or fought over by
concurrent (re)connections. Once the run finishes, the runner is dropped from
the registry and the stream endpoint replays from the DB instead.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any, Optional

from . import db, metrics, providers
from .models import AgentConfig, IdeaScores, SessionCreate
from .personas import persona_system_prompt

PHASE_LABELS = {
    "framing": "Framing",
    "divergence": "Independent Divergence",
    "discussion": "Collaborative Discussion",
    "convergence": "Convergence",
    "done": "Done",
}

_FACILITATOR_SYSTEM = (
    "You are the neutral facilitator of an MBTI persona brainstorming session."
    " You do not take sides; you structure the problem, enforce the deferred"
    "-judgment rule, and merge ideas faithfully without adding your own"
    " preferences. Be concise and structured."
)

_DEFERRED_RULE = (
    "Ground rule (Osborn): DEFER JUDGMENT. During ideation, do not criticize"
    " any idea — yours or others'. Quantity and variety first; evaluation later."
)

_ANON_PREFIX = "Persona "
_MIN_MESSAGE_LEN = 60
_AGREE_RE = re.compile(r"\bagree\b", re.IGNORECASE)
_HEDGE_RE = re.compile(r"\b(however|but|although|disagree|push back|misses|risk)\b", re.IGNORECASE)
_IDEA_LINE_RE = re.compile(r"^\s*(?:[-*•]|\d{1,2}[.):])\s+(.*\S)\s*$")
_NEW_IDEA_RE = re.compile(r"^\s*NEW IDEA:\s*(.+)$", re.IGNORECASE)
_SCORES_RE = re.compile(
    r"Novelty\D{0,16}(\d{1,2}).*?Feasibility\D{0,16}(\d{1,2}).*?Clarity\D{0,16}(\d{1,2})",
    re.IGNORECASE | re.DOTALL,
)


# ---------------------------------------------------------------------------
# Response parsing helpers
# ---------------------------------------------------------------------------


def parse_ideas(text: str, limit: int) -> list[str]:
    """Extract bulleted/numbered idea lines, with graceful fallbacks so a
    session never dies on a malformed model response."""

    ideas: list[str] = []
    for line in text.splitlines():
        m = _IDEA_LINE_RE.match(line)
        if not m:
            continue
        content = m.group(1).strip().strip('"')
        if len(content) >= 8 and not content.lower().startswith(("rationale", "note", "ideas")):
            ideas.append(content)
        if len(ideas) >= limit:
            break
    if not ideas:
        for line in text.splitlines():
            stripped = line.strip()
            if len(stripped) >= 8:
                ideas.append(stripped)
            if len(ideas) >= limit:
                break
    if not ideas and text.strip():
        ideas = [text.strip()[:500]]
    return ideas


def parse_new_ideas(text: str) -> list[str]:
    """Discussion turns may derive new ideas via explicit 'NEW IDEA:' lines."""

    out = []
    for line in text.splitlines():
        m = _NEW_IDEA_RE.match(line)
        if m and len(m.group(1).strip()) >= 8:
            out.append(m.group(1).strip())
    return out


def parse_scores(text: str) -> IdeaScores:
    m = _SCORES_RE.search(text)
    if m:
        n, f, c = (max(1, min(10, int(v))) for v in m.groups())
    else:
        n = f = c = 5  # neutral fallback; the judge is advisory anyway
    return IdeaScores(novelty=n, feasibility=f, clarity=c, total=n + f + c)


def _is_agreement(text: str) -> bool:
    return bool(_AGREE_RE.search(text)) and not _HEDGE_RE.search(text)


# ---------------------------------------------------------------------------
# Runner registry & fan-out machinery
# ---------------------------------------------------------------------------


class SessionRunner:
    """Owns the event history and subscriber queues for one running session."""

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.history: list[dict[str, Any]] = []
        self.subscribers: set[asyncio.Queue] = set()
        self.done = False
        self._lock = asyncio.Lock()

    async def publish(self, event: dict[str, Any]) -> None:
        async with self._lock:
            self.history.append(event)
            for queue in list(self.subscribers):
                queue.put_nowait(event)

    async def subscribe(self) -> asyncio.Queue:
        """Return a dedicated queue pre-seeded with the full history (P1)."""

        queue: asyncio.Queue = asyncio.Queue()
        async with self._lock:
            for event in self.history:
                queue.put_nowait(event)
            self.subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self.subscribers.discard(queue)


_runners: dict[str, SessionRunner] = {}


def get_runner(session_id: str) -> Optional[SessionRunner]:
    return _runners.get(session_id)


def is_any_session_running() -> bool:
    return any(not r.done for r in _runners.values())


async def start_session(session_id: str, config: SessionCreate) -> None:
    """Entry point invoked by the API; spawns the run as a background task."""

    runner = SessionRunner(session_id)
    _runners[session_id] = runner
    task = asyncio.create_task(_execute(runner, config))
    runner.task = task  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Prompt builders (TASK markers double as the Mock provider's dispatch keys)
# ---------------------------------------------------------------------------


def _framing_prompt(config: SessionCreate) -> list[dict[str, str]]:
    user = (
        "TASK: FRAME\n"
        f"Theme: {config.theme}\n"
        f"Constraints: {config.constraints or '(none)'}\n\n"
        "Structure this brainstorming session in under 150 words: the goal, the"
        " constraints, the evaluation axes, and the deferred-judgment rule every"
        f" participant must follow. {_DEFERRED_RULE}"
    )
    return [
        {"role": "system", "content": _FACILITATOR_SYSTEM},
        {"role": "user", "content": user},
    ]


def _ideate_prompt(persona_type: str, config: SessionCreate, framing: str) -> list[dict[str, str]]:
    user = (
        f"TASK: IDEATE N={config.ideas_per_agent}\n"
        f"Theme: {config.theme}\n"
        f"Constraints: {config.constraints or '(none)'}\n\n"
        f"Facilitator framing:\n{framing}\n\n"
        f"You are brainstorming independently: you CANNOT see anyone else's"
        f" output, and judgment is deferred. Generate exactly"
        f" {config.ideas_per_agent} distinct ideas as this personality would,"
        f" one per bullet line ('- '), each 1-2 sentences. Do not number the"
        " bullets, do not add headings or commentary."
    )
    return [
        {"role": "system", "content": persona_system_prompt(persona_type)},
        {"role": "user", "content": user},
    ]


def _discuss_prompt(
    agent: AgentConfig,
    config: SessionCreate,
    framing: str,
    transcript: list[dict[str, str]],
    anon_name: str,
    is_devil: bool,
    round_no: int,
    agent_index: int,
) -> list[dict[str, str]]:
    visible = transcript[-12:]
    transcript_text = "\n".join(
        f"[{m['anon']}] {m['content'][:400]}" for m in visible
    ) or "(no messages yet)"
    previous = transcript[-1] if transcript else None
    devil_note = (
        "\nYou are the designated DEVIL'S ADVOCATE this session: challenge the"
        " most popular assumption in the discussion so far, constructively."
        if is_devil
        else ""
    )
    user = (
        f"TASK: DISCUSS ROUND={round_no} AGENT_INDEX={agent_index}\n"
        f"Theme: {config.theme}\n"
        f"Constraints: {config.constraints or '(none)'}\n\n"
        f"Facilitator framing:\n{framing}\n\n"
        f"Discussion so far (participants are anonymized; initial idea scores"
        f" are hidden):\n{transcript_text}\n\n"
        f"You are {anon_name}. Reply tit-for-tat to the IMMEDIATELY PREVIOUS"
        f" speaker ({previous['anon'] if previous else 'Facilitator'}): engage"
        " their point directly, then refine, combine or extend the ideas on the"
        " table. 2-4 sentences, in character."
        f"{devil_note}\n"
        "If — and only if — this turn inspires a genuinely NEW or refined idea,"
        " append one line exactly like: 'NEW IDEA: <one sentence>'."
    )
    return [
        {"role": "system", "content": persona_system_prompt(agent.persona_type)},
        {"role": "user", "content": user},
    ]


def _synthesize_prompt(config: SessionCreate, members: list[str]) -> list[dict[str, str]]:
    listing = "\n".join(f"{i + 1}. {m}" for i, m in enumerate(members))
    user = (
        "TASK: SYNTHESIZE\n"
        f"Theme: {config.theme}\n"
        f"Constraints: {config.constraints or '(none)'}\n\n"
        f"These {len(members)} ideas were judged near-duplicates (cosine"
        f" similarity >= 0.8):\n{listing}\n\n"
        "Merge them into one synthesized idea of at most 3 sentences, keeping"
        " every distinct valuable element, then state the tension axis (if any)"
        " that separated the originals in one line starting with 'Tension axis:'."
    )
    return [
        {"role": "system", "content": _FACILITATOR_SYSTEM},
        {"role": "user", "content": user},
    ]


def _judge_prompt(config: SessionCreate, content: str) -> list[dict[str, str]]:
    user = (
        "TASK: JUDGE\n"
        f"Theme: {config.theme}\n"
        f"Constraints: {config.constraints or '(none)'}\n\n"
        f"Idea: {content}\n\n"
        "Score this idea against the session theme on three axes, each an"
        " integer 1-10: Novelty, Feasibility, Clarity. Reply in EXACTLY this"
        " format, three lines, nothing else:\nNovelty: <n>\nFeasibility:"
        " <n>\nClarity: <n>"
    )
    return [
        {"role": "system", "content": _FACILITATOR_SYSTEM},
        {"role": "user", "content": user},
    ]


# ---------------------------------------------------------------------------
# Phase implementations
# ---------------------------------------------------------------------------


async def _phase_framing(runner: SessionRunner, config: SessionCreate) -> str:
    db.update_session_status(runner.session_id, "framing", "Structuring goal and rules")
    await runner.publish({"type": "phase", "phase": "framing", "label": PHASE_LABELS["framing"]})
    text = await providers.complete(
        config.facilitator.provider, config.facilitator.model, _framing_prompt(config)
    )
    db.insert_message(runner.session_id, 0, "Facilitator", "FACILITATOR", text)
    await runner.publish({"type": "message", "round": 0, "from": "Facilitator", "content": text})
    return text


async def _phase_divergence(runner: SessionRunner, config: SessionCreate, framing: str) -> int:
    """Independent ideation: agents run in parallel and never see each other."""

    db.update_session_status(runner.session_id, "divergence", "Independent idea generation")
    await runner.publish(
        {"type": "phase", "phase": "divergence", "label": PHASE_LABELS["divergence"]}
    )

    async def ideate(agent: AgentConfig) -> int:
        await runner.publish(
            {"type": "agent_start", "agent": agent.persona_type, "round": 1, "task": "ideate"}
        )
        chunks: list[str] = []
        try:
            stream = providers.stream_completion(
                agent.provider, agent.model, _ideate_prompt(agent.persona_type, config, framing)
            )
            async for delta in stream:
                chunks.append(delta)
                await runner.publish(
                    {"type": "token", "agent": agent.persona_type, "round": 1, "delta": delta}
                )
        except Exception as exc:  # one agent's failure must not kill the session
            await runner.publish(
                {
                    "type": "message",
                    "round": 1,
                    "from": "System",
                    "content": f"{agent.persona_type} failed to generate ideas: {exc}",
                }
            )
            return 0
        finally:
            await runner.publish(
                {"type": "agent_done", "agent": agent.persona_type, "round": 1}
            )
        produced = 0
        for content in parse_ideas("".join(chunks), config.ideas_per_agent):
            idea = db.insert_idea(runner.session_id, agent.persona_type, "divergence", content)
            produced += 1
            await runner.publish({"type": "idea", "idea": idea.model_dump(mode="json")})
        return produced

    counts = await asyncio.gather(*(ideate(agent) for agent in config.agents))
    return sum(counts)


async def _phase_discussion(
    runner: SessionRunner, config: SessionCreate, framing: str
) -> None:
    db.update_session_status(runner.session_id, "discussion", "Anonymous collaborative discussion")
    await runner.publish(
        {"type": "phase", "phase": "discussion", "label": PHASE_LABELS["discussion"]}
    )

    anon = {a.persona_type: f"{_ANON_PREFIX}{chr(ord('A') + i)}" for i, a in enumerate(config.agents)}
    devil_type = next(
        (a.persona_type for a in config.agents if a.role == "devils_advocate"),
        # Deterministic fallback when nobody was designated in the UI.
        config.agents[-1].persona_type,
    )

    transcript: list[dict[str, str]] = [{"anon": "Facilitator", "content": framing}]
    for round_no in range(1, config.discussion_rounds + 1):
        round_messages: list[str] = []
        for index, agent in enumerate(config.agents):
            await runner.publish(
                {
                    "type": "agent_start",
                    "agent": agent.persona_type,
                    "round": round_no,
                    "task": "discuss",
                }
            )
            chunks: list[str] = []
            try:
                stream = providers.stream_completion(
                    agent.provider,
                    agent.model,
                    _discuss_prompt(
                        agent,
                        config,
                        framing,
                        transcript,
                        anon[agent.persona_type],
                        agent.persona_type == devil_type,
                        round_no,
                        index,
                    ),
                )
                async for delta in stream:
                    chunks.append(delta)
                    await runner.publish(
                        {
                            "type": "token",
                            "agent": agent.persona_type,
                            "round": round_no,
                            "delta": delta,
                        }
                    )
            except Exception as exc:
                await runner.publish(
                    {
                        "type": "message",
                        "round": round_no,
                        "from": "System",
                        "content": f"{agent.persona_type} turn failed: {exc}",
                    }
                )
                continue
            finally:
                await runner.publish(
                    {"type": "agent_done", "agent": agent.persona_type, "round": round_no}
                )

            content = "".join(chunks).strip()
            if not content:
                continue
            entry = {"anon": anon[agent.persona_type], "content": content}
            transcript.append(entry)
            round_messages.append(content)
            db.insert_message(
                runner.session_id, round_no, anon[agent.persona_type], agent.persona_type, content
            )
            await runner.publish(
                {
                    "type": "message",
                    "round": round_no,
                    "from": anon[agent.persona_type],
                    "content": content,
                }
            )
            for new_content in parse_new_ideas(content):
                idea = db.insert_idea(
                    runner.session_id,
                    f"DISCUSSION:{agent.persona_type}",
                    "discussion",
                    new_content,
                )
                await runner.publish({"type": "idea", "idea": idea.model_dump(mode="json")})

        # Stagnation detection -> early stop (SPEC section 2.1).
        if round_messages:
            all_short = all(len(m) < _MIN_MESSAGE_LEN for m in round_messages)
            agree_rate = sum(1 for m in round_messages if _is_agreement(m)) / len(round_messages)
            if all_short or agree_rate > 0.9:
                await runner.publish(
                    {
                        "type": "message",
                        "round": round_no,
                        "from": "Facilitator",
                        "content": "Discussion stagnated (uniform brevity or >90% agreement);"
                        " ending early per the saturation rule.",
                    }
                )
                break


async def _phase_convergence(
    runner: SessionRunner, config: SessionCreate, framing: str
) -> None:
    db.update_session_status(runner.session_id, "convergence", "Dedup, synthesis and scoring")
    await runner.publish(
        {"type": "phase", "phase": "convergence", "label": PHASE_LABELS["convergence"]}
    )

    ideas = db.list_ideas(runner.session_id)
    texts = [i.content for i in ideas]
    session_metrics, cluster_ids = await metrics.compute_metrics(texts)

    # Group idea indexes by cluster, preserving deterministic order.
    clusters: dict[int, list[int]] = {}
    for idx, cid in enumerate(cluster_ids):
        clusters.setdefault(cid, []).append(idx)

    # Re-synthesis for multi-member clusters; the synthesized text is stored on
    # the cluster representative (its first member).
    synthesized_by_index: dict[int, str] = {}
    for member_indexes in clusters.values():
        if len(member_indexes) < 2:
            continue
        representative = member_indexes[0]
        try:
            text = await providers.complete(
                config.facilitator.provider,
                config.facilitator.model,
                _synthesize_prompt(config, [texts[i] for i in member_indexes]),
            )
            synthesized_by_index[representative] = text
        except Exception:
            continue  # synthesis is best-effort; dedup result still stands

    # Judge pre-ranking per cluster representative, propagated to members
    # (keeps the number of LLM calls proportional to unique ideas).
    scores_by_cluster: dict[int, IdeaScores] = {}
    if config.enable_judge:
        for cid, member_indexes in clusters.items():
            representative = member_indexes[0]
            try:
                text = await providers.complete(
                    config.facilitator.provider,
                    config.facilitator.model,
                    _judge_prompt(config, texts[representative]),
                )
                scores_by_cluster[cid] = parse_scores(text)
            except Exception:
                scores_by_cluster[cid] = parse_scores("")  # neutral 5/5/5 fallback

    for idx, idea in enumerate(ideas):
        cid = cluster_ids[idx]
        updated = db.update_idea_convergence(
            idea.id,
            cluster_id=cid,
            synthesized=synthesized_by_index.get(idx),
            scores=scores_by_cluster.get(cid),
        )
        # P2: the idea event is emitted a second time with convergence data;
        # the frontend upserts by id.
        if updated:
            await runner.publish({"type": "idea", "idea": updated.model_dump(mode="json")})

    db.update_session_metrics(runner.session_id, session_metrics)
    await runner.publish({"type": "metrics", "metrics": session_metrics.model_dump(mode="json")})


# ---------------------------------------------------------------------------
# Top-level execution
# ---------------------------------------------------------------------------


async def _execute(runner: SessionRunner, config: SessionCreate) -> None:
    session_id = runner.session_id
    try:
        framing = await _phase_framing(runner, config)
        produced = await _phase_divergence(runner, config, framing)
        if produced == 0:
            raise RuntimeError(
                "Every agent failed to produce ideas; check provider availability and models."
            )
        if config.discussion_rounds > 0:
            await _phase_discussion(runner, config, framing)
        await _phase_convergence(runner, config, framing)
        db.update_session_status(session_id, "done", "Session completed")
        await runner.publish({"type": "phase", "phase": "done", "label": PHASE_LABELS["done"]})
    except Exception as exc:
        db.update_session_status(session_id, "error", str(exc)[:500])
        await runner.publish({"type": "error", "message": str(exc)[:500]})
    finally:
        runner.done = True
        # Live subscribers already hold every event in their queues; new
        # connections from here on replay from the DB (P1).
        _runners.pop(session_id, None)

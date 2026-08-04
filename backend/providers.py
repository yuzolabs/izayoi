"""LLM provider abstraction (SPEC sections 4 and 5.1).

- Cloud providers are called uniformly through LiteLLM. **litellm is imported
  lazily inside the call functions** so that Mock-only environments (CI, fresh
  checkouts) can boot and pass every test without it installed (pitfall P6).
- API keys are read from environment variables only. They are never logged,
  persisted, or returned by the API (C4).
- The Mock provider is always available and produces deterministic English
  responses that embed the persona type, theme, idea number and round, so the
  whole product can be exercised without any key (SPEC section 7.3).
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
from typing import Any, AsyncIterator, Optional

from .models import ProviderInfo

# ---------------------------------------------------------------------------
# Provider registry
# ---------------------------------------------------------------------------

_PROVIDERS: list[dict[str, Any]] = [
    {
        "id": "openai",
        "label": "OpenAI",
        "env_vars": ["OPENAI_API_KEY"],
        "prefix": "openai/",
        "models": ["gpt-5.6-luna", "gpt-5-mini", "gpt-4.1"],
    },
    {
        "id": "anthropic",
        "label": "Anthropic",
        "env_vars": ["ANTHROPIC_API_KEY"],
        "prefix": "anthropic/",
        "models": ["claude-sonnet-5", "claude-haiku-4-5", "claude-opus-4-5"],
    },
    {
        "id": "gemini",
        "label": "Google",
        "env_vars": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        "prefix": "gemini/",
        "models": ["gemini-3.6-flash", "gemini-3-pro", "gemini-2.5-flash"],
    },
    {
        "id": "xai",
        "label": "xAI",
        "env_vars": ["XAI_API_KEY"],
        "prefix": "xai/",
        "models": ["grok-4.5", "grok-4", "grok-3-mini"],
    },
    {
        "id": "zai",
        "label": "ZAI",
        "env_vars": ["ZAI_API_KEY"],
        "prefix": "zai/",
        "models": ["GLM-5.2", "GLM-4.6", "GLM-4.5-air"],
    },
    {
        "id": "mock",
        "label": "Mock (no key required)",
        "env_vars": [],
        "prefix": "",
        "models": ["mock"],
    },
]

DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small"


def detect_providers() -> list[ProviderInfo]:
    """Inspect the environment and return the detection result for every provider."""

    result: list[ProviderInfo] = []
    for spec in _PROVIDERS:
        available = bool(spec["env_vars"]) and any(os.environ.get(v) for v in spec["env_vars"])
        if spec["id"] == "mock":
            available = True  # always available by design
        result.append(
            ProviderInfo(
                id=spec["id"],
                label=spec["label"],
                available=available,
                env_var=spec["env_vars"][0] if spec["env_vars"] else None,
                models=list(spec["models"]),
            )
        )
    return result


def is_provider_available(provider_id: str) -> bool:
    return any(p.id == provider_id and p.available for p in detect_providers())


def _litellm_model_string(provider_id: str, model: str) -> str:
    spec = next((s for s in _PROVIDERS if s["id"] == provider_id), None)
    prefix = spec["prefix"] if spec else ""
    return f"{prefix}{model}" if prefix and not model.startswith(prefix) else model


# ---------------------------------------------------------------------------
# Completion API (streaming + one-shot)
# ---------------------------------------------------------------------------


async def stream_completion(
    provider: str,
    model: str,
    messages: list[dict[str, str]],
    temperature: float = 0.8,
    max_tokens: int = 1200,
) -> AsyncIterator[str]:
    """Yield text deltas for a chat completion.

    The Mock provider yields small chunks at 0.01 s intervals to exercise the
    streaming pipeline; cloud providers stream through LiteLLM.
    """

    if provider == "mock":
        text = _mock_response(messages)
        for chunk in _chunk_text(text):
            await asyncio.sleep(0.01)
            yield chunk
        return

    from litellm import acompletion  # lazy import (P6)

    response = await acompletion(
        model=_litellm_model_string(provider, model),
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
        stream=True,
    )
    async for part in response:
        delta = part.choices[0].delta.get("content") if part.choices else None
        if delta:
            yield delta


async def complete(
    provider: str,
    model: str,
    messages: list[dict[str, str]],
    temperature: float = 0.8,
    max_tokens: int = 1200,
) -> str:
    """One-shot (non-streaming) chat completion."""

    if provider == "mock":
        return _mock_response(messages)

    from litellm import acompletion  # lazy import (P6)

    response = await acompletion(
        model=_litellm_model_string(provider, model),
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
    )
    return (response.choices[0].message.content or "").strip()


# ---------------------------------------------------------------------------
# Embeddings (cloud via LiteLLM; caller falls back to TF-IDF on None)
# ---------------------------------------------------------------------------


def embedding_model_default() -> Optional[str]:
    """Pick an embedding model from the available keys (SPEC section 5.3)."""

    explicit = os.environ.get("EMBEDDING_MODEL")
    if explicit:
        return explicit
    if os.environ.get("OPENAI_API_KEY"):
        return DEFAULT_EMBEDDING_MODEL
    if os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"):
        return "gemini/text-embedding-004"
    return None


async def embed_texts(texts: list[str]) -> Optional[list[list[float]]]:
    """Return cloud embeddings, or None when unavailable/failing.

    Returning None (instead of raising) lets the metrics layer fall back to the
    numpy-only TF-IDF implementation transparently.
    """

    model = embedding_model_default()
    if not model:
        return None
    try:
        from litellm import aembedding  # lazy import (P6)

        response = await aembedding(model=model, input=texts)
        return [list(map(float, item["embedding"])) for item in response.data]
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Mock provider (deterministic, English, streaming-friendly)
# ---------------------------------------------------------------------------

_MBTI_TYPES = (
    "INTJ INTP ENTJ ENTP INFJ INFP ENFJ ENFP ISTJ ISFJ ESTJ ESFJ ISTP ISFP ESTP ESFP"
).split()

# Lexically diverse idea skeletons. Distinct vocabularies keep cosine
# similarity low so dedup (cos >= 0.8) never wipes out the mock pool.
_MOCK_IDEA_BANK = [
    "Launch a tiered micro-subscription around {t} so casual users pay only for what they use",
    "Build a community guild program where power users of {t} mentor newcomers for badges",
    "Add an offline-first mode for {t} that syncs changes when connectivity returns",
    "Create a marketplace where third parties sell templates and extensions for {t}",
    "Introduce gamified weekly challenges tied to {t} with a public leaderboard",
    "Ship an accessibility audit pass on {t}: keyboard paths, contrast, screen-reader labels",
    "Offer a privacy dashboard for {t} showing exactly what data leaves the device",
    "Partner with educators to turn {t} into a graded curriculum with certificates",
    "Prototype an AI copilot that drafts first passes of {t} for humans to edit",
    "Publish a public API for {t} and seed it with three reference integrations",
    "Run a monthly live showcase where users present what they built with {t}",
    "Design a carbon-aware scheduling option for {t} that shifts jobs to greener hours",
    "Add collaborative whiteboarding directly inside {t} for real-time team sessions",
    "Create a concierge onboarding call for every new team adopting {t}",
    "Localize {t} for five underserved languages with community-reviewed translations",
    "Introduce usage-based billing alerts so {t} never surprises anyone on invoice day",
    "Build a lightweight mobile companion app focused on notifications for {t}",
    "Open-source the core engine of {t} to build trust and attract contributors",
    "Add one-click data export and import so users never feel locked into {t}",
    "Create an enterprise compliance pack for {t}: SSO, audit logs, retention policies",
    "Host an annual design contest for {t} with the winning entry shipped by default",
    "Introduce a referral loop: invite a colleague to {t} and both get premium months",
    "Ship a performance budget initiative making {t} load in under two seconds",
    "Add context-aware tips inside {t} that appear only when a user stalls",
    "Build a status page and incident history so {t} reliability is publicly verifiable",
    "Offer a sandbox mode with synthetic data so teams can evaluate {t} safely",
    "Create themed seasonal packs for {t} that refresh the experience quarterly",
    "Introduce a bug-bounty program to crowdsource security review of {t}",
    "Add keyboard-first power-user shortcuts across every screen of {t}",
    "Build an analytics digest that emails weekly progress summaries about {t}",
    "Create a mentorship track inside {t} pairing experienced and new users",
    "Add end-to-end encryption for all shared artifacts produced in {t}",
    "Ship a command palette so every action in {t} is three keystrokes away",
    "Introduce charity tie-ins: heavy usage milestones of {t} fund donations",
    "Build a migration wizard that imports data from the two main rivals of {t}",
    "Add quiet hours and focus modes so {t} respects deep-work boundaries",
    "Create a hardware-free demo environment of {t} that runs entirely in the browser",
]

_MOCK_STANCES = [
    "I partly agree with the direction, however the execution risk is being underestimated",
    "That framing misses a cheaper angle; consider the constraint as a feature instead",
    "There is a hidden assumption here about adoption that nobody has tested yet",
    "Strong concept, although the second-order effect on existing users needs a plan",
    "I would push back on the timeline, but the underlying leverage is real",
    "The idea works only if the onboarding story is solved first; otherwise it stalls",
]


def _stable_int(*parts: str) -> int:
    """Process-stable hash (Python's built-in hash() is salted per process)."""

    digest = hashlib.md5("".join(parts).encode("utf-8")).hexdigest()
    return int(digest, 16)


def _chunk_text(text: str, size: int = 6) -> list[str]:
    return [text[i : i + size] for i in range(0, len(text), size)]


def _extract_persona_type(system: str) -> str:
    match = re.search(r"You are ([A-Z]{4}) \(", system)
    if match and match.group(1) in _MBTI_TYPES:
        return match.group(1)
    return "INTJ"


def _extract_theme(text: str) -> str:
    match = re.search(r"^Theme:\s*(.+)$", text, flags=re.MULTILINE)
    theme = match.group(1).strip() if match else "the project"
    return theme[:48] + ("..." if len(theme) > 48 else "")


def _mock_idea(persona: str, theme: str, index: int, salt: str = "") -> str:
    # Stride 7 is coprime with len(bank)=36, so consecutive indices stay distinct.
    pick = (_stable_int(persona, theme, salt) + index * 7) % len(_MOCK_IDEA_BANK)
    return _MOCK_IDEA_BANK[pick].format(t=theme)


def _mock_response(messages: list[dict[str, str]]) -> str:
    """Deterministic dummy response driven by explicit TASK markers that the
    orchestrator embeds in its prompts (SPEC section 7.3)."""

    system = next((m["content"] for m in messages if m["role"] == "system"), "")
    user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    joined = system + "\n" + user
    persona = _extract_persona_type(system)
    theme = _extract_theme(joined)

    task = re.search(r"TASK:\s*([A-Z]+)([^\n]*)", joined)
    kind = task.group(1) if task else "IDEATE"
    args = task.group(2) if task else ""

    if kind == "FRAME":
        return (
            f"Framing for session theme: {theme}\n"
            f"Purpose: generate diverse, decision-ready directions for {theme} and"
            " select the strongest by explicit criteria.\n"
            "Constraints: the session's stated constraints apply to every proposal.\n"
            "Evaluation axes: novelty, feasibility, clarity, and user impact.\n"
            "Rule: defer all judgment during ideation (Osborn). Criticism is welcome"
            " only in the discussion phase."
        )

    if kind == "IDEATE":
        n_match = re.search(r"N=(\d+)", args)
        n = int(n_match.group(1)) if n_match else 3
        lines = [
            f"- {_mock_idea(persona, theme, i)}. Rationale: fits {persona} priorities."
            for i in range(n)
        ]
        return "\n".join(lines)

    if kind == "DISCUSS":
        r_match = re.search(r"ROUND=(\d+)", args)
        round_no = int(r_match.group(1)) if r_match else 1
        a_match = re.search(r"AGENT_INDEX=(\d+)", args)
        agent_index = int(a_match.group(1)) if a_match else 0
        stance = _MOCK_STANCES[_stable_int(persona, theme, str(round_no)) % len(_MOCK_STANCES)]
        body = (
            f"[Round {round_no}] As {persona}, responding to the previous speaker: {stance}."
            f" Refining my earlier proposal on {theme}, I would narrow the scope to one"
            " user segment and instrument the result before scaling."
        )
        # Roughly half of the mock turns derive a new idea, keeping the
        # discussion pool non-trivial but smaller than the divergence pool.
        if (agent_index + round_no) % 2 == 0:
            idea = _mock_idea(persona, theme, round_no * 3 + agent_index, salt="discuss")
            body += f"\nNEW IDEA: {idea}"
        return body

    if kind == "SYNTHESIZE":
        return (
            f"Merged cluster around {theme}: combine the members into a single initiative"
            " with phased delivery (pilot first, then general availability)."
            " Tension axis: speed of rollout versus depth of integration; the merged"
            " proposal keeps both by staging the work."
        )

    if kind == "JUDGE":
        seed_source = re.search(r"Idea:\s*(.+)", joined)
        seed = seed_source.group(1) if seed_source else joined
        base = _stable_int(seed)
        novelty = 1 + base % 10
        feasibility = 1 + (base // 10) % 10
        clarity = 1 + (base // 100) % 10
        return f"Novelty: {novelty}\nFeasibility: {feasibility}\nClarity: {clarity}"

    # Fallback for unmarked prompts: behave like a one-idea ideation turn.
    return f"- {_mock_idea(persona, theme, 0)}"

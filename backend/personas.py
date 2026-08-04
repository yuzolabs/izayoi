"""Persona registry: loads the 16 MBTI persona definitions and implements the
balanced-selection logic (SPEC section 3.3).

The JSON file is the single source of truth and must contain all 16 types with
the 11 required fields each (validated by the test suite).
"""

from __future__ import annotations

import itertools
import json
from functools import lru_cache
from pathlib import Path

from .models import Persona

PERSONAS_PATH = Path(__file__).parent / "personas" / "mbti_16.json"

REQUIRED_FIELDS = (
    "type",
    "name_ja",
    "core_traits",
    "strengths",
    "weaknesses",
    "cognitive_style",
    "motivations",
    "behavioral_tendencies",
    "communication_style",
    "scenario_hint",
    "output_format",
)

# 16Personalities group colors, reused by the frontend persona chips.
GROUPS = {
    "Analysts": {"color": "#88619a", "types": ["INTJ", "INTP", "ENTJ", "ENTP"]},
    "Diplomats": {"color": "#33a474", "types": ["INFJ", "INFP", "ENFJ", "ENFP"]},
    "Sentinels": {"color": "#4298b4", "types": ["ISTJ", "ISFJ", "ESTJ", "ESFJ"]},
    "Explorers": {"color": "#e4ae3a", "types": ["ISTP", "ISFP", "ESTP", "ESFP"]},
}


@lru_cache(maxsize=1)
def load_personas() -> list[dict]:
    """Load and validate all persona definitions (cached for process lifetime)."""

    data = json.loads(PERSONAS_PATH.read_text(encoding="utf-8"))
    for entry in data:
        missing = [f for f in REQUIRED_FIELDS if f not in entry or not entry[f]]
        if missing:
            raise ValueError(f"persona {entry.get('type')}: missing fields {missing}")
    return data


def get_persona(persona_type: str) -> dict:
    for p in load_personas():
        if p["type"] == persona_type:
            return p
    raise KeyError(f"unknown persona type: {persona_type}")


def list_persona_summaries() -> list[Persona]:
    """Public summaries returned by GET /api/personas."""

    return [
        Persona(type=p["type"], name_ja=p["name_ja"], summary=p["core_traits"])
        for p in load_personas()
    ]


def persona_system_prompt(persona_type: str) -> str:
    """Build the re-priming role declaration injected at the top of every turn.

    Follows SPEC section 3.2: role declaration + 7-section persona summary.
    """

    p = get_persona(persona_type)
    return (
        f"You are {p['type']} ({p['name_ja']}). Stay fully in this personality for the\n"
        f"entire session, in every reply.\n"
        f"- Core traits: {p['core_traits']}\n"
        f"- Strengths: {p['strengths']}\n"
        f"- Weaknesses (act them out naturally, do not suppress them): {p['weaknesses']}\n"
        f"- Cognitive style: {p['cognitive_style']}\n"
        f"- Motivations: {p['motivations']}\n"
        f"- Behavioral tendencies: {p['behavioral_tendencies']}\n"
        f"- Communication style: {p['communication_style']}\n"
        f"- In this brainstorming scenario: {p['scenario_hint']}\n"
        f"- Output format: {p['output_format']}"
    )


def _axis_letter(persona_type: str, axis: str) -> str:
    idx = {"EI": 0, "SN": 1, "TF": 2, "JP": 3}[axis]
    return persona_type[idx]


def balanced_select(count: int, candidates: list[str] | None = None) -> list[str]:
    """Choose ``count`` personas minimizing bias on the E/I, T/F and J/P axes.

    Exhaustive over C(16, count) (max 8008 combinations for count=8, far less
    for the supported 4-6 range) so the optimum is exact and deterministic:
    ties are broken lexicographically on the sorted type tuple.
    """

    if not 4 <= count <= 6:
        raise ValueError("balanced selection supports 4 to 6 members")
    pool = candidates or [p["type"] for p in load_personas()]
    axes = ("EI", "TF", "JP")

    def imbalance(combo: tuple[str, ...]) -> int:
        score = 0
        for axis in axes:
            first = sum(1 for t in combo if _axis_letter(t, axis) == axis[0])
            score += abs(2 * first - count)
        return score

    best: tuple[str, ...] | None = None
    best_score: int | None = None
    for combo in itertools.combinations(sorted(pool), count):
        score = imbalance(combo)
        if best_score is None or score < best_score or (score == best_score and combo < best):
            best, best_score = combo, score
    assert best is not None
    return list(best)

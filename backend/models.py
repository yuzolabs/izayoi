"""Pydantic models mirroring the frozen API contract (SPEC.md section 6.1).

The same shapes are implemented as TypeScript interfaces in ``frontend/src/lib/api.ts``.
Keep both ends in sync when changing anything here.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

Decision = Literal["pending", "adopted", "held", "rejected"]
AgentRole = Literal["participant", "devils_advocate"]
Phase = Literal["divergence", "discussion"]
SessionStatus = Literal["framing", "divergence", "discussion", "convergence", "done", "error"]


class ProviderInfo(BaseModel):
    """A detectable LLM provider. ``available`` reflects env-var detection."""

    id: str
    label: str
    available: bool
    env_var: Optional[str]
    models: list[str]


class Persona(BaseModel):
    """Public persona summary. ``name_ja`` keeps the contract field name but
    holds the English persona name (product content is English)."""

    type: str
    name_ja: str
    summary: str


class AgentConfig(BaseModel):
    persona_type: str
    provider: str
    model: str
    role: AgentRole = "participant"


class FacilitatorConfig(BaseModel):
    provider: str
    model: str


class SessionCreate(BaseModel):
    theme: str = Field(min_length=1, max_length=2000)
    constraints: str = Field(default="", max_length=2000)
    ideas_per_agent: int = Field(default=3, ge=1, le=10)
    discussion_rounds: int = Field(default=2, ge=0, le=3)
    agents: list[AgentConfig] = Field(min_length=2, max_length=16)
    facilitator: FacilitatorConfig
    enable_judge: bool = True


class SessionMetrics(BaseModel):
    total_ideas: int
    unique_ideas: int
    non_duplicate_ratio: float
    semantic_dispersion: float
    collapse_alert: bool


class Session(BaseModel):
    id: str
    theme: str
    constraints: str
    status: SessionStatus
    phase_progress: str
    agents: list[AgentConfig]
    created_at: str
    metrics: Optional[SessionMetrics] = None


class IdeaScores(BaseModel):
    novelty: int = Field(ge=1, le=10)
    feasibility: int = Field(ge=1, le=10)
    clarity: int = Field(ge=1, le=10)
    total: int = Field(ge=3, le=30)


class Idea(BaseModel):
    id: str
    session_id: str
    persona_type: str  # discussion-derived ideas use "DISCUSSION:<TYPE>"
    phase: Phase
    content: str
    cluster_id: Optional[int] = None
    synthesized: Optional[str] = None
    scores: Optional[IdeaScores] = None
    decision: Decision = "pending"
    note: str = ""


class DecisionUpdate(BaseModel):
    decision: Decision
    note: Optional[str] = None


class ChatMessage(BaseModel):
    """A persisted discussion/framing log line (DB ``messages`` table)."""

    id: str
    session_id: str
    round: int  # 0 = facilitator framing, >=1 = discussion rounds
    anon_name: str
    persona_type: str
    content: str
    created_at: str

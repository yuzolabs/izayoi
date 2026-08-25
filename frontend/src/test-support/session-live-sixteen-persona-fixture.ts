import type { Idea, Persona, Session, SessionMetrics } from "@/lib/api";
import { PERSONA_GROUPS } from "@/lib/persona-meta";

/** English display names for the sixteen persona live stream catalog. */
const SESSION_LIVE_SIXTEEN_PERSONA_DISPLAY_NAMES: Record<string, string> = {
  INTJ: "Architect",
  INTP: "Logician",
  ENTJ: "Commander",
  ENTP: "Debater",
  INFJ: "Advocate",
  INFP: "Mediator",
  ENFJ: "Protagonist",
  ENFP: "Campaigner",
  ISTJ: "Logistician",
  ISFJ: "Defender",
  ESTJ: "Executive",
  ESFJ: "Consul",
  ISTP: "Virtuoso",
  ISFP: "Adventurer",
  ESTP: "Entrepreneur",
  ESFP: "Entertainer",
};

/**
 * Sixteen persona live stream catalog derived from the 16Personalities groups.
 * Search: sixteen persona catalog, 16 persona live session.
 */
export const SESSION_LIVE_SIXTEEN_PERSONA_CATALOG: readonly Persona[] =
  PERSONA_GROUPS.flatMap((group) =>
    group.types.map((type) => ({
      type,
      name_ja: SESSION_LIVE_SIXTEEN_PERSONA_DISPLAY_NAMES[type] ?? type,
      summary: `${type} sixteen-persona live stream participant`,
    }))
  );

/** Ordered persona type codes for a sixteen-persona live session. */
export const SESSION_LIVE_SIXTEEN_PERSONA_TYPES: readonly string[] =
  SESSION_LIVE_SIXTEEN_PERSONA_CATALOG.map((persona) => persona.type);

/** Session id used by the sixteen-persona live stream regression. */
export const SESSION_LIVE_SIXTEEN_PERSONA_SESSION_ID = "session-live-sixteen-persona";

/** Theme heading used to prove the sixteen-persona live view stayed mounted. */
export const SESSION_LIVE_SIXTEEN_PERSONA_THEME = "Sixteen persona live council";

/** Builds one idea event payload for a sixteen-persona independent pass. */
export function createSessionLiveSixteenPersonaIdea(personaType: string): Idea {
  return {
    id: `idea-sixteen-${personaType}`,
    session_id: SESSION_LIVE_SIXTEEN_PERSONA_SESSION_ID,
    persona_type: personaType,
    phase: "divergence",
    content: `${personaType} confirmed sixteen-persona idea`,
    cluster_id: null,
    synthesized: null,
    scores: null,
    decision: "pending",
    note: "",
  };
}

/**
 * Framing-phase session with every sixteen-persona live agent already seated.
 * Search: sixteen persona live session fixture.
 */
export function createSessionLiveSixteenPersonaSession(): Session {
  return {
    id: SESSION_LIVE_SIXTEEN_PERSONA_SESSION_ID,
    theme: SESSION_LIVE_SIXTEEN_PERSONA_THEME,
    constraints: "Keep all sixteen live cards readable through discussion",
    status: "framing",
    phase_progress: "framing",
    agents: SESSION_LIVE_SIXTEEN_PERSONA_CATALOG.map((persona) => ({
      persona_type: persona.type,
      provider: "test-provider",
      model: "test-model",
      role: "participant",
    })),
    created_at: "2026-08-24T00:00:00Z",
    metrics: null,
  };
}

/**
 * Diversity metrics published after the sixteen-persona independent pass.
 * Search: sixteen persona live metrics.
 */
export const SESSION_LIVE_SIXTEEN_PERSONA_METRICS: SessionMetrics = {
  total_ideas: 16,
  unique_ideas: 16,
  non_duplicate_ratio: 1,
  semantic_dispersion: 0.75,
  collapse_alert: false,
};

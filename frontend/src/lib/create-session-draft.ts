import type { AgentConfig } from "./api";

/**
 * In-memory Create session form draft restored across in-app route changes.
 *
 * This is not the Results mutation journal and never uses sessionStorage:
 * a full page reload may drop the draft, and Start confirmation must clear it.
 */
export interface CreateSessionDraft {
  theme: string;
  constraints: string;
  /** Selected personas including provider, model, and devil's advocate role. */
  cast: AgentConfig[];
  balanceCount: number;
  ideasPerAgent: number;
  discussionRounds: number;
  enableJudge: boolean;
  facilitator: { provider: string; model: string };
}

/** Fresh Create form values used when no in-memory draft is stored. */
export const CREATE_SESSION_DRAFT_DEFAULTS: CreateSessionDraft = {
  theme: "",
  constraints: "",
  cast: [],
  balanceCount: 4,
  ideasPerAgent: 3,
  discussionRounds: 2,
  enableJudge: true,
  facilitator: { provider: "", model: "" },
};

let createSessionDraft: CreateSessionDraft | null = null;

function cloneCreateSessionDraft(draft: CreateSessionDraft): CreateSessionDraft {
  return {
    theme: draft.theme,
    constraints: draft.constraints,
    cast: draft.cast.map((agent) => ({ ...agent })),
    balanceCount: draft.balanceCount,
    ideasPerAgent: draft.ideasPerAgent,
    discussionRounds: draft.discussionRounds,
    enableJudge: draft.enableJudge,
    facilitator: { ...draft.facilitator },
  };
}

/** Reads a cloned in-memory Create session form draft, or null when none is stored. */
export function readCreateSessionDraft(): CreateSessionDraft | null {
  return createSessionDraft === null
    ? null
    : cloneCreateSessionDraft(createSessionDraft);
}

/** Writes a cloned Create session form draft into module memory, not sessionStorage. */
export function writeCreateSessionDraft(draft: CreateSessionDraft): void {
  createSessionDraft = cloneCreateSessionDraft(draft);
}

/** Clears the in-memory Create session form draft after a session start is confirmed. */
export function clearCreateSessionDraft(): void {
  createSessionDraft = null;
}

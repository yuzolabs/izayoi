/**
 * API client for the frozen izayoi contract (SPEC section 6).
 * These interfaces mirror backend/models.py one-to-one.
 */

export interface ProviderInfo {
  id: string;
  label: string;
  available: boolean;
  env_var: string | null;
  models: string[];
}

export interface Persona {
  type: string;
  name_ja: string; // contract field name; holds the English persona name
  summary: string;
}

export type AgentRole = "participant" | "devils_advocate";

export interface AgentConfig {
  persona_type: string;
  provider: string;
  model: string;
  role: AgentRole;
}

export interface SessionCreate {
  theme: string;
  constraints: string;
  ideas_per_agent: number;
  discussion_rounds: number;
  agents: AgentConfig[];
  facilitator: { provider: string; model: string };
  enable_judge: boolean;
}

export type SessionStatus =
  | "framing"
  | "divergence"
  | "discussion"
  | "convergence"
  | "done"
  | "error";

export interface SessionMetrics {
  total_ideas: number;
  unique_ideas: number;
  non_duplicate_ratio: number;
  semantic_dispersion: number;
  collapse_alert: boolean;
}

export interface Session {
  id: string;
  theme: string;
  constraints: string;
  status: SessionStatus;
  phase_progress: string;
  agents: AgentConfig[];
  created_at: string;
  metrics: SessionMetrics | null;
}

export interface IdeaScores {
  novelty: number;
  feasibility: number;
  clarity: number;
  total: number;
}

export type Decision = "pending" | "adopted" | "held" | "rejected";

export interface Idea {
  id: string;
  session_id: string;
  persona_type: string; // discussion-derived ideas use "DISCUSSION:<TYPE>"
  phase: "divergence" | "discussion";
  content: string;
  cluster_id: number | null;
  synthesized: string | null;
  scores: IdeaScores | null;
  decision: Decision;
  note: string;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  round: number;
  anon_name: string;
  persona_type: string;
  content: string;
  created_at: string;
}

// SSE event union (SPEC 6.3).
export type StreamEvent =
  | { type: "phase"; phase: string; label?: string }
  | { type: "agent_start"; agent: string; round: number; task: string }
  | { type: "token"; agent: string; round: number; delta: string }
  | { type: "agent_done"; agent: string; round: number }
  | { type: "idea"; idea: Idea }
  | { type: "message"; round: number; from: string; content: string }
  | { type: "metrics"; metrics: SessionMetrics }
  | { type: "error"; message: string };

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      // keep the status-line fallback
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

export const api = {
  providers: () => request<{ providers: ProviderInfo[] }>("/providers"),
  personas: () => request<{ personas: Persona[] }>("/personas"),
  balanced: (count: number) =>
    request<{ types: string[] }>(`/personas/balanced?count=${count}`),
  createSession: (payload: SessionCreate) =>
    request<Session>("/sessions", { method: "POST", body: JSON.stringify(payload) }),
  startSession: (id: string) =>
    request<{ status: string }>(`/sessions/${id}/start`, { method: "POST" }),
  getSession: (id: string) => request<Session>(`/sessions/${id}`),
  listSessions: () => request<{ sessions: Session[] }>("/sessions"),
  listIdeas: (id: string) => request<{ ideas: Idea[] }>(`/sessions/${id}/ideas`),
  listMessages: (id: string) =>
    request<{ messages: ChatMessage[] }>(`/sessions/${id}/messages`),
  updateDecision: (ideaId: string, decision: Decision, note?: string) =>
    request<Idea>(`/ideas/${ideaId}/decision`, {
      method: "PATCH",
      body: JSON.stringify(note === undefined ? { decision } : { decision, note }),
    }),
  exportUrl: (id: string, format: "md" | "json") =>
    `${BASE}/sessions/${id}/export?format=${format}`,
};

export interface StreamHandlers {
  onEvent: (event: StreamEvent) => void;
  /** Transient streaming state (tokens, logs) must be reset here (reconnect rule). */
  onReset: () => void;
  onError?: (message: string) => void;
}

/**
 * Subscribe to a session's SSE stream.
 *
 * Pitfall-aware behavior:
 * - P5: never close on done/error events — only set a flag and let the server
 *   close the connection (a replay stream may still be delivering events).
 * - On unexpected disconnects, reconnect exactly once, resetting transient
 *   state first so re-seeded history does not duplicate logs.
 *
 * Returns an unsubscribe function.
 */
export function subscribeSession(id: string, handlers: StreamHandlers): () => void {
  let source: EventSource | null = null;
  let finished = false; // server signalled done/error
  let retried = false; // only one automatic reconnect is allowed
  let closedByCaller = false;

  const connect = () => {
    source = new EventSource(`${BASE}/sessions/${id}/stream`);
    source.onmessage = (message) => {
      let event: StreamEvent;
      try {
        event = JSON.parse(message.data) as StreamEvent;
      } catch {
        return;
      }
      if (
        event.type === "error" ||
        (event.type === "phase" && (event.phase === "done" || event.phase === "error"))
      ) {
        finished = true; // flag only — never close here (P5)
      }
      handlers.onEvent(event);
    };
    source.onerror = () => {
      // The browser fires onerror both for network drops and for the server's
      // deliberate close after the terminal event.
      if (closedByCaller) return;
      if (finished) {
        source?.close();
        return;
      }
      if (!retried) {
        retried = true;
        handlers.onReset();
        source?.close();
        connect();
        return;
      }
      source?.close();
      handlers.onError?.("Lost the connection to the session stream.");
    };
  };

  connect();
  return () => {
    closedByCaller = true;
    source?.close();
  };
}

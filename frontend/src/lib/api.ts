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

/** One safely parsed Pydantic validation issue returned by the API. */
export interface ApiValidationIssue {
  readonly location: readonly (string | number)[];
  readonly message: string;
  readonly type: string | null;
}

/** Structured HTTP failure with status and safely parsed validation issues. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly validationIssues: readonly ApiValidationIssue[];

  constructor(
    status: number,
    message: string,
    validationIssues: readonly ApiValidationIssue[] = []
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.validationIssues = validationIssues;
  }
}

function isApiErrorRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApiValidationLocationPart(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/** Safely parses FastAPI/Pydantic `detail[]` validation issues. */
export function parsePydanticValidationIssues(detail: unknown): ApiValidationIssue[] {
  if (!Array.isArray(detail)) return [];

  const issues: ApiValidationIssue[] = [];
  for (const value of detail) {
    if (!isApiErrorRecord(value) || typeof value.msg !== "string") continue;
    const message = value.msg.trim();
    if (message === "") continue;

    issues.push({
      location: Array.isArray(value.loc)
        ? value.loc.filter(isApiValidationLocationPart)
        : [],
      message,
      type: typeof value.type === "string" ? value.type : null,
    });
  }
  return issues;
}

/** Formats one API validation issue without coercing unknown objects to strings. */
export function formatApiValidationIssue(issue: ApiValidationIssue): string {
  const location =
    issue.location[0] === "body" ? issue.location.slice(1) : issue.location;
  const fieldPath = location.map(String).join(".");
  return fieldPath === "" ? issue.message : `${fieldPath}: ${issue.message}`;
}

const BASE = "/api";

function apiStatusLine(response: Response): string {
  const statusText = response.statusText.trim();
  return statusText === "" ? `HTTP ${response.status}` : `${response.status} ${statusText}`;
}

async function buildApiRequestError(response: Response): Promise<ApiRequestError> {
  const statusLine = apiStatusLine(response);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new ApiRequestError(response.status, statusLine);
  }

  if (!isApiErrorRecord(body)) {
    return new ApiRequestError(response.status, statusLine);
  }

  const validationIssues = parsePydanticValidationIssues(body.detail);
  if (validationIssues.length > 0) {
    return new ApiRequestError(
      response.status,
      validationIssues.map(formatApiValidationIssue).join("; "),
      validationIssues
    );
  }

  const detailMessage =
    typeof body.detail === "string" && body.detail.trim() !== ""
      ? body.detail.trim()
      : null;
  const bodyMessage =
    typeof body.message === "string" && body.message.trim() !== ""
      ? body.message.trim()
      : null;
  return new ApiRequestError(
    response.status,
    detailMessage ?? bodyMessage ?? statusLine
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) throw await buildApiRequestError(response);
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

/** Observable connection state for the Live session SSE subscription. */
export type SessionStreamConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "complete";

/** Callbacks for events, replay resets, and connection state from a session stream. */
export interface StreamHandlers {
  onEvent: (event: StreamEvent) => void;
  /** Transient streaming state (tokens, logs) must be reset before a reconnect replay. */
  onReset: () => void;
  onConnectionStateChange?: (state: SessionStreamConnectionState) => void;
  onError?: (message: string) => void;
}

function isSessionStreamRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSessionStreamNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSessionStreamIdeaScores(value: unknown): value is IdeaScores {
  return (
    isSessionStreamRecord(value) &&
    isSessionStreamNumber(value.novelty) &&
    isSessionStreamNumber(value.feasibility) &&
    isSessionStreamNumber(value.clarity) &&
    isSessionStreamNumber(value.total)
  );
}

function isSessionStreamIdea(value: unknown): value is Idea {
  return (
    isSessionStreamRecord(value) &&
    typeof value.id === "string" &&
    typeof value.session_id === "string" &&
    typeof value.persona_type === "string" &&
    (value.phase === "divergence" || value.phase === "discussion") &&
    typeof value.content === "string" &&
    (value.cluster_id === null || isSessionStreamNumber(value.cluster_id)) &&
    (value.synthesized === null || typeof value.synthesized === "string") &&
    (value.scores === null || isSessionStreamIdeaScores(value.scores)) &&
    (value.decision === "pending" ||
      value.decision === "adopted" ||
      value.decision === "held" ||
      value.decision === "rejected") &&
    typeof value.note === "string"
  );
}

function isSessionStreamMetrics(value: unknown): value is SessionMetrics {
  return (
    isSessionStreamRecord(value) &&
    isSessionStreamNumber(value.total_ideas) &&
    isSessionStreamNumber(value.unique_ideas) &&
    isSessionStreamNumber(value.non_duplicate_ratio) &&
    isSessionStreamNumber(value.semantic_dispersion) &&
    typeof value.collapse_alert === "boolean"
  );
}

/** Parses one frozen-contract SSE data payload, ignoring malformed or unknown events. */
export function parseSessionStreamEvent(data: string): StreamEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isSessionStreamRecord(value) || typeof value.type !== "string") return null;

  switch (value.type) {
    case "phase":
      return typeof value.phase === "string" &&
        (value.label === undefined || typeof value.label === "string")
        ? (value as StreamEvent)
        : null;
    case "agent_start":
      return typeof value.agent === "string" &&
        isSessionStreamNumber(value.round) &&
        typeof value.task === "string"
        ? (value as StreamEvent)
        : null;
    case "token":
      return typeof value.agent === "string" &&
        isSessionStreamNumber(value.round) &&
        typeof value.delta === "string"
        ? (value as StreamEvent)
        : null;
    case "agent_done":
      return typeof value.agent === "string" && isSessionStreamNumber(value.round)
        ? (value as StreamEvent)
        : null;
    case "idea":
      return isSessionStreamIdea(value.idea) ? (value as StreamEvent) : null;
    case "message":
      return isSessionStreamNumber(value.round) &&
        typeof value.from === "string" &&
        typeof value.content === "string"
        ? (value as StreamEvent)
        : null;
    case "metrics":
      return isSessionStreamMetrics(value.metrics) ? (value as StreamEvent) : null;
    case "error":
      return typeof value.message === "string" ? (value as StreamEvent) : null;
    default:
      return null;
  }
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
 * Returns an idempotent unsubscribe function that detaches every EventSource handler.
 */
export function subscribeSession(id: string, handlers: StreamHandlers): () => void {
  let source: EventSource | null = null;
  let finished = false; // server signalled done/error
  let retried = false; // only one automatic reconnect is allowed
  let closedByCaller = false;
  let connectionState: SessionStreamConnectionState | null = null;

  const setConnectionState = (nextState: SessionStreamConnectionState) => {
    if (connectionState === nextState || closedByCaller) return;
    connectionState = nextState;
    handlers.onConnectionStateChange?.(nextState);
  };

  const closeSource = (connectedSource: EventSource) => {
    connectedSource.onopen = null;
    connectedSource.onmessage = null;
    connectedSource.onerror = null;
    connectedSource.close();
    if (source === connectedSource) source = null;
  };

  const connect = (openingState: "connecting" | "reconnecting") => {
    if (closedByCaller) return;
    setConnectionState(openingState);

    let connectedSource: EventSource;
    try {
      connectedSource = new EventSource(`${BASE}/sessions/${id}/stream`);
    } catch {
      setConnectionState("disconnected");
      handlers.onError?.("Could not open the session stream.");
      return;
    }
    source = connectedSource;
    connectedSource.onopen = () => {
      if (!closedByCaller && source === connectedSource) setConnectionState("connected");
    };
    connectedSource.onmessage = (message) => {
      if (closedByCaller || source !== connectedSource) return;
      const event = parseSessionStreamEvent(message.data);
      if (event === null) return;
      if (
        event.type === "error" ||
        (event.type === "phase" && (event.phase === "done" || event.phase === "error"))
      ) {
        finished = true; // flag only — never close here (P5)
      }
      handlers.onEvent(event);
    };
    connectedSource.onerror = () => {
      // The browser fires onerror both for network drops and for the server's
      // deliberate close after the terminal event.
      if (closedByCaller || source !== connectedSource) return;
      if (finished) {
        closeSource(connectedSource);
        setConnectionState("complete");
        return;
      }
      if (!retried) {
        retried = true;
        handlers.onReset();
        closeSource(connectedSource);
        connect("reconnecting");
        return;
      }
      closeSource(connectedSource);
      setConnectionState("disconnected");
      handlers.onError?.("Lost the connection to the session stream.");
    };
  };

  connect("connecting");
  return () => {
    if (closedByCaller) return;
    closedByCaller = true;
    if (source !== null) closeSource(source);
  };
}

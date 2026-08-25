import type { Decision, Idea, Session } from "./api";

/** The explicit decision filters available in the Results decision workspace. */
export type ResultsDecisionFilter = "all" | Decision;

/** Labels and stable ordering shared by Results decision counts and filter controls. */
export const RESULTS_DECISION_FILTER_OPTIONS: readonly {
  id: ResultsDecisionFilter;
  label: string;
}[] = [
  { id: "all", label: "All" },
  { id: "pending", label: "Pending" },
  { id: "adopted", label: "Adopted" },
  { id: "held", label: "Held" },
  { id: "rejected", label: "Rejected" },
];

/** Counts every Results idea once, with `all` equal to the sum of decision counts. */
export type ResultsDecisionCounts = Record<ResultsDecisionFilter, number>;

/** A stable cluster identity that also represents ideas not yet assigned to a cluster. */
export type ResultsClusterKey = `cluster:${number}` | "cluster:unclustered";

/** A Results cluster containing only filter matches plus its unfiltered total. */
export interface ResultsDecisionCluster {
  key: ResultsClusterKey;
  id: number | null;
  ideas: Idea[];
  synthesized: string | null;
  matchingIdeaCount: number;
  totalIdeaCount: number;
}

/** Single-pass derived data for decision counts, filtering, and cluster visibility. */
export interface ResultsDecisionWorkspaceDerivedState {
  counts: ResultsDecisionCounts;
  visibleClusters: ResultsDecisionCluster[];
  totalClusterCount: number;
}

/** Active filter interaction state for the Results decision workspace. */
export interface ResultsDecisionWorkspaceInteractionState {
  activeFilter: ResultsDecisionFilter;
}

/** User interactions supported by the Results decision filter controls. */
export type ResultsDecisionWorkspaceAction =
  | { type: "workspace-reset" }
  | { type: "decision-filter-selected"; filter: ResultsDecisionFilter };

/** The exact decision and optional memo sent through the frozen decision API contract. */
export interface ResultsIdeaDecisionAttempt {
  decision: Decision;
  note?: string;
}

/** Per-idea persistence feedback retained even when filtering temporarily removes a card. */
export type ResultsIdeaSaveState =
  | { status: "saving"; attempt: ResultsIdeaDecisionAttempt }
  | {
      status: "recovering";
      attempt: ResultsIdeaDecisionAttempt;
      message: string;
    }
  | { status: "saved" }
  | {
      status: "error";
      attempt: ResultsIdeaDecisionAttempt;
      message: string;
      /** Field-specific Results memo error mapped from a 422 `note` location. */
      memoError?: string | null;
    };

const SESSION_RESULTS_FAILURE_REASON_FALLBACK =
  "The session ended unexpectedly; no reliable failure detail was recorded.";
const SESSION_RESULTS_NON_FAILURE_PROGRESS = new Set([
  "framing",
  "structuring goal and rules",
  "divergence",
  "independent divergence",
  "independent idea generation",
  "discussion",
  "collaborative discussion",
  "anonymous collaborative discussion",
  "convergence",
  "dedup, synthesis and scoring",
  "done",
  "session completed",
  "error",
  "session failed",
]);

/** Loading, load-error, active, completed, and terminal-failure Results branches. */
export type SessionResultsAvailability =
  | { kind: "load-error"; message: string }
  | { kind: "loading" }
  | { kind: "ready"; running: boolean; empty: boolean }
  | { kind: "failed"; reason: string; empty: boolean };

/** Creates a Results decision workspace with the All filter selected. */
export function createResultsDecisionWorkspaceState(): ResultsDecisionWorkspaceInteractionState {
  return { activeFilter: "all" };
}

/** Returns the stable key used by cluster expansion controls and React rendering. */
export function getResultsClusterKey(clusterId: number | null): ResultsClusterKey {
  return clusterId === null ? "cluster:unclustered" : `cluster:${clusterId}`;
}

/** Reduces Results decision filter controls without mutating prior state. */
export function reduceResultsDecisionWorkspaceState(
  state: ResultsDecisionWorkspaceInteractionState,
  action: ResultsDecisionWorkspaceAction
): ResultsDecisionWorkspaceInteractionState {
  switch (action.type) {
    case "workspace-reset":
      return createResultsDecisionWorkspaceState();
    case "decision-filter-selected":
      return { ...state, activeFilter: action.filter };
  }
}

/**
 * Derives Results decision counts and filtered clusters in one pass over ideas.
 *
 * Input order is retained inside each cluster; numbered clusters sort ascending and
 * the unclustered group sorts last. The input array and ideas are never mutated.
 */
export function deriveResultsDecisionWorkspace(
  ideas: readonly Idea[],
  activeFilter: ResultsDecisionFilter
): ResultsDecisionWorkspaceDerivedState {
  const counts: ResultsDecisionCounts = {
    all: 0,
    pending: 0,
    adopted: 0,
    held: 0,
    rejected: 0,
  };
  const clustersById = new Map<
    number | null,
    {
      key: ResultsClusterKey;
      id: number | null;
      ideas: Idea[];
      synthesized: string | null;
      totalIdeaCount: number;
    }
  >();

  for (const idea of ideas) {
    counts.all += 1;
    counts[idea.decision] += 1;

    let cluster = clustersById.get(idea.cluster_id);
    if (cluster === undefined) {
      cluster = {
        key: getResultsClusterKey(idea.cluster_id),
        id: idea.cluster_id,
        ideas: [],
        synthesized: null,
        totalIdeaCount: 0,
      };
      clustersById.set(idea.cluster_id, cluster);
    }

    cluster.totalIdeaCount += 1;
    if (cluster.synthesized === null && idea.synthesized) {
      cluster.synthesized = idea.synthesized;
    }
    if (activeFilter === "all" || idea.decision === activeFilter) {
      cluster.ideas.push(idea);
    }
  }

  const visibleClusters = [...clustersById.values()]
    .filter((cluster) => cluster.ideas.length > 0)
    .sort((left, right) => {
      if (left.id === null) return right.id === null ? 0 : 1;
      if (right.id === null) return -1;
      return left.id - right.id;
    })
    .map((cluster) => ({
      ...cluster,
      matchingIdeaCount: cluster.ideas.length,
    }));

  return {
    counts,
    visibleClusters,
    totalClusterCount: clustersById.size,
  };
}

/** Applies a decision attempt to frontend state without changing the API payload shape. */
export function applyResultsIdeaDecisionAttempt(
  idea: Idea,
  attempt: ResultsIdeaDecisionAttempt
): Idea {
  return {
    ...idea,
    decision: attempt.decision,
    note: attempt.note === undefined ? idea.note : attempt.note,
  };
}

/** Replaces one Results idea while preserving array order for stable cluster rendering. */
export function replaceResultsIdea(
  ideas: readonly Idea[],
  replacement: Idea
): Idea[] {
  return ideas.map((idea) => (idea.id === replacement.id ? replacement : idea));
}

/**
 * Returns a bounded plain-text failure reason, or a generic fallback for phase
 * labels, empty values, control-only content, and markup-like untrusted text.
 */
export function getSessionResultsFailureReason(phaseProgress: unknown): string {
  if (typeof phaseProgress !== "string") return SESSION_RESULTS_FAILURE_REASON_FALLBACK;

  const plainTextReason = phaseProgress
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedProgress = plainTextReason.toLowerCase().replace(/[._-]+/g, " ");
  const phaseLabelOnly =
    SESSION_RESULTS_NON_FAILURE_PROGRESS.has(normalizedProgress) ||
    /^(?:phase\s*:?\s*)?(?:framing|divergence|discussion|convergence|done|error)(?:\s+phase)?$/.test(
      normalizedProgress
    );

  if (plainTextReason === "" || phaseLabelOnly || /[<>]/.test(plainTextReason)) {
    return SESSION_RESULTS_FAILURE_REASON_FALLBACK;
  }

  const maximumReasonLength = 240;
  return plainTextReason.length > maximumReasonLength
    ? `${plainTextReason.slice(0, maximumReasonLength - 1).trimEnd()}…`
    : plainTextReason;
}

/** Selects Results loading, load-error, running, done, and terminal-failure states. */
export function deriveSessionResultsAvailability(
  session: Pick<Session, "status" | "phase_progress"> | null,
  ideas: readonly Idea[] | null,
  error: string | null
): SessionResultsAvailability {
  if (error !== null) return { kind: "load-error", message: error };
  if (session === null || ideas === null) return { kind: "loading" };
  if (session.status === "error") {
    return {
      kind: "failed",
      reason: getSessionResultsFailureReason(session.phase_progress),
      empty: ideas.length === 0,
    };
  }
  return {
    kind: "ready",
    running: session.status !== "done",
    empty: ideas.length === 0,
  };
}

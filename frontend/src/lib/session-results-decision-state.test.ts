import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { Decision, Idea, SessionStatus } from "./api";
import {
  applyResultsIdeaDecisionAttempt,
  createResultsDecisionWorkspaceState,
  deriveResultsDecisionWorkspace,
  deriveSessionResultsAvailability,
  getSessionResultsFailureReason,
  reduceResultsDecisionWorkspaceState,
  replaceResultsIdea,
} from "./session-results-decision-state";

function makeResultsIdea(
  id: string,
  decision: Decision,
  clusterId: number | null,
  synthesized: string | null = null
): Idea {
  return {
    id,
    session_id: "session-1",
    persona_type: "ARCHITECT",
    phase: "divergence",
    content: `Idea ${id}`,
    cluster_id: clusterId,
    synthesized,
    scores: null,
    decision,
    note: "",
  };
}

describe("Results decision workspace derived state", () => {
  test("synchronizes counts with filtered cluster matches and unfiltered totals", () => {
    const ideas = [
      makeResultsIdea("pending-1", "pending", 1, "Cluster one synthesis"),
      makeResultsIdea("adopted-1", "adopted", 1),
      makeResultsIdea("adopted-2", "adopted", 2),
      makeResultsIdea("rejected-1", "rejected", null),
    ];

    const derived = deriveResultsDecisionWorkspace(ideas, "adopted");

    assert.deepEqual(derived.counts, {
      all: 4,
      pending: 1,
      adopted: 2,
      held: 0,
      rejected: 1,
    });
    assert.equal(derived.totalClusterCount, 3);
    assert.deepEqual(
      derived.visibleClusters.map((cluster) => ({
        id: cluster.id,
        matches: cluster.matchingIdeaCount,
        total: cluster.totalIdeaCount,
        ideaIds: cluster.ideas.map((idea) => idea.id),
        synthesized: cluster.synthesized,
      })),
      [
        {
          id: 1,
          matches: 1,
          total: 2,
          ideaIds: ["adopted-1"],
          synthesized: "Cluster one synthesis",
        },
        { id: 2, matches: 1, total: 1, ideaIds: ["adopted-2"], synthesized: null },
      ]
    );
  });

  test("updates filter visibility immediately and restores it on optimistic rollback", () => {
    const originalIdea = makeResultsIdea("idea-1", "pending", 7);
    const originalIdeas = [originalIdea];
    const optimisticIdea = applyResultsIdeaDecisionAttempt(originalIdea, {
      decision: "adopted",
      note: "Pilot next week",
    });
    const optimisticIdeas = replaceResultsIdea(originalIdeas, optimisticIdea);

    assert.equal(deriveResultsDecisionWorkspace(optimisticIdeas, "pending").counts.pending, 0);
    assert.deepEqual(deriveResultsDecisionWorkspace(optimisticIdeas, "pending").visibleClusters, []);
    assert.equal(deriveResultsDecisionWorkspace(optimisticIdeas, "adopted").counts.adopted, 1);
    assert.equal(
      deriveResultsDecisionWorkspace(optimisticIdeas, "adopted").visibleClusters[0]?.ideas[0]
        ?.note,
      "Pilot next week"
    );

    const rolledBackIdeas = replaceResultsIdea(optimisticIdeas, originalIdea);
    assert.equal(deriveResultsDecisionWorkspace(rolledBackIdeas, "pending").counts.pending, 1);
    assert.equal(
      deriveResultsDecisionWorkspace(rolledBackIdeas, "pending").visibleClusters[0]?.key,
      "cluster:7"
    );
    assert.deepEqual(originalIdeas, [originalIdea]);
  });

  test("derives long sessions repeatedly without input mutation or ordering drift", () => {
    const decisions: Decision[] = ["pending", "adopted", "held", "rejected"];
    const ideas = Object.freeze(
      Array.from({ length: 12_000 }, (_, index) =>
        makeResultsIdea(
          `idea-${index}`,
          decisions[index % decisions.length] ?? "pending",
          index % 120
        )
      )
    );
    const first = deriveResultsDecisionWorkspace(ideas, "held");
    const second = deriveResultsDecisionWorkspace(ideas, "held");

    assert.deepEqual(second, first);
    assert.equal(first.counts.all, 12_000);
    assert.equal(first.counts.held, 3_000);
    assert.equal(first.visibleClusters.reduce((sum, cluster) => sum + cluster.matchingIdeaCount, 0), 3_000);
    assert.equal(ideas[0]?.id, "idea-0");
    assert.equal(ideas[11_999]?.id, "idea-11999");
  });
});

describe("Results decision workspace interactions", () => {
  test("selects a decision filter and resets it for a reloaded workspace", () => {
    let state = createResultsDecisionWorkspaceState();

    state = reduceResultsDecisionWorkspaceState(state, {
      type: "decision-filter-selected",
      filter: "adopted",
    });
    assert.equal(state.activeFilter, "adopted");

    state = reduceResultsDecisionWorkspaceState(state, { type: "workspace-reset" });
    assert.deepEqual(state, { activeFilter: "all" });
  });
});

describe("Results page availability regression states", () => {
  const session = (status: SessionStatus, phaseProgress = "") => ({
    status,
    phase_progress: phaseProgress,
  });

  test("preserves load error precedence and partial loading", () => {
    assert.deepEqual(deriveSessionResultsAvailability(null, null, "Network unavailable"), {
      kind: "load-error",
      message: "Network unavailable",
    });
    assert.deepEqual(deriveSessionResultsAvailability(session("done"), null, null), {
      kind: "loading",
    });
    assert.deepEqual(deriveSessionResultsAvailability(null, [], null), { kind: "loading" });
  });

  test("makes an error-empty session a terminal failure with its recorded reason", () => {
    assert.deepEqual(
      deriveSessionResultsAvailability(
        session("error", "Provider authentication failed"),
        [],
        null
      ),
      {
        kind: "failed",
        reason: "Provider authentication failed",
        empty: true,
      }
    );
  });

  test("keeps partial ideas available without treating an error session as running", () => {
    assert.deepEqual(
      deriveSessionResultsAvailability(
        session("error", "Convergence provider timed out"),
        [makeResultsIdea("partial", "pending", null)],
        null
      ),
      {
        kind: "failed",
        reason: "Convergence provider timed out",
        empty: false,
      }
    );
  });

  test("keeps a normal empty completed session distinct from failure", () => {
    assert.deepEqual(deriveSessionResultsAvailability(session("done"), [], null), {
      kind: "ready",
      running: false,
      empty: true,
    });
  });

  test("identifies a nonterminal session as running", () => {
    assert.deepEqual(
      deriveSessionResultsAvailability(
        session("discussion", "Anonymous collaborative discussion"),
        [makeResultsIdea("running", "pending", null)],
        null
      ),
      { kind: "ready", running: true, empty: false }
    );
  });

  test("identifies a completed session with ideas as done", () => {
    assert.deepEqual(
      deriveSessionResultsAvailability(
        session("done", "Session completed"),
        [makeResultsIdea("done", "pending", 1)],
        null
      ),
      { kind: "ready", running: false, empty: false }
    );
  });

  test("falls back for empty, phase-label, and markup-like failure progress", () => {
    const fallback =
      "The session ended unexpectedly; no reliable failure detail was recorded.";

    assert.equal(getSessionResultsFailureReason(""), fallback);
    assert.equal(getSessionResultsFailureReason("Convergence"), fallback);
    assert.equal(
      getSessionResultsFailureReason("Dedup, synthesis and scoring"),
      fallback
    );
    assert.equal(
      getSessionResultsFailureReason('<img src=x onerror="alert(1)">'),
      fallback
    );
    assert.equal(
      getSessionResultsFailureReason("Provider\nauthentication\u0000 failed"),
      "Provider authentication failed"
    );
  });
});

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { Idea } from "./api";
import {
  createResultsClusterDisclosureState,
  isResultsClusterExpanded,
  reduceResultsClusterDisclosureState,
} from "./session-results-cluster-disclosure-state";
import {
  applyResultsIdeaDecisionAttempt,
  deriveResultsDecisionWorkspace,
} from "./session-results-decision-state";

function makePendingIdea(id: string, clusterId: number): Idea {
  return {
    id,
    session_id: "session-1",
    persona_type: "ARCHITECT",
    phase: "divergence",
    content: `Idea ${id}`,
    cluster_id: clusterId,
    synthesized: null,
    scores: null,
    decision: "pending",
    note: "",
  };
}

function reconcileMatchingClusters(
  state: ReturnType<typeof createResultsClusterDisclosureState>,
  clusterKeys: readonly (`cluster:${number}` | "cluster:unclustered")[]
) {
  return reduceResultsClusterDisclosureState(state, {
    type: "matching-clusters-changed",
    clusterKeys,
  });
}

describe("Results cluster progressive disclosure", () => {
  test("initial load expands only the first matching cluster in stable order", () => {
    const ideas = [
      makePendingIdea("cluster-9", 9),
      makePendingIdea("cluster-2", 2),
      makePendingIdea("cluster-5", 5),
    ];
    const matchingClusterKeys = deriveResultsDecisionWorkspace(
      ideas,
      "all"
    ).visibleClusters.map((cluster) => cluster.key);

    const state = reconcileMatchingClusters(
      createResultsClusterDisclosureState(),
      matchingClusterKeys
    );

    assert.deepEqual(matchingClusterKeys, ["cluster:2", "cluster:5", "cluster:9"]);
    assert.equal(isResultsClusterExpanded(state, "cluster:2"), true);
    assert.equal(isResultsClusterExpanded(state, "cluster:5"), false);
    assert.equal(isResultsClusterExpanded(state, "cluster:9"), false);
    assert.equal(state.automaticallyExpandedClusterKey, "cluster:2");
  });

  test("initial load with zero matching clusters is safe", () => {
    const state = reconcileMatchingClusters(
      createResultsClusterDisclosureState(),
      []
    );

    assert.deepEqual(state.matchingClusterKeys, []);
    assert.equal(state.expandedClusterKeys.size, 0);
    assert.equal(state.automaticallyExpandedClusterKey, null);
  });

  test("filter changes move the automatic expansion and preserve visible manual choices", () => {
    let state = reconcileMatchingClusters(
      createResultsClusterDisclosureState(),
      ["cluster:1", "cluster:2", "cluster:3"]
    );

    state = reduceResultsClusterDisclosureState(state, {
      type: "cluster-toggled",
      clusterKey: "cluster:3",
    });
    state = reconcileMatchingClusters(state, ["cluster:2", "cluster:3"]);

    assert.equal(isResultsClusterExpanded(state, "cluster:1"), false);
    assert.equal(isResultsClusterExpanded(state, "cluster:2"), false);
    assert.equal(isResultsClusterExpanded(state, "cluster:3"), true);
    assert.equal(state.automaticallyExpandedClusterKey, null);

    state = reconcileMatchingClusters(state, ["cluster:4", "cluster:5"]);
    assert.equal(isResultsClusterExpanded(state, "cluster:4"), true);
    assert.equal(isResultsClusterExpanded(state, "cluster:5"), false);
    assert.equal(state.automaticallyExpandedClusterKey, "cluster:4");

    state = reconcileMatchingClusters(state, ["cluster:2", "cluster:3"]);
    assert.equal(isResultsClusterExpanded(state, "cluster:3"), true);
    assert.equal(isResultsClusterExpanded(state, "cluster:2"), false);
  });

  test("decision changes auto-expand the new first match when the active cluster disappears", () => {
    const firstIdea = makePendingIdea("first", 1);
    const secondIdea = makePendingIdea("second", 2);
    const pendingClusterKeys = deriveResultsDecisionWorkspace(
      [firstIdea, secondIdea],
      "pending"
    ).visibleClusters.map((cluster) => cluster.key);
    let state = reconcileMatchingClusters(
      createResultsClusterDisclosureState(),
      pendingClusterKeys
    );

    const adoptedFirstIdea = applyResultsIdeaDecisionAttempt(firstIdea, {
      decision: "adopted",
    });
    const nextPendingClusterKeys = deriveResultsDecisionWorkspace(
      [adoptedFirstIdea, secondIdea],
      "pending"
    ).visibleClusters.map((cluster) => cluster.key);
    state = reconcileMatchingClusters(state, nextPendingClusterKeys);

    assert.deepEqual(nextPendingClusterKeys, ["cluster:2"]);
    assert.equal(isResultsClusterExpanded(state, "cluster:1"), false);
    assert.equal(isResultsClusterExpanded(state, "cluster:2"), true);
  });

  test("reset reinitializes the first expansion for reloads and new sessions", () => {
    let state = reconcileMatchingClusters(
      createResultsClusterDisclosureState(),
      ["cluster:1", "cluster:2"]
    );
    state = reduceResultsClusterDisclosureState(state, {
      type: "matching-clusters-expanded",
      clusterKeys: ["cluster:1", "cluster:2"],
    });
    assert.equal(isResultsClusterExpanded(state, "cluster:1"), true);
    assert.equal(isResultsClusterExpanded(state, "cluster:2"), true);
    assert.equal(state.automaticallyExpandedClusterKey, null);

    state = reduceResultsClusterDisclosureState(state, {
      type: "cluster-disclosure-reset",
    });
    assert.equal(state.matchingClusterKeys, null);
    assert.equal(state.expandedClusterKeys.size, 0);

    state = reconcileMatchingClusters(state, ["cluster:7", "cluster:8"]);
    assert.equal(isResultsClusterExpanded(state, "cluster:7"), true);
    assert.equal(isResultsClusterExpanded(state, "cluster:8"), false);
  });

  test("Collapse all suppresses automatic reopening until explicit expansion", () => {
    let state = reconcileMatchingClusters(
      createResultsClusterDisclosureState(),
      ["cluster:1", "cluster:2"]
    );
    state = reduceResultsClusterDisclosureState(state, {
      type: "matching-clusters-collapsed",
      clusterKeys: ["cluster:1", "cluster:2"],
    });
    state = reconcileMatchingClusters(state, ["cluster:2", "cluster:3"]);

    assert.equal(state.automaticExpansionSuppressed, true);
    assert.equal(isResultsClusterExpanded(state, "cluster:2"), false);
    assert.equal(isResultsClusterExpanded(state, "cluster:3"), false);

    state = reduceResultsClusterDisclosureState(state, {
      type: "cluster-toggled",
      clusterKey: "cluster:3",
    });
    assert.equal(state.automaticExpansionSuppressed, false);
    assert.equal(isResultsClusterExpanded(state, "cluster:3"), true);

    state = reconcileMatchingClusters(state, ["cluster:4"]);
    assert.equal(isResultsClusterExpanded(state, "cluster:4"), true);
  });

  test("individual collapse remains stable when the matching cluster list is unchanged", () => {
    let state = reconcileMatchingClusters(
      createResultsClusterDisclosureState(),
      ["cluster:1", "cluster:2"]
    );
    state = reduceResultsClusterDisclosureState(state, {
      type: "cluster-toggled",
      clusterKey: "cluster:1",
    });
    const collapsedState = state;

    state = reconcileMatchingClusters(state, ["cluster:1", "cluster:2"]);

    assert.equal(state, collapsedState);
    assert.equal(isResultsClusterExpanded(state, "cluster:1"), false);
    assert.equal(isResultsClusterExpanded(state, "cluster:2"), false);
  });
});

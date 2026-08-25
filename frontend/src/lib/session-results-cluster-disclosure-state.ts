import type { ResultsClusterKey } from "./session-results-decision-state";

/** Progressive-disclosure state for the ordered clusters matching the active filter. */
export interface ResultsClusterDisclosureState {
  matchingClusterKeys: readonly ResultsClusterKey[] | null;
  expandedClusterKeys: ReadonlySet<ResultsClusterKey>;
  automaticallyExpandedClusterKey: ResultsClusterKey | null;
  automaticExpansionSuppressed: boolean;
}

/** User and data-change events supported by Results cluster disclosure controls. */
export type ResultsClusterDisclosureAction =
  | { type: "cluster-disclosure-reset" }
  | {
      type: "matching-clusters-changed";
      clusterKeys: readonly ResultsClusterKey[];
    }
  | { type: "cluster-toggled"; clusterKey: ResultsClusterKey }
  | {
      type: "matching-clusters-expanded";
      clusterKeys: readonly ResultsClusterKey[];
    }
  | {
      type: "matching-clusters-collapsed";
      clusterKeys: readonly ResultsClusterKey[];
    };

/** Reports whether the ordered matching cluster identities are unchanged. */
function haveSameOrderedClusterKeys(
  previousKeys: readonly ResultsClusterKey[] | null,
  nextKeys: readonly ResultsClusterKey[]
): boolean {
  return (
    previousKeys !== null &&
    previousKeys.length === nextKeys.length &&
    previousKeys.every((clusterKey, index) => clusterKey === nextKeys[index])
  );
}

/** Creates an uninitialized disclosure state that is safe before zero or more clusters load. */
export function createResultsClusterDisclosureState(): ResultsClusterDisclosureState {
  return {
    matchingClusterKeys: null,
    expandedClusterKeys: new Set<ResultsClusterKey>(),
    automaticallyExpandedClusterKey: null,
    automaticExpansionSuppressed: false,
  };
}

/**
 * Reconciles ordered matching clusters while preserving manual choices.
 *
 * The first load expands only the first key. Later visibility changes move an
 * automatic expansion only when no manually expanded matching cluster remains.
 * A manual Collapse all suppresses that fallback until the user expands a cluster.
 */
export function reconcileResultsClusterDisclosure(
  state: ResultsClusterDisclosureState,
  matchingClusterKeys: readonly ResultsClusterKey[]
): ResultsClusterDisclosureState {
  if (haveSameOrderedClusterKeys(state.matchingClusterKeys, matchingClusterKeys)) {
    return state;
  }

  const firstMatchingClusterKey = matchingClusterKeys[0] ?? null;
  if (state.matchingClusterKeys === null) {
    return {
      matchingClusterKeys: [...matchingClusterKeys],
      expandedClusterKeys: new Set(
        firstMatchingClusterKey === null ? [] : [firstMatchingClusterKey]
      ),
      automaticallyExpandedClusterKey: firstMatchingClusterKey,
      automaticExpansionSuppressed: false,
    };
  }

  const matchingClusterKeySet = new Set(matchingClusterKeys);
  const expandedClusterKeys = new Set(state.expandedClusterKeys);
  let automaticallyExpandedClusterKey = state.automaticallyExpandedClusterKey;

  if (
    automaticallyExpandedClusterKey !== null &&
    !matchingClusterKeySet.has(automaticallyExpandedClusterKey)
  ) {
    expandedClusterKeys.delete(automaticallyExpandedClusterKey);
    automaticallyExpandedClusterKey = null;
  }

  const hasExpandedMatchingCluster = matchingClusterKeys.some((clusterKey) =>
    expandedClusterKeys.has(clusterKey)
  );
  if (
    !hasExpandedMatchingCluster &&
    !state.automaticExpansionSuppressed &&
    firstMatchingClusterKey !== null
  ) {
    expandedClusterKeys.add(firstMatchingClusterKey);
    automaticallyExpandedClusterKey = firstMatchingClusterKey;
  }

  return {
    ...state,
    matchingClusterKeys: [...matchingClusterKeys],
    expandedClusterKeys,
    automaticallyExpandedClusterKey,
  };
}

/** Reduces Results cluster disclosure without mutating prior Set or array state. */
export function reduceResultsClusterDisclosureState(
  state: ResultsClusterDisclosureState,
  action: ResultsClusterDisclosureAction
): ResultsClusterDisclosureState {
  switch (action.type) {
    case "cluster-disclosure-reset":
      return createResultsClusterDisclosureState();
    case "matching-clusters-changed":
      return reconcileResultsClusterDisclosure(state, action.clusterKeys);
    case "cluster-toggled": {
      const expandedClusterKeys = new Set(state.expandedClusterKeys);
      if (expandedClusterKeys.has(action.clusterKey)) {
        expandedClusterKeys.delete(action.clusterKey);
        return {
          ...state,
          expandedClusterKeys,
          automaticallyExpandedClusterKey:
            state.automaticallyExpandedClusterKey === action.clusterKey
              ? null
              : state.automaticallyExpandedClusterKey,
        };
      }

      expandedClusterKeys.add(action.clusterKey);
      return {
        ...state,
        expandedClusterKeys,
        automaticallyExpandedClusterKey:
          state.automaticallyExpandedClusterKey === action.clusterKey
            ? null
            : state.automaticallyExpandedClusterKey,
        automaticExpansionSuppressed: false,
      };
    }
    case "matching-clusters-expanded": {
      const expandedClusterKeys = new Set(state.expandedClusterKeys);
      const explicitlyExpandedClusterKeys = new Set(action.clusterKeys);
      for (const clusterKey of action.clusterKeys) expandedClusterKeys.add(clusterKey);
      return {
        ...state,
        expandedClusterKeys,
        automaticallyExpandedClusterKey:
          state.automaticallyExpandedClusterKey !== null &&
          explicitlyExpandedClusterKeys.has(state.automaticallyExpandedClusterKey)
            ? null
            : state.automaticallyExpandedClusterKey,
        automaticExpansionSuppressed: false,
      };
    }
    case "matching-clusters-collapsed": {
      const expandedClusterKeys = new Set(state.expandedClusterKeys);
      for (const clusterKey of action.clusterKeys) expandedClusterKeys.delete(clusterKey);
      if (state.automaticallyExpandedClusterKey !== null) {
        expandedClusterKeys.delete(state.automaticallyExpandedClusterKey);
      }
      return {
        ...state,
        expandedClusterKeys,
        automaticallyExpandedClusterKey: null,
        automaticExpansionSuppressed: true,
      };
    }
  }
}

/** Reports whether one Results cluster is currently expanded. */
export function isResultsClusterExpanded(
  state: ResultsClusterDisclosureState,
  clusterKey: ResultsClusterKey
): boolean {
  return state.expandedClusterKeys.has(clusterKey);
}

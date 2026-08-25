import { useCallback, useLayoutEffect, useReducer, useRef } from "react";

import type { ResultsClusterKey } from "./session-results-decision-state";

/** Stable DOM id for the Results zero-state action used by focus recovery. */
export const SESSION_RESULTS_CLEAR_FILTER_CONTROL_ID =
  "session-results-clear-filter-control";

/** Stable DOM id for the Results Expand all disclosure control. */
export const SESSION_RESULTS_EXPAND_ALL_CONTROL_ID =
  "session-results-expand-all-control";

/** Stable DOM id for the Results Collapse all disclosure control. */
export const SESSION_RESULTS_COLLAPSE_ALL_CONTROL_ID =
  "session-results-collapse-all-control";

const SESSION_RESULTS_FOCUS_REGION_SELECTOR =
  "[data-session-results-focus-region]";
const SESSION_RESULTS_EXPANDED_CLUSTER_HEADER_SELECTOR =
  '[data-session-results-cluster-header][aria-expanded="true"]';
const MAXIMUM_SESSION_RESULTS_FOCUS_ATTEMPTS = 3;

/** Returns the stable, searchable DOM id for one Results cluster header. */
export function getSessionResultsClusterHeaderId(
  clusterKey: ResultsClusterKey
): string {
  const domKey =
    clusterKey === "cluster:unclustered"
      ? "unclustered"
      : clusterKey.slice("cluster:".length).replace("-", "negative-");
  return `session-results-cluster-${domKey}-header`;
}

type SessionResultsFocusRecoveryRequest =
  | {
      kind: "content-update";
      sourceElement: HTMLElement;
    }
  | {
      kind: "disclosure-control";
      sourceElement: HTMLElement;
      targetControlId: string;
    };

interface ScheduledAnimationFrame {
  id: number;
  view: Window;
}

/** Focus preparation callbacks for Results content and disclosure state updates. */
export interface SessionResultsFocusRecoveryControls {
  /** Records focus only when it is inside a Results card, cluster, or zero state. */
  prepareSessionResultsContentFocus: () => void;
  /** Keeps bulk disclosure focus on the meaningful control after its state update. */
  prepareSessionResultsDisclosureControlFocus: (targetControlId: string) => void;
}

function getActiveSessionResultsElement(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
}

function findSessionResultsContentFocusTarget(
  preferredTargetId: string | null
): HTMLElement | null {
  if (typeof document === "undefined") return null;

  if (preferredTargetId !== null) {
    const preferredTarget = document.getElementById(preferredTargetId);
    if (preferredTarget instanceof HTMLElement) return preferredTarget;
  }

  const expandedClusterHeader = document.querySelector(
    SESSION_RESULTS_EXPANDED_CLUSTER_HEADER_SELECTOR
  );
  if (expandedClusterHeader instanceof HTMLElement) return expandedClusterHeader;

  const clearFilterControl = document.getElementById(
    SESSION_RESULTS_CLEAR_FILTER_CONTROL_ID
  );
  return clearFilterControl instanceof HTMLElement ? clearFilterControl : null;
}

/**
 * Recovers Results focus after React commits a content or disclosure update.
 *
 * Content recovery is armed only from a card, cluster, or zero-state control. If
 * that focus survives the update, or the user moves elsewhere, it is left alone.
 * A bounded animation-frame retry crosses disclosure reconciliation commits and
 * is cancelled on rerender/unmount, including StrictMode effect replay.
 */
export function useSessionResultsFocusRecovery(
  contentFocusTargetId: string | null
): SessionResultsFocusRecoveryControls {
  const pendingRequestRef = useRef<SessionResultsFocusRecoveryRequest | null>(null);
  const scheduledAnimationFrameRef = useRef<ScheduledAnimationFrame | null>(null);
  const [, requestFocusRecoveryRender] = useReducer((version: number) => version + 1, 0);

  const cancelScheduledSessionResultsFocus = useCallback(() => {
    const scheduledFrame = scheduledAnimationFrameRef.current;
    if (scheduledFrame === null) return;
    scheduledFrame.view.cancelAnimationFrame(scheduledFrame.id);
    scheduledAnimationFrameRef.current = null;
  }, []);

  const clearSessionResultsFocusRequest = useCallback(() => {
    pendingRequestRef.current = null;
    cancelScheduledSessionResultsFocus();
  }, [cancelScheduledSessionResultsFocus]);

  const prepareSessionResultsContentFocus = useCallback(() => {
    const activeElement = getActiveSessionResultsElement();
    if (
      activeElement === null ||
      activeElement.closest(SESSION_RESULTS_FOCUS_REGION_SELECTOR) === null
    ) {
      clearSessionResultsFocusRequest();
      return;
    }

    cancelScheduledSessionResultsFocus();
    pendingRequestRef.current = {
      kind: "content-update",
      sourceElement: activeElement,
    };
    requestFocusRecoveryRender();
  }, [cancelScheduledSessionResultsFocus, clearSessionResultsFocusRequest]);

  const prepareSessionResultsDisclosureControlFocus = useCallback(
    (targetControlId: string) => {
      const activeElement = getActiveSessionResultsElement();
      if (activeElement === null) {
        clearSessionResultsFocusRequest();
        return;
      }

      cancelScheduledSessionResultsFocus();
      pendingRequestRef.current = {
        kind: "disclosure-control",
        sourceElement: activeElement,
        targetControlId,
      };
      requestFocusRecoveryRender();
    },
    [cancelScheduledSessionResultsFocus, clearSessionResultsFocusRequest]
  );

  useLayoutEffect(() => {
    cancelScheduledSessionResultsFocus();
    const focusRequest = pendingRequestRef.current;
    if (focusRequest === null || typeof document === "undefined") return;

    const documentView = document.defaultView;
    if (documentView === null) {
      pendingRequestRef.current = null;
      return;
    }

    let focusAttemptCount = 0;
    const attemptSessionResultsFocus = () => {
      if (pendingRequestRef.current !== focusRequest) return;

      const activeElement = getActiveSessionResultsElement();
      const sourceStillFocused = activeElement === focusRequest.sourceElement;
      const focusFellBackToDocument =
        activeElement === null || activeElement === document.body;

      if (!sourceStillFocused && !focusFellBackToDocument) {
        pendingRequestRef.current = null;
        scheduledAnimationFrameRef.current = null;
        return;
      }

      if (
        focusRequest.kind === "content-update" &&
        sourceStillFocused &&
        focusRequest.sourceElement.isConnected
      ) {
        pendingRequestRef.current = null;
        scheduledAnimationFrameRef.current = null;
        return;
      }

      const focusTarget =
        focusRequest.kind === "disclosure-control"
          ? document.getElementById(focusRequest.targetControlId)
          : findSessionResultsContentFocusTarget(contentFocusTargetId);

      if (
        focusTarget instanceof HTMLElement &&
        !focusTarget.hasAttribute("disabled")
      ) {
        focusTarget.focus();
        pendingRequestRef.current = null;
        scheduledAnimationFrameRef.current = null;
        return;
      }

      focusAttemptCount += 1;
      if (focusAttemptCount >= MAXIMUM_SESSION_RESULTS_FOCUS_ATTEMPTS) {
        pendingRequestRef.current = null;
        scheduledAnimationFrameRef.current = null;
        return;
      }

      const nextFrameId = documentView.requestAnimationFrame(
        attemptSessionResultsFocus
      );
      scheduledAnimationFrameRef.current = {
        id: nextFrameId,
        view: documentView,
      };
    };

    const animationFrameId = documentView.requestAnimationFrame(
      attemptSessionResultsFocus
    );
    scheduledAnimationFrameRef.current = {
      id: animationFrameId,
      view: documentView,
    };

    return () => {
      const scheduledFrame = scheduledAnimationFrameRef.current;
      if (scheduledFrame?.view === documentView) {
        scheduledFrame.view.cancelAnimationFrame(scheduledFrame.id);
        scheduledAnimationFrameRef.current = null;
      }
    };
  });

  return {
    prepareSessionResultsContentFocus,
    prepareSessionResultsDisclosureControlFocus,
  };
}

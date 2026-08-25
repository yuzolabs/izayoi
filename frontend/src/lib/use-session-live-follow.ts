import {
  useCallback,
  useLayoutEffect,
  useReducer,
  useRef,
  type MouseEventHandler,
  type RefObject,
  type UIEventHandler,
} from "react";

import type { SessionAgentOutputRetentionRequest } from "./session-agent-output";

const SESSION_LIVE_LATEST_THRESHOLD_PX = 48;
const SESSION_LIVE_OUTPUT_CHUNK_SELECTOR =
  "[data-session-agent-output-render-key]";

/** Follow mode for a scrollable Live region, including unread appended content. */
export type SessionLiveFollowState =
  | { mode: "following"; hasNewContent: false }
  | { mode: "paused"; hasNewContent: boolean };

/** User and stream events that transition a Live region's follow mode. */
export type SessionLiveFollowEvent =
  | { type: "content-appended" }
  | { type: "left-latest" }
  | { type: "reached-latest" }
  | { type: "selection-created-in-region" }
  | { type: "jump-to-latest" }
  | { type: "content-reset" };

/** Scroll measurements used to decide whether a Live region is near its end. */
export interface SessionLiveScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Configuration for preserving a user's position in a streaming Live region. */
export interface SessionLiveFollowOptions {
  /** Monotonic count of all characters accepted from the current stream. */
  contentVersion: number;
  /** Increments when old output chunks are compacted without receiving content. */
  retentionVersion?: number;
  resetVersion?: number | string;
  /** Reports DOM-backed selection and viewport pins before output compaction. */
  onOutputRetentionRequest?: (
    request: SessionAgentOutputRetentionRequest
  ) => void;
}

/** Controls returned by useSessionLiveFollow for one scrollable Live region. */
export interface SessionLiveFollowControls {
  scrollRegionRef: RefObject<HTMLDivElement | null>;
  followState: SessionLiveFollowState;
  handleScroll: UIEventHandler<HTMLDivElement>;
  handleJumpMouseDown: MouseEventHandler<HTMLButtonElement>;
  jumpToLatest: () => void;
}

interface SessionLiveSelectionIdentity {
  anchorNode: Node;
  anchorOffset: number;
  focusNode: Node;
  focusOffset: number;
}

interface SessionLiveViewportAnchor {
  element: HTMLElement | null;
  elementTop: number;
  scrollHeight: number;
  scrollTop: number;
}

const INITIAL_SESSION_LIVE_FOLLOW_STATE: SessionLiveFollowState = {
  mode: "following",
  hasNewContent: false,
};

/** Reduces the testable follow-live state machine without reading from the DOM. */
export function reduceSessionLiveFollowState(
  state: SessionLiveFollowState,
  event: SessionLiveFollowEvent
): SessionLiveFollowState {
  switch (event.type) {
    case "content-appended":
      return state.mode === "paused" && !state.hasNewContent
        ? { mode: "paused", hasNewContent: true }
        : state;
    case "left-latest":
    case "selection-created-in-region":
      return state.mode === "following"
        ? { mode: "paused", hasNewContent: false }
        : state;
    case "reached-latest":
    case "jump-to-latest":
    case "content-reset":
      return state.mode === "following" ? state : INITIAL_SESSION_LIVE_FOLLOW_STATE;
  }
}

/** Checks whether a Live region is within 48px of its latest content. */
export function isSessionLiveScrollNearLatest(
  metrics: SessionLiveScrollMetrics
): boolean {
  const remainingDistance =
    metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
  return remainingDistance <= SESSION_LIVE_LATEST_THRESHOLD_PX;
}

function selectionIntersectsScrollRegion(
  selection: Selection,
  region: HTMLDivElement
): boolean {
  if (
    (selection.anchorNode !== null && region.contains(selection.anchorNode)) ||
    (selection.focusNode !== null && region.contains(selection.focusNode))
  ) {
    return true;
  }

  for (let rangeIndex = 0; rangeIndex < selection.rangeCount; rangeIndex += 1) {
    try {
      if (selection.getRangeAt(rangeIndex).intersectsNode(region)) return true;
    } catch {
      // A detached Range cannot select current region content.
    }
  }
  return false;
}

function readSessionLiveSelectionIdentity(
  region: HTMLDivElement
): SessionLiveSelectionIdentity | null {
  const selection = region.ownerDocument.getSelection();
  if (
    !selection ||
    selection.isCollapsed ||
    selection.anchorNode === null ||
    selection.focusNode === null ||
    !selectionIntersectsScrollRegion(selection, region)
  ) {
    return null;
  }

  return {
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset,
  };
}

function isSameSessionLiveSelection(
  first: SessionLiveSelectionIdentity | null,
  second: SessionLiveSelectionIdentity | null
): boolean {
  return (
    first !== null &&
    second !== null &&
    first.anchorNode === second.anchorNode &&
    first.anchorOffset === second.anchorOffset &&
    first.focusNode === second.focusNode &&
    first.focusOffset === second.focusOffset
  );
}

function readSessionLiveOutputChunkElements(
  region: HTMLDivElement
): readonly HTMLElement[] {
  return Array.from(
    region.querySelectorAll<HTMLElement>(SESSION_LIVE_OUTPUT_CHUNK_SELECTOR)
  );
}

function readSessionLiveViewportChunkElements({
  region,
  chunkElements,
}: {
  region: HTMLDivElement;
  chunkElements: readonly HTMLElement[];
}): readonly HTMLElement[] {
  const regionRectangle = region.getBoundingClientRect();
  const visibleChunkElements = chunkElements.filter((chunkElement) => {
    const chunkRectangle = chunkElement.getBoundingClientRect();
    if (chunkRectangle.width === 0 && chunkRectangle.height === 0) return false;
    return (
      chunkRectangle.bottom >= regionRectangle.top &&
      chunkRectangle.top <= regionRectangle.bottom
    );
  });

  if (visibleChunkElements.length > 0) return visibleChunkElements;
  if (chunkElements.length === 0) return [];

  return isSessionLiveScrollNearLatest({
    scrollTop: region.scrollTop,
    scrollHeight: region.scrollHeight,
    clientHeight: region.clientHeight,
  })
    ? [chunkElements[chunkElements.length - 1]]
    : [chunkElements[0]];
}

function readSessionLiveSelectionChunkKeys({
  region,
  chunkElements,
}: {
  region: HTMLDivElement;
  chunkElements: readonly HTMLElement[];
}): readonly string[] {
  const selection = region.ownerDocument.getSelection();
  if (
    !selection ||
    selection.isCollapsed ||
    !selectionIntersectsScrollRegion(selection, region)
  ) {
    return [];
  }

  const selectedRenderKeys: string[] = [];
  for (const chunkElement of chunkElements) {
    let intersectsSelection =
      (selection.anchorNode !== null && chunkElement.contains(selection.anchorNode)) ||
      (selection.focusNode !== null && chunkElement.contains(selection.focusNode));

    for (
      let rangeIndex = 0;
      !intersectsSelection && rangeIndex < selection.rangeCount;
      rangeIndex += 1
    ) {
      try {
        intersectsSelection = selection
          .getRangeAt(rangeIndex)
          .intersectsNode(chunkElement);
      } catch {
        // Detached selection nodes are not retention pins.
      }
    }

    const renderKey = chunkElement.dataset.sessionAgentOutputRenderKey;
    if (intersectsSelection && renderKey) selectedRenderKeys.push(renderKey);
  }
  return selectedRenderKeys;
}

function readSessionLiveChunkRenderKeys(
  chunkElements: readonly HTMLElement[]
): readonly string[] {
  return chunkElements.flatMap((chunkElement) => {
    const renderKey = chunkElement.dataset.sessionAgentOutputRenderKey;
    return renderKey ? [renderKey] : [];
  });
}

function mergeUniqueSessionLiveRenderKeys(
  firstRenderKeys: readonly string[],
  secondRenderKeys: readonly string[]
): readonly string[] {
  return [...new Set([...firstRenderKeys, ...secondRenderKeys])];
}

/**
 * Follows appended or resized Live content only while the reader remains near the end.
 * Selection and viewport chunks are reported before compaction so their DOM nodes and
 * scroll anchor survive while follow is paused.
 */
export function useSessionLiveFollow({
  contentVersion,
  retentionVersion = 0,
  resetVersion = 0,
  onOutputRetentionRequest,
}: SessionLiveFollowOptions): SessionLiveFollowControls {
  const scrollRegionRef = useRef<HTMLDivElement>(null);
  const [followState, dispatchFollowState] = useReducer(
    reduceSessionLiveFollowState,
    INITIAL_SESSION_LIVE_FOLLOW_STATE
  );
  const followStateRef = useRef(followState);
  followStateRef.current = followState;
  const acknowledgedSelectionRef = useRef<SessionLiveSelectionIdentity | null>(null);
  const pausedScrollTopRef = useRef<number | null>(null);
  const lastKnownScrollTopRef = useRef<number | null>(null);
  const pendingViewportAnchorRef = useRef<SessionLiveViewportAnchor | null>(null);
  const previousContentVersionRef = useRef(contentVersion);
  const previousRetentionVersionRef = useRef(retentionVersion);
  const previousResetVersionRef = useRef(resetVersion);
  const didMountRef = useRef(false);

  const dispatchFollowEvent = useCallback((event: SessionLiveFollowEvent) => {
    followStateRef.current = reduceSessionLiveFollowState(
      followStateRef.current,
      event
    );
    dispatchFollowState(event);
  }, []);

  const readUnacknowledgedSelection = useCallback((region: HTMLDivElement) => {
    const selectionIdentity = readSessionLiveSelectionIdentity(region);
    if (selectionIdentity === null) {
      acknowledgedSelectionRef.current = null;
      return null;
    }
    return isSameSessionLiveSelection(
      selectionIdentity,
      acknowledgedSelectionRef.current
    )
      ? null
      : selectionIdentity;
  }, []);

  const scrollToLatest = useCallback(() => {
    const region = scrollRegionRef.current;
    if (!region) return;
    region.scrollTop = region.scrollHeight;
    lastKnownScrollTopRef.current = region.scrollTop;
  }, []);

  const requestOutputRetention = useCallback(
    ({ forceLatest = false }: { forceLatest?: boolean } = {}) => {
      const region = scrollRegionRef.current;
      if (!region || !onOutputRetentionRequest) return;

      if (forceLatest || followStateRef.current.mode === "following") {
        pendingViewportAnchorRef.current = null;
        onOutputRetentionRequest({ mode: "latest-only" });
        return;
      }

      const chunkElements = readSessionLiveOutputChunkElements(region);
      const viewportChunkElements = readSessionLiveViewportChunkElements({
        region,
        chunkElements,
      });
      const viewportRenderKeys = readSessionLiveChunkRenderKeys(
        viewportChunkElements
      );
      const activeSelection = readUnacknowledgedSelection(region);
      const retentionRequest: SessionAgentOutputRetentionRequest = activeSelection
        ? {
            mode: "selection-pinned",
            pinnedRenderKeys: mergeUniqueSessionLiveRenderKeys(
              readSessionLiveSelectionChunkKeys({ region, chunkElements }),
              viewportRenderKeys
            ),
          }
        : {
            mode: "viewport-pinned",
            pinnedRenderKeys: viewportRenderKeys,
          };
      const viewportAnchorElement = viewportChunkElements[0] ?? null;
      pendingViewportAnchorRef.current = {
        element: viewportAnchorElement,
        elementTop: viewportAnchorElement?.getBoundingClientRect().top ?? 0,
        scrollHeight: region.scrollHeight,
        scrollTop: region.scrollTop,
      };
      onOutputRetentionRequest(retentionRequest);
    },
    [onOutputRetentionRequest, readUnacknowledgedSelection]
  );

  const restoreViewportAfterRetention = useCallback(() => {
    const region = scrollRegionRef.current;
    if (!region) return;

    if (followStateRef.current.mode === "following") {
      pendingViewportAnchorRef.current = null;
      scrollToLatest();
      return;
    }

    const pendingViewportAnchor = pendingViewportAnchorRef.current;
    pendingViewportAnchorRef.current = null;
    if (
      pendingViewportAnchor?.element?.isConnected &&
      region.contains(pendingViewportAnchor.element)
    ) {
      const currentElementTop =
        pendingViewportAnchor.element.getBoundingClientRect().top;
      region.scrollTop += currentElementTop - pendingViewportAnchor.elementTop;
    } else if (pendingViewportAnchor) {
      const removedHeight =
        pendingViewportAnchor.scrollHeight - region.scrollHeight;
      region.scrollTop = Math.max(
        0,
        pendingViewportAnchor.scrollTop - Math.max(0, removedHeight)
      );
    }

    pausedScrollTopRef.current = region.scrollTop;
    lastKnownScrollTopRef.current = region.scrollTop;
  }, [scrollToLatest]);

  const synchronizeSelectionPause = useCallback(() => {
    const region = scrollRegionRef.current;
    if (!region) return;

    if (readUnacknowledgedSelection(region) !== null) {
      acknowledgedSelectionRef.current = null;
      pausedScrollTopRef.current = region.scrollTop;
      lastKnownScrollTopRef.current = region.scrollTop;
      dispatchFollowEvent({ type: "selection-created-in-region" });
    }

    if (followStateRef.current.mode === "paused") {
      requestOutputRetention();
    }
  }, [dispatchFollowEvent, readUnacknowledgedSelection, requestOutputRetention]);

  const jumpToLatest = useCallback(() => {
    const region = scrollRegionRef.current;
    acknowledgedSelectionRef.current = region
      ? readSessionLiveSelectionIdentity(region)
      : null;
    pausedScrollTopRef.current = null;
    dispatchFollowEvent({ type: "jump-to-latest" });
    scrollToLatest();
    requestOutputRetention({ forceLatest: true });
  }, [dispatchFollowEvent, requestOutputRetention, scrollToLatest]);

  const handleJumpMouseDown = useCallback<MouseEventHandler<HTMLButtonElement>>(
    (event) => {
      const region = scrollRegionRef.current;
      if (
        event.button === 0 &&
        region &&
        readSessionLiveSelectionIdentity(region)
      ) {
        // Keep mousedown from collapsing the selected output before Jump handles it.
        event.preventDefault();
      }
    },
    []
  );

  const handleScroll = useCallback<UIEventHandler<HTMLDivElement>>(
    (event) => {
      const region = event.currentTarget;
      lastKnownScrollTopRef.current = region.scrollTop;

      if (readUnacknowledgedSelection(region) !== null) {
        pausedScrollTopRef.current = region.scrollTop;
        dispatchFollowEvent({ type: "selection-created-in-region" });
        requestOutputRetention();
        return;
      }

      const isNearLatest = isSessionLiveScrollNearLatest({
        scrollTop: region.scrollTop,
        scrollHeight: region.scrollHeight,
        clientHeight: region.clientHeight,
      });
      if (isNearLatest) {
        pausedScrollTopRef.current = null;
        dispatchFollowEvent({ type: "reached-latest" });
        requestOutputRetention({ forceLatest: true });
      } else {
        pausedScrollTopRef.current = region.scrollTop;
        dispatchFollowEvent({ type: "left-latest" });
        requestOutputRetention();
      }
    },
    [dispatchFollowEvent, readUnacknowledgedSelection, requestOutputRetention]
  );

  useLayoutEffect(() => {
    const region = scrollRegionRef.current;
    if (!region) return;

    const resetChanged = previousResetVersionRef.current !== resetVersion;
    const retentionChanged =
      previousRetentionVersionRef.current !== retentionVersion;
    const contentChanged = previousContentVersionRef.current !== contentVersion;
    const contentReset = contentVersion < previousContentVersionRef.current;
    const isInitialContent = !didMountRef.current && contentVersion > 0;

    previousResetVersionRef.current = resetVersion;
    previousRetentionVersionRef.current = retentionVersion;
    previousContentVersionRef.current = contentVersion;
    didMountRef.current = true;

    if (resetChanged || contentReset) {
      acknowledgedSelectionRef.current = null;
      pausedScrollTopRef.current = null;
      pendingViewportAnchorRef.current = null;
      dispatchFollowEvent({ type: "content-reset" });
      scrollToLatest();
      requestOutputRetention({ forceLatest: true });
      return;
    }

    if (retentionChanged) restoreViewportAfterRetention();
    if (!contentChanged && !isInitialContent) return;

    if (
      followStateRef.current.mode === "following" &&
      readUnacknowledgedSelection(region) !== null
    ) {
      pausedScrollTopRef.current =
        lastKnownScrollTopRef.current ?? region.scrollTop;
      dispatchFollowEvent({ type: "selection-created-in-region" });
    }

    if (followStateRef.current.mode === "following") {
      scrollToLatest();
      requestOutputRetention({ forceLatest: true });
      return;
    }

    const preservedScrollTop =
      pausedScrollTopRef.current ??
      lastKnownScrollTopRef.current ??
      region.scrollTop;
    region.scrollTop = preservedScrollTop;
    lastKnownScrollTopRef.current = region.scrollTop;
    dispatchFollowEvent({ type: "content-appended" });
    requestOutputRetention();
  }, [
    contentVersion,
    dispatchFollowEvent,
    readUnacknowledgedSelection,
    requestOutputRetention,
    resetVersion,
    restoreViewportAfterRetention,
    retentionVersion,
    scrollToLatest,
  ]);

  useLayoutEffect(() => {
    const region = scrollRegionRef.current;
    if (!region) return;

    lastKnownScrollTopRef.current = region.scrollTop;
    const ownerDocument = region.ownerDocument;
    ownerDocument.addEventListener("selectionchange", synchronizeSelectionPause);
    region.addEventListener("pointerup", synchronizeSelectionPause);
    region.addEventListener("keyup", synchronizeSelectionPause);

    return () => {
      ownerDocument.removeEventListener(
        "selectionchange",
        synchronizeSelectionPause
      );
      region.removeEventListener("pointerup", synchronizeSelectionPause);
      region.removeEventListener("keyup", synchronizeSelectionPause);
    };
  }, [synchronizeSelectionPause]);

  useLayoutEffect(() => {
    const region = scrollRegionRef.current;
    if (!region || typeof ResizeObserver === "undefined") return;

    let disposed = false;
    let previousClientWidth = region.clientWidth;
    let previousClientHeight = region.clientHeight;
    let previousScrollHeight = region.scrollHeight;
    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;

      const dimensionsChanged =
        previousClientWidth !== region.clientWidth ||
        previousClientHeight !== region.clientHeight ||
        previousScrollHeight !== region.scrollHeight;
      previousClientWidth = region.clientWidth;
      previousClientHeight = region.clientHeight;
      previousScrollHeight = region.scrollHeight;
      if (!dimensionsChanged) return;

      if (followStateRef.current.mode === "paused") {
        if (pausedScrollTopRef.current !== null) {
          region.scrollTop = pausedScrollTopRef.current;
          lastKnownScrollTopRef.current = region.scrollTop;
        }
        return;
      }

      if (readUnacknowledgedSelection(region) !== null) {
        pausedScrollTopRef.current =
          lastKnownScrollTopRef.current ?? region.scrollTop;
        dispatchFollowEvent({ type: "selection-created-in-region" });
        region.scrollTop = pausedScrollTopRef.current;
        lastKnownScrollTopRef.current = region.scrollTop;
        requestOutputRetention();
        return;
      }
      scrollToLatest();
    });
    resizeObserver.observe(region);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
    };
  }, [
    dispatchFollowEvent,
    readUnacknowledgedSelection,
    requestOutputRetention,
    scrollToLatest,
  ]);

  return {
    scrollRegionRef,
    followState,
    handleScroll,
    handleJumpMouseDown,
    jumpToLatest,
  };
}

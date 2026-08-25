import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

import { api, ApiRequestError, type Idea } from "./api";
import {
  mapResultsIdeaMemoApiValidationIssues,
  normalizeResultsIdeaMemo,
  validateResultsIdeaMemo,
} from "./results-idea-memo-field-validation";
import {
  type ResultsIdeaDecisionAttempt,
  type ResultsIdeaSaveState,
  replaceResultsIdea,
} from "./session-results-decision-state";
import {
  createSessionResultsMutationJournal,
  type SessionResultsMutationJournal,
  type SessionResultsVersionedIdeaPayload,
} from "./session-results-mutation-journal";

type VersionedResultsIdeaDesiredDecision =
  SessionResultsVersionedIdeaPayload;

interface InFlightResultsIdeaMutation
  extends VersionedResultsIdeaDesiredDecision {
  generation: number;
}

interface FailedResultsIdeaDesiredDecision {
  desired: VersionedResultsIdeaDesiredDecision;
  message: string;
}

interface ResultsIdeaInterruptedMutationRecovery {
  unsettledInFlight: VersionedResultsIdeaDesiredDecision[];
  replayAttempts: number;
}

interface ResultsIdeaMutationCoordinatorState {
  generation: number;
  cancellationSignal: AbortSignal;
  lastAcknowledged: Idea;
  latestDesired: VersionedResultsIdeaDesiredDecision;
  monotonicVersion: number;
  inFlight: InFlightResultsIdeaMutation | null;
  failedDesired: FailedResultsIdeaDesiredDecision | null;
  interruptedRecovery: ResultsIdeaInterruptedMutationRecovery | null;
  draining: boolean;
}

/** Deterministic bounds and scheduler for interrupted Results PATCH recovery. */
export interface SessionResultsMutationRecoveryPolicy {
  revalidationDelaysMs: readonly number[];
  maximumReplayAttempts: number;
  waitForDelay: (
    delayMs: number,
    cancellationSignal?: AbortSignal
  ) => Promise<void>;
}

interface UseSessionResultsIdeaMutationCoordinatorOptions {
  sessionId: string;
  setIdeas: Dispatch<SetStateAction<Idea[] | null>>;
  setIdeaSaveStates: Dispatch<
    SetStateAction<Record<string, ResultsIdeaSaveState>>
  >;
  setSaveAnnouncement: Dispatch<SetStateAction<string>>;
  prepareSessionResultsContentFocus: () => void;
  mutationJournal?: SessionResultsMutationJournal;
  recoveryPolicy?: SessionResultsMutationRecoveryPolicy;
}

/** Commands for loading and saving through the per-idea Results mutation coordinator. */
export interface SessionResultsIdeaMutationCoordinatorControls {
  /** Restores known journal entries optimistically and starts bounded recovery. */
  recoverLoadedResultsIdeaMutations: (loadedIdeas: Idea[]) => Idea[];
  /** Coalesces a decision or memo into the latest desired state for one idea. */
  saveResultsIdeaDecision: (
    currentIdea: Idea,
    attempt: ResultsIdeaDecisionAttempt
  ) => void;
  /** Resends the exact latest failed desired state for one idea. */
  retryFailedResultsIdeaDecision: (ideaId: string) => void;
  /** Invalidates every pending completion before a Results data reload. */
  resetResultsIdeaMutationGeneration: () => void;
}

const DEFAULT_SESSION_RESULTS_MUTATION_RECOVERY_DELAYS_MS = [
  150, 350, 750,
] as const;
const DEFAULT_SESSION_RESULTS_MUTATION_RECOVERY_REPLAY_ATTEMPTS = 2;
const MAXIMUM_SESSION_RESULTS_MUTATION_RECOVERY_CHECKS = 8;
const MAXIMUM_SESSION_RESULTS_MUTATION_RECOVERY_REPLAYS = 3;
const MAXIMUM_SESSION_RESULTS_UNSETTLED_PAYLOADS = 8;

function waitForSessionResultsMutationRecoveryDelay(
  delayMs: number,
  cancellationSignal?: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (cancellationSignal?.aborted) {
      resolve();
      return;
    }

    let timeoutId: number | null = null;
    const finishWaiting = () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      cancellationSignal?.removeEventListener("abort", finishWaiting);
      resolve();
    };
    timeoutId = window.setTimeout(finishWaiting, delayMs);
    cancellationSignal?.addEventListener("abort", finishWaiting, {
      once: true,
    });
  });
}

const DEFAULT_SESSION_RESULTS_MUTATION_RECOVERY_POLICY: SessionResultsMutationRecoveryPolicy = {
  revalidationDelaysMs:
    DEFAULT_SESSION_RESULTS_MUTATION_RECOVERY_DELAYS_MS,
  maximumReplayAttempts:
    DEFAULT_SESSION_RESULTS_MUTATION_RECOVERY_REPLAY_ATTEMPTS,
  waitForDelay: waitForSessionResultsMutationRecoveryDelay,
};

type ResultsIdeaMutationRequestOutcome =
  | {
      kind: "acknowledged";
      request: InFlightResultsIdeaMutation;
      savedIdea: Idea;
    }
  | {
      kind: "failed";
      request: InFlightResultsIdeaMutation;
      message: string;
      memoError: string | null;
    }
  | { kind: "stale" };

type ResultsIdeaRecoveryOutcome =
  | "continue"
  | "done"
  | "failed"
  | "stale";

type ResultsIdeaRevalidationOutcome =
  | { kind: "observed"; idea: Idea }
  | { kind: "missing" }
  | { kind: "failed" }
  | { kind: "stale" };

function describeResultsIdeaForSaveAnnouncement(idea: Idea): string {
  const compactContent = idea.content.replace(/\s+/g, " ").trim();
  return compactContent.length > 64
    ? `${compactContent.slice(0, 61)}…`
    : compactContent;
}

function createResultsIdeaMutationCoordinatorState(
  idea: Idea,
  generation: number,
  cancellationSignal: AbortSignal
): ResultsIdeaMutationCoordinatorState {
  return {
    generation,
    cancellationSignal,
    lastAcknowledged: idea,
    latestDesired: {
      version: 0,
      decision: idea.decision,
      note: normalizeResultsIdeaMemo(idea.note),
    },
    monotonicVersion: 0,
    inFlight: null,
    failedDesired: null,
    interruptedRecovery: null,
    draining: false,
  };
}

function hasSameResultsIdeaPayload(
  left: Pick<VersionedResultsIdeaDesiredDecision, "decision" | "note">,
  right: Pick<VersionedResultsIdeaDesiredDecision, "decision" | "note">
): boolean {
  return left.decision === right.decision && left.note === right.note;
}

function getResultsIdeaServerPayload(
  idea: Idea
): Pick<VersionedResultsIdeaDesiredDecision, "decision" | "note"> {
  return { decision: idea.decision, note: idea.note };
}

function getJournalResultsIdeaPayload(
  request: InFlightResultsIdeaMutation
): VersionedResultsIdeaDesiredDecision {
  return {
    version: request.version,
    decision: request.decision,
    note: request.note,
  };
}

function deduplicateUnsettledResultsIdeaPayloads(
  payloads: readonly VersionedResultsIdeaDesiredDecision[]
): VersionedResultsIdeaDesiredDecision[] {
  const uniquePayloads: VersionedResultsIdeaDesiredDecision[] = [];
  for (const payload of payloads) {
    if (
      uniquePayloads.some(
        (candidate) =>
          candidate.version === payload.version &&
          hasSameResultsIdeaPayload(candidate, payload)
      )
    ) {
      continue;
    }
    uniquePayloads.push({ ...payload });
  }
  return uniquePayloads.slice(-MAXIMUM_SESSION_RESULTS_UNSETTLED_PAYLOADS);
}

function reconcileObservedUnsettledResultsIdeaPayloads(
  unsettledPayloads: readonly VersionedResultsIdeaDesiredDecision[],
  observedIdea: Idea,
  latestDesired: VersionedResultsIdeaDesiredDecision
): VersionedResultsIdeaDesiredDecision[] {
  const observedPayload = getResultsIdeaServerPayload(observedIdea);
  const matchingIndexes = unsettledPayloads.flatMap((payload, index) =>
    hasSameResultsIdeaPayload(payload, observedPayload) ? [index] : []
  );
  if (matchingIndexes.length === 0) return [...unsettledPayloads];

  if (hasSameResultsIdeaPayload(latestDesired, observedPayload)) {
    return unsettledPayloads.filter(
      (payload) => !hasSameResultsIdeaPayload(payload, observedPayload)
    );
  }

  // One observed payload proves at most one distinct old request settled.
  // Repeated identical replays remain ambiguous without a backend mutation ID.
  if (matchingIndexes.length > 1) return [...unsettledPayloads];
  return unsettledPayloads.filter((_, index) => index !== matchingIndexes[0]);
}

function normalizeSessionResultsMutationRecoveryPolicy(
  policy: SessionResultsMutationRecoveryPolicy
): SessionResultsMutationRecoveryPolicy {
  const revalidationDelaysMs = policy.revalidationDelaysMs
    .filter(
      (delayMs) =>
        Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= 60_000
    )
    .slice(0, MAXIMUM_SESSION_RESULTS_MUTATION_RECOVERY_CHECKS);
  return {
    revalidationDelaysMs:
      revalidationDelaysMs.length > 0 ? revalidationDelaysMs : [0],
    maximumReplayAttempts: Math.max(
      1,
      Math.min(
        MAXIMUM_SESSION_RESULTS_MUTATION_RECOVERY_REPLAYS,
        Math.floor(policy.maximumReplayAttempts) || 1
      )
    ),
    waitForDelay: policy.waitForDelay,
  };
}

function getResultsIdeaMutationFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to save decision";
}

function getResultsIdeaMemoMutationFailurePresentation(error: unknown): {
  message: string;
  memoError: string | null;
} {
  if (error instanceof ApiRequestError && error.validationIssues.length > 0) {
    const mapped = mapResultsIdeaMemoApiValidationIssues(error.validationIssues);
    return {
      memoError: mapped.note,
      message:
        mapped.general ??
        mapped.note ??
        getResultsIdeaMutationFailureMessage(error),
    };
  }
  return {
    memoError: null,
    message: getResultsIdeaMutationFailureMessage(error),
  };
}

function isMatchingResultsIdeaMutationAcknowledgement(
  value: unknown,
  sessionId: string,
  ideaId: string,
  request: InFlightResultsIdeaMutation
): value is Idea {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Idea>;
  return (
    candidate.id === ideaId &&
    candidate.session_id === sessionId &&
    candidate.decision === request.decision &&
    candidate.note === request.note
  );
}

/**
 * Serializes Results saves per idea and recovers interrupted PATCH ordering.
 *
 * Recovery polls the list endpoint before replay, then verifies a replay within a
 * fixed window. A backend without mutation IDs cannot prove ordering after an
 * arbitrarily delayed old request, so the bounded policy is surfaced in UI status.
 */
export function useSessionResultsIdeaMutationCoordinator({
  sessionId,
  setIdeas,
  setIdeaSaveStates,
  setSaveAnnouncement,
  prepareSessionResultsContentFocus,
  mutationJournal,
  recoveryPolicy = DEFAULT_SESSION_RESULTS_MUTATION_RECOVERY_POLICY,
}: UseSessionResultsIdeaMutationCoordinatorOptions): SessionResultsIdeaMutationCoordinatorControls {
  const mountedRef = useRef(false);
  const activeSessionIdRef = useRef(sessionId);
  const mutationGenerationRef = useRef(0);
  const mutationCancellationControllerRef = useRef<AbortController | null>(
    null
  );
  if (mutationCancellationControllerRef.current === null) {
    mutationCancellationControllerRef.current = new AbortController();
  }
  const coordinatorsByIdeaIdRef = useRef(
    new Map<string, ResultsIdeaMutationCoordinatorState>()
  );
  const defaultMutationJournalRef = useRef<SessionResultsMutationJournal | null>(
    null
  );
  if (defaultMutationJournalRef.current === null) {
    defaultMutationJournalRef.current = createSessionResultsMutationJournal();
  }
  const activeMutationJournal =
    mutationJournal ?? defaultMutationJournalRef.current;
  const activeRecoveryPolicy = useMemo(
    () => normalizeSessionResultsMutationRecoveryPolicy(recoveryPolicy),
    [recoveryPolicy]
  );

  const invalidateResultsIdeaMutationGeneration = useCallback(() => {
    mutationCancellationControllerRef.current?.abort();
    mutationCancellationControllerRef.current = new AbortController();
    mutationGenerationRef.current += 1;
    coordinatorsByIdeaIdRef.current.clear();
  }, []);

  useLayoutEffect(() => {
    activeSessionIdRef.current = sessionId;
    invalidateResultsIdeaMutationGeneration();
  }, [invalidateResultsIdeaMutationGeneration, sessionId]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      invalidateResultsIdeaMutationGeneration();
    };
  }, [invalidateResultsIdeaMutationGeneration]);

  const isCurrentResultsIdeaCoordinator = useCallback(
    (ideaId: string, coordinator: ResultsIdeaMutationCoordinatorState) =>
      mountedRef.current &&
      activeSessionIdRef.current === sessionId &&
      mutationGenerationRef.current === coordinator.generation &&
      !coordinator.cancellationSignal.aborted &&
      coordinatorsByIdeaIdRef.current.get(ideaId) === coordinator,
    [sessionId]
  );

  const isCurrentResultsIdeaMutation = useCallback(
    (
      ideaId: string,
      coordinator: ResultsIdeaMutationCoordinatorState,
      request: InFlightResultsIdeaMutation
    ) =>
      isCurrentResultsIdeaCoordinator(ideaId, coordinator) &&
      coordinator.inFlight === request &&
      request.generation === coordinator.generation,
    [isCurrentResultsIdeaCoordinator]
  );

  const persistResultsIdeaMutationCoordinator = useCallback(
    (coordinator: ResultsIdeaMutationCoordinatorState) => {
      activeMutationJournal.writeSessionEntry(sessionId, {
        ideaId: coordinator.lastAcknowledged.id,
        monotonicVersion: coordinator.monotonicVersion,
        lastAcknowledged: getResultsIdeaServerPayload(
          coordinator.lastAcknowledged
        ),
        latestDesired: { ...coordinator.latestDesired },
        inFlight:
          coordinator.inFlight === null
            ? null
            : getJournalResultsIdeaPayload(coordinator.inFlight),
        unsettledInFlight:
          coordinator.interruptedRecovery?.unsettledInFlight.map(
            (payload) => ({ ...payload })
          ) ?? [],
      });
    },
    [activeMutationJournal, sessionId]
  );

  const publishSavingResultsIdea = useCallback(
    (
      coordinator: ResultsIdeaMutationCoordinatorState,
      desired: VersionedResultsIdeaDesiredDecision
    ) => {
      const ideaId = coordinator.lastAcknowledged.id;
      const ideaDescription = describeResultsIdeaForSaveAnnouncement(
        coordinator.lastAcknowledged
      );
      const recovering = coordinator.interruptedRecovery !== null;

      prepareSessionResultsContentFocus();
      setIdeas((currentIdeas) =>
        currentIdeas === null
          ? currentIdeas
          : currentIdeas.map((idea) =>
              idea.id === ideaId
                ? { ...idea, decision: desired.decision, note: desired.note }
                : idea
            )
      );
      setIdeaSaveStates((currentStates) => ({
        ...currentStates,
        [ideaId]: recovering
          ? {
              status: "recovering",
              attempt: {
                decision: desired.decision,
                note: desired.note,
              },
              message: "Recovering interrupted save before bounded replay…",
            }
          : {
              status: "saving",
              attempt: { decision: desired.decision, note: desired.note },
            },
      }));
      setSaveAnnouncement(
        recovering
          ? `Recovering the ${desired.decision} decision for “${ideaDescription}” before bounded replay.`
          : `Saving ${desired.decision} decision for “${ideaDescription}”.`
      );
    },
    [
      prepareSessionResultsContentFocus,
      setIdeaSaveStates,
      setIdeas,
      setSaveAnnouncement,
    ]
  );

  const publishResultsIdeaRecoveryStatus = useCallback(
    (
      coordinator: ResultsIdeaMutationCoordinatorState,
      message: string,
      announcement: string
    ) => {
      const ideaId = coordinator.lastAcknowledged.id;
      setIdeaSaveStates((currentStates) => ({
        ...currentStates,
        [ideaId]: {
          status: "recovering",
          attempt: {
            decision: coordinator.latestDesired.decision,
            note: coordinator.latestDesired.note,
          },
          message,
        },
      }));
      setSaveAnnouncement(announcement);
    },
    [setIdeaSaveStates, setSaveAnnouncement]
  );

  const completeAcknowledgedResultsIdeaMutation = useCallback(
    (
      coordinator: ResultsIdeaMutationCoordinatorState,
      acknowledgedIdea: Idea
    ): boolean => {
      const ideaId = coordinator.lastAcknowledged.id;
      if (
        !isCurrentResultsIdeaCoordinator(ideaId, coordinator) ||
        !hasSameResultsIdeaPayload(
          coordinator.latestDesired,
          getResultsIdeaServerPayload(acknowledgedIdea)
        )
      ) {
        return false;
      }

      const acknowledgedDesired = { ...coordinator.latestDesired };
      coordinator.lastAcknowledged = acknowledgedIdea;
      coordinator.inFlight = null;
      coordinator.interruptedRecovery = null;
      coordinator.failedDesired = null;
      activeMutationJournal.removeSessionEntryIfAcknowledged(sessionId, {
        ideaId,
        ...acknowledgedDesired,
      });

      prepareSessionResultsContentFocus();
      setIdeas((currentIdeas) =>
        currentIdeas === null
          ? currentIdeas
          : replaceResultsIdea(currentIdeas, acknowledgedIdea)
      );
      setIdeaSaveStates((currentStates) => ({
        ...currentStates,
        [ideaId]: { status: "saved" },
      }));
      setSaveAnnouncement(
        `Saved ${acknowledgedIdea.decision} decision for “${describeResultsIdeaForSaveAnnouncement(
          acknowledgedIdea
        )}”.`
      );
      return true;
    },
    [
      activeMutationJournal,
      isCurrentResultsIdeaCoordinator,
      prepareSessionResultsContentFocus,
      sessionId,
      setIdeaSaveStates,
      setIdeas,
      setSaveAnnouncement,
    ]
  );

  const failLatestResultsIdeaMutation = useCallback(
    (
      coordinator: ResultsIdeaMutationCoordinatorState,
      message: string,
      memoError: string | null = null
    ) => {
      const ideaId = coordinator.lastAcknowledged.id;
      if (!isCurrentResultsIdeaCoordinator(ideaId, coordinator)) return;

      coordinator.inFlight = null;
      coordinator.failedDesired = {
        desired: { ...coordinator.latestDesired },
        message,
      };
      persistResultsIdeaMutationCoordinator(coordinator);
      prepareSessionResultsContentFocus();
      setIdeas((currentIdeas) =>
        currentIdeas === null
          ? currentIdeas
          : replaceResultsIdea(currentIdeas, coordinator.lastAcknowledged)
      );
      setIdeaSaveStates((currentStates) => ({
        ...currentStates,
        [ideaId]: {
          status: "error",
          attempt: {
            decision: coordinator.latestDesired.decision,
            note: coordinator.latestDesired.note,
          },
          message,
          memoError,
        },
      }));
      setSaveAnnouncement(
        `Could not save the ${coordinator.latestDesired.decision} decision for “${describeResultsIdeaForSaveAnnouncement(
          coordinator.lastAcknowledged
        )}”: ${message}. You can retry.`
      );
    },
    [
      isCurrentResultsIdeaCoordinator,
      persistResultsIdeaMutationCoordinator,
      prepareSessionResultsContentFocus,
      setIdeaSaveStates,
      setIdeas,
      setSaveAnnouncement,
    ]
  );

  const sendOneResultsIdeaMutation = useCallback(
    async (
      coordinator: ResultsIdeaMutationCoordinatorState
    ): Promise<ResultsIdeaMutationRequestOutcome> => {
      const ideaId = coordinator.lastAcknowledged.id;
      if (
        !isCurrentResultsIdeaCoordinator(ideaId, coordinator) ||
        coordinator.inFlight !== null
      ) {
        return { kind: "stale" };
      }

      const request: InFlightResultsIdeaMutation = {
        ...coordinator.latestDesired,
        generation: coordinator.generation,
      };
      coordinator.inFlight = request;
      // This synchronous journal write intentionally happens before updateDecision.
      persistResultsIdeaMutationCoordinator(coordinator);

      try {
        const savedValue: unknown = await api.updateDecision(
          ideaId,
          request.decision,
          request.note
        );
        if (!isCurrentResultsIdeaMutation(ideaId, coordinator, request)) {
          return { kind: "stale" };
        }

        coordinator.inFlight = null;
        if (
          !isMatchingResultsIdeaMutationAcknowledgement(
            savedValue,
            sessionId,
            ideaId,
            request
          )
        ) {
          persistResultsIdeaMutationCoordinator(coordinator);
          return {
            kind: "failed",
            request,
            message:
              "Results decision acknowledgement did not match the current request",
            memoError: null,
          };
        }

        coordinator.lastAcknowledged = savedValue;
        persistResultsIdeaMutationCoordinator(coordinator);
        return { kind: "acknowledged", request, savedIdea: savedValue };
      } catch (saveError: unknown) {
        if (!isCurrentResultsIdeaMutation(ideaId, coordinator, request)) {
          return { kind: "stale" };
        }
        coordinator.inFlight = null;
        persistResultsIdeaMutationCoordinator(coordinator);
        const failurePresentation =
          getResultsIdeaMemoMutationFailurePresentation(saveError);
        return {
          kind: "failed",
          request,
          message: failurePresentation.message,
          memoError: failurePresentation.memoError,
        };
      }
    },
    [
      isCurrentResultsIdeaCoordinator,
      isCurrentResultsIdeaMutation,
      persistResultsIdeaMutationCoordinator,
      sessionId,
    ]
  );

  const revalidateResultsIdeaDuringRecovery = useCallback(
    async (
      coordinator: ResultsIdeaMutationCoordinatorState
    ): Promise<ResultsIdeaRevalidationOutcome> => {
      const ideaId = coordinator.lastAcknowledged.id;
      try {
        const response = await api.listIdeas(sessionId);
        if (!isCurrentResultsIdeaCoordinator(ideaId, coordinator)) {
          return { kind: "stale" };
        }
        const observedIdea = response.ideas.find(
          (idea) => idea.id === ideaId && idea.session_id === sessionId
        );
        if (observedIdea === undefined) {
          const knownIdeaIds = new Set(
            response.ideas
              .filter((idea) => idea.session_id === sessionId)
              .map((idea) => idea.id)
          );
          activeMutationJournal.removeUnknownSessionEntries(
            sessionId,
            knownIdeaIds
          );
          coordinatorsByIdeaIdRef.current.delete(ideaId);
          setIdeas((currentIdeas) =>
            currentIdeas === null
              ? currentIdeas
              : currentIdeas.filter((idea) => idea.id !== ideaId)
          );
          setIdeaSaveStates((currentStates) => {
            const nextStates = { ...currentStates };
            delete nextStates[ideaId];
            return nextStates;
          });
          setSaveAnnouncement(
            `Stopped recovering “${describeResultsIdeaForSaveAnnouncement(
              coordinator.lastAcknowledged
            )}” because that idea is no longer in this session.`
          );
          return { kind: "missing" };
        }

        coordinator.lastAcknowledged = observedIdea;
        if (coordinator.interruptedRecovery !== null) {
          coordinator.interruptedRecovery.unsettledInFlight =
            reconcileObservedUnsettledResultsIdeaPayloads(
              coordinator.interruptedRecovery.unsettledInFlight,
              observedIdea,
              coordinator.latestDesired
            );
        }
        persistResultsIdeaMutationCoordinator(coordinator);
        return { kind: "observed", idea: observedIdea };
      } catch {
        return isCurrentResultsIdeaCoordinator(ideaId, coordinator)
          ? { kind: "failed" }
          : { kind: "stale" };
      }
    },
    [
      activeMutationJournal,
      isCurrentResultsIdeaCoordinator,
      persistResultsIdeaMutationCoordinator,
      sessionId,
      setIdeaSaveStates,
      setIdeas,
      setSaveAnnouncement,
    ]
  );

  const waitForResultsIdeaRecoveryDelay = useCallback(
    async (
      coordinator: ResultsIdeaMutationCoordinatorState,
      delayMs: number
    ) => {
      try {
        await activeRecoveryPolicy.waitForDelay(
          delayMs,
          coordinator.cancellationSignal
        );
      } catch {
        // A test scheduler or browser timer failure counts as an elapsed check.
      }
    },
    [activeRecoveryPolicy]
  );

  const recoverInterruptedResultsIdeaMutation = useCallback(
    async (
      coordinator: ResultsIdeaMutationCoordinatorState
    ): Promise<ResultsIdeaRecoveryOutcome> => {
      const ideaId = coordinator.lastAcknowledged.id;
      const ideaDescription = describeResultsIdeaForSaveAnnouncement(
        coordinator.lastAcknowledged
      );
      const recovery = coordinator.interruptedRecovery;
      if (
        recovery === null ||
        !isCurrentResultsIdeaCoordinator(ideaId, coordinator)
      ) {
        return "stale";
      }

      if (recovery.unsettledInFlight.length === 0) {
        coordinator.interruptedRecovery = null;
        persistResultsIdeaMutationCoordinator(coordinator);
        if (
          hasSameResultsIdeaPayload(
            coordinator.latestDesired,
            getResultsIdeaServerPayload(coordinator.lastAcknowledged)
          )
        ) {
          completeAcknowledgedResultsIdeaMutation(
            coordinator,
            coordinator.lastAcknowledged
          );
          return "done";
        }
        return "continue";
      }

      const totalChecks = activeRecoveryPolicy.revalidationDelaysMs.length;
      for (let checkIndex = 0; checkIndex < totalChecks; checkIndex += 1) {
        publishResultsIdeaRecoveryStatus(
          coordinator,
          `Recovery check ${checkIndex + 1}/${totalChecks} before replay…`,
          `Recovering “${ideaDescription}”: bounded check ${checkIndex + 1} of ${totalChecks} before replay.`
        );
        await waitForResultsIdeaRecoveryDelay(
          coordinator,
          activeRecoveryPolicy.revalidationDelaysMs[checkIndex] ?? 0
        );
        if (!isCurrentResultsIdeaCoordinator(ideaId, coordinator)) {
          return "stale";
        }
        const revalidation = await revalidateResultsIdeaDuringRecovery(
          coordinator
        );
        if (revalidation.kind === "stale") return "stale";
        if (revalidation.kind === "missing") return "done";
        if (
          revalidation.kind === "observed" &&
          recovery.unsettledInFlight.length === 0
        ) {
          coordinator.interruptedRecovery = null;
          persistResultsIdeaMutationCoordinator(coordinator);
          if (
            hasSameResultsIdeaPayload(
              coordinator.latestDesired,
              getResultsIdeaServerPayload(revalidation.idea)
            )
          ) {
            completeAcknowledgedResultsIdeaMutation(
              coordinator,
              revalidation.idea
            );
            return "done";
          }
          return "continue";
        }
      }

      while (
        recovery.replayAttempts < activeRecoveryPolicy.maximumReplayAttempts
      ) {
        recovery.replayAttempts += 1;
        const replayAttempt = recovery.replayAttempts;
        coordinator.monotonicVersion += 1;
        coordinator.latestDesired = {
          ...coordinator.latestDesired,
          version: coordinator.monotonicVersion,
        };
        publishResultsIdeaRecoveryStatus(
          coordinator,
          `Recovery window ended; replaying latest change ${replayAttempt}/${activeRecoveryPolicy.maximumReplayAttempts}…`,
          `The bounded recovery window ended for “${ideaDescription}”; replaying the latest change, attempt ${replayAttempt} of ${activeRecoveryPolicy.maximumReplayAttempts}.`
        );
        const replayOutcome = await sendOneResultsIdeaMutation(coordinator);
        if (replayOutcome.kind === "stale") return "stale";
        if (replayOutcome.kind === "failed") {
          if (
            coordinator.latestDesired.version > replayOutcome.request.version
          ) {
            continue;
          }
          failLatestResultsIdeaMutation(
            coordinator,
            replayOutcome.message,
            replayOutcome.memoError
          );
          return "failed";
        }

        if (
          coordinator.latestDesired.version > replayOutcome.request.version
        ) {
          continue;
        }
        if (recovery.unsettledInFlight.length === 0) {
          coordinator.interruptedRecovery = null;
          completeAcknowledgedResultsIdeaMutation(
            coordinator,
            replayOutcome.savedIdea
          );
          return "done";
        }

        let replayStayedLatest = true;
        let successfulVerificationCount = 0;
        for (let checkIndex = 0; checkIndex < totalChecks; checkIndex += 1) {
          publishResultsIdeaRecoveryStatus(
            coordinator,
            `Verifying recovered change ${checkIndex + 1}/${totalChecks}…`,
            `Verifying the recovered change for “${ideaDescription}”, bounded check ${checkIndex + 1} of ${totalChecks}.`
          );
          await waitForResultsIdeaRecoveryDelay(
            coordinator,
            activeRecoveryPolicy.revalidationDelaysMs[checkIndex] ?? 0
          );
          if (!isCurrentResultsIdeaCoordinator(ideaId, coordinator)) {
            return "stale";
          }
          const revalidation = await revalidateResultsIdeaDuringRecovery(
            coordinator
          );
          if (revalidation.kind === "stale") return "stale";
          if (revalidation.kind === "missing") return "done";
          if (revalidation.kind !== "observed") {
            replayStayedLatest = false;
            continue;
          }
          if (
            !hasSameResultsIdeaPayload(
              coordinator.latestDesired,
              getResultsIdeaServerPayload(revalidation.idea)
            )
          ) {
            replayStayedLatest = false;
          } else {
            successfulVerificationCount += 1;
          }
        }

        if (
          replayStayedLatest &&
          successfulVerificationCount === totalChecks &&
          hasSameResultsIdeaPayload(
            coordinator.latestDesired,
            getResultsIdeaServerPayload(coordinator.lastAcknowledged)
          )
        ) {
          // This is the deterministic bounded acceptance point. An arbitrarily
          // delayed old backend request remains impossible to exclude without an
          // API mutation token, so the UI exposes every check before this point.
          coordinator.interruptedRecovery = null;
          completeAcknowledgedResultsIdeaMutation(
            coordinator,
            coordinator.lastAcknowledged
          );
          return "done";
        }
      }

      failLatestResultsIdeaMutation(
        coordinator,
        `Recovery could not verify the latest change after ${activeRecoveryPolicy.maximumReplayAttempts} bounded replay attempts`
      );
      return "failed";
    },
    [
      activeRecoveryPolicy.maximumReplayAttempts,
      activeRecoveryPolicy.revalidationDelaysMs,
      completeAcknowledgedResultsIdeaMutation,
      failLatestResultsIdeaMutation,
      isCurrentResultsIdeaCoordinator,
      persistResultsIdeaMutationCoordinator,
      publishResultsIdeaRecoveryStatus,
      revalidateResultsIdeaDuringRecovery,
      sendOneResultsIdeaMutation,
      waitForResultsIdeaRecoveryDelay,
    ]
  );

  const drainResultsIdeaMutationCoordinator = useCallback(
    async (coordinator: ResultsIdeaMutationCoordinatorState) => {
      const ideaId = coordinator.lastAcknowledged.id;
      if (
        coordinator.draining ||
        !isCurrentResultsIdeaCoordinator(ideaId, coordinator)
      ) {
        return;
      }
      coordinator.draining = true;

      try {
        while (isCurrentResultsIdeaCoordinator(ideaId, coordinator)) {
          if (coordinator.failedDesired !== null) return;
          if (coordinator.interruptedRecovery !== null) {
            const recoveryOutcome =
              await recoverInterruptedResultsIdeaMutation(coordinator);
            if (recoveryOutcome !== "continue") return;
            continue;
          }

          if (
            hasSameResultsIdeaPayload(
              coordinator.latestDesired,
              getResultsIdeaServerPayload(coordinator.lastAcknowledged)
            )
          ) {
            completeAcknowledgedResultsIdeaMutation(
              coordinator,
              coordinator.lastAcknowledged
            );
            return;
          }

          publishSavingResultsIdea(coordinator, coordinator.latestDesired);
          const requestOutcome = await sendOneResultsIdeaMutation(coordinator);
          if (requestOutcome.kind === "stale") return;
          if (requestOutcome.kind === "failed") {
            if (
              coordinator.latestDesired.version > requestOutcome.request.version
            ) {
              continue;
            }
            failLatestResultsIdeaMutation(
              coordinator,
              requestOutcome.message,
              requestOutcome.memoError
            );
            return;
          }
          if (
            coordinator.latestDesired.version > requestOutcome.request.version
          ) {
            continue;
          }
          completeAcknowledgedResultsIdeaMutation(
            coordinator,
            requestOutcome.savedIdea
          );
          return;
        }
      } finally {
        coordinator.draining = false;
      }
    },
    [
      completeAcknowledgedResultsIdeaMutation,
      failLatestResultsIdeaMutation,
      isCurrentResultsIdeaCoordinator,
      publishSavingResultsIdea,
      recoverInterruptedResultsIdeaMutation,
      sendOneResultsIdeaMutation,
    ]
  );

  const startDrainingResultsIdeaMutationCoordinator = useCallback(
    (coordinator: ResultsIdeaMutationCoordinatorState) => {
      void drainResultsIdeaMutationCoordinator(coordinator).catch(
        (drainError: unknown) => {
          try {
            failLatestResultsIdeaMutation(
              coordinator,
              `Unexpected Results save coordinator failure: ${getResultsIdeaMutationFailureMessage(
                drainError
              )}`
            );
          } catch {
            // A defensive injected dependency must not create an unhandled rejection.
          }
        }
      );
    },
    [drainResultsIdeaMutationCoordinator, failLatestResultsIdeaMutation]
  );

  const recoverLoadedResultsIdeaMutations = useCallback(
    (loadedIdeas: Idea[]): Idea[] => {
      const cancellationSignal =
        mutationCancellationControllerRef.current?.signal;
      if (
        !mountedRef.current ||
        activeSessionIdRef.current !== sessionId ||
        cancellationSignal === undefined ||
        cancellationSignal.aborted
      ) {
        return loadedIdeas;
      }
      const generation = mutationGenerationRef.current;
      const loadedIdeasById = new Map(
        loadedIdeas
          .filter((idea) => idea.session_id === sessionId)
          .map((idea) => [idea.id, idea] as const)
      );
      const knownIdeaIds = new Set(loadedIdeasById.keys());
      const journalEntries = activeMutationJournal.readSessionEntries(sessionId);
      activeMutationJournal.removeUnknownSessionEntries(
        sessionId,
        knownIdeaIds
      );

      const recoveringStates: Record<string, ResultsIdeaSaveState> = {};
      const coordinatorsToDrain: ResultsIdeaMutationCoordinatorState[] = [];
      const optimisticIdeasById = new Map<string, Idea>();
      for (const entry of journalEntries) {
        const loadedIdea = loadedIdeasById.get(entry.ideaId);
        if (loadedIdea === undefined) continue;

        const latestDesired = {
          ...entry.latestDesired,
          note: normalizeResultsIdeaMemo(entry.latestDesired.note),
        };
        const unsettledInFlight =
          reconcileObservedUnsettledResultsIdeaPayloads(
            deduplicateUnsettledResultsIdeaPayloads([
              ...entry.unsettledInFlight,
              ...(entry.inFlight === null ? [] : [entry.inFlight]),
            ]),
            loadedIdea,
            latestDesired
          );
        const coordinator: ResultsIdeaMutationCoordinatorState = {
          generation,
          cancellationSignal,
          lastAcknowledged: loadedIdea,
          latestDesired,
          monotonicVersion: entry.monotonicVersion,
          inFlight: null,
          failedDesired: null,
          interruptedRecovery: {
            unsettledInFlight,
            replayAttempts: 0,
          },
          draining: false,
        };
        coordinatorsByIdeaIdRef.current.set(entry.ideaId, coordinator);

        if (
          unsettledInFlight.length === 0 &&
          hasSameResultsIdeaPayload(
            coordinator.latestDesired,
            getResultsIdeaServerPayload(loadedIdea)
          )
        ) {
          coordinator.interruptedRecovery = null;
          completeAcknowledgedResultsIdeaMutation(coordinator, loadedIdea);
          continue;
        }

        optimisticIdeasById.set(entry.ideaId, {
          ...loadedIdea,
          decision: coordinator.latestDesired.decision,
          note: coordinator.latestDesired.note,
        });
        persistResultsIdeaMutationCoordinator(coordinator);
        recoveringStates[entry.ideaId] = {
          status: "recovering",
          attempt: {
            decision: coordinator.latestDesired.decision,
            note: coordinator.latestDesired.note,
          },
          message:
            unsettledInFlight.length > 0
              ? `Recovering interrupted save with ${activeRecoveryPolicy.revalidationDelaysMs.length} bounded checks…`
              : "Replaying saved change after reload…",
        };
        coordinatorsToDrain.push(coordinator);
      }

      if (Object.keys(recoveringStates).length > 0) {
        setIdeaSaveStates((currentStates) => ({
          ...currentStates,
          ...recoveringStates,
        }));
        setSaveAnnouncement(
          `Recovering ${Object.keys(recoveringStates).length} interrupted Results save${
            Object.keys(recoveringStates).length === 1 ? "" : "s"
          } with a bounded revalidation policy.`
        );
      }

      for (const coordinator of coordinatorsToDrain) {
        startDrainingResultsIdeaMutationCoordinator(coordinator);
      }
      return loadedIdeas.map(
        (idea) => optimisticIdeasById.get(idea.id) ?? idea
      );
    },
    [
      activeMutationJournal,
      activeRecoveryPolicy.revalidationDelaysMs.length,
      completeAcknowledgedResultsIdeaMutation,
      persistResultsIdeaMutationCoordinator,
      sessionId,
      startDrainingResultsIdeaMutationCoordinator,
      setIdeaSaveStates,
      setSaveAnnouncement,
    ]
  );

  const saveResultsIdeaDecision = useCallback(
    (currentIdea: Idea, attempt: ResultsIdeaDecisionAttempt) => {
      if (!mountedRef.current) return;

      const generation = mutationGenerationRef.current;
      let coordinator = coordinatorsByIdeaIdRef.current.get(currentIdea.id);
      if (coordinator === undefined || coordinator.generation !== generation) {
        const cancellationSignal =
          mutationCancellationControllerRef.current?.signal;
        if (cancellationSignal === undefined || cancellationSignal.aborted) {
          return;
        }
        coordinator = createResultsIdeaMutationCoordinatorState(
          currentIdea,
          generation,
          cancellationSignal
        );
        coordinatorsByIdeaIdRef.current.set(currentIdea.id, coordinator);
      }

      const candidateNote = attempt.note ?? coordinator.latestDesired.note;
      if (validateResultsIdeaMemo(candidateNote) !== null) {
        return;
      }
      const nextPayload = {
        decision: attempt.decision,
        note: normalizeResultsIdeaMemo(candidateNote),
      };
      if (
        coordinator.failedDesired === null &&
        hasSameResultsIdeaPayload(coordinator.latestDesired, nextPayload)
      ) {
        return;
      }

      coordinator.monotonicVersion += 1;
      coordinator.latestDesired = {
        version: coordinator.monotonicVersion,
        ...nextPayload,
      };
      coordinator.failedDesired = null;
      if (coordinator.interruptedRecovery !== null) {
        // A newly desired payload receives the full bounded replay budget even
        // when the user changes it during an earlier recovery replay.
        coordinator.interruptedRecovery.replayAttempts = 0;
      }
      // Persist latestDesired even when an older request is still in flight.
      persistResultsIdeaMutationCoordinator(coordinator);
      publishSavingResultsIdea(coordinator, coordinator.latestDesired);
      startDrainingResultsIdeaMutationCoordinator(coordinator);
    },
    [
      persistResultsIdeaMutationCoordinator,
      publishSavingResultsIdea,
      startDrainingResultsIdeaMutationCoordinator,
    ]
  );

  const retryFailedResultsIdeaDecision = useCallback(
    (ideaId: string) => {
      if (!mountedRef.current) return;
      const coordinator = coordinatorsByIdeaIdRef.current.get(ideaId);
      const failedDesired = coordinator?.failedDesired;
      if (
        coordinator === undefined ||
        failedDesired === null ||
        failedDesired === undefined ||
        coordinator.generation !== mutationGenerationRef.current ||
        coordinator.inFlight !== null
      ) {
        return;
      }

      coordinator.monotonicVersion += 1;
      coordinator.latestDesired = {
        ...failedDesired.desired,
        version: coordinator.monotonicVersion,
      };
      coordinator.failedDesired = null;
      if (coordinator.interruptedRecovery !== null) {
        coordinator.interruptedRecovery.replayAttempts = 0;
      }
      persistResultsIdeaMutationCoordinator(coordinator);
      publishSavingResultsIdea(coordinator, coordinator.latestDesired);
      startDrainingResultsIdeaMutationCoordinator(coordinator);
    },
    [
      persistResultsIdeaMutationCoordinator,
      publishSavingResultsIdea,
      startDrainingResultsIdeaMutationCoordinator,
    ]
  );

  return {
    recoverLoadedResultsIdeaMutations,
    saveResultsIdeaDecision,
    retryFailedResultsIdeaDecision,
    resetResultsIdeaMutationGeneration: invalidateResultsIdeaMutationGeneration,
  };
}

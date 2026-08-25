/** Ordered working phases used by the Live session state and phase stepper. */
export const SESSION_LIVE_PHASE_SEQUENCE = [
  "framing",
  "divergence",
  "discussion",
  "convergence",
  "done",
] as const;

/** A canonical Live session phase; terminal errors retain the last canonical phase. */
export type SessionLivePhase = (typeof SESSION_LIVE_PHASE_SEQUENCE)[number];

/** Checks whether an API or stream phase belongs to the canonical Live phase sequence. */
export function isSessionLivePhase(value: string): value is SessionLivePhase {
  return SESSION_LIVE_PHASE_SEQUENCE.some((phase) => phase === value);
}

/** Resolves a canonical Live phase, or null when an errored session has no phase in the API. */
export function getInitialSessionLivePhase(status: string): SessionLivePhase | null {
  return isSessionLivePhase(status) ? status : null;
}

/**
 * Advances the Live phase monotonically so replayed SSE history cannot move the
 * stepper backward or expose discussion content before discussion begins.
 */
export function reduceSessionLivePhase({
  currentPhase,
  receivedPhase,
}: {
  currentPhase: SessionLivePhase | null;
  receivedPhase: string;
}): SessionLivePhase | null {
  if (!isSessionLivePhase(receivedPhase)) return currentPhase;
  if (currentPhase === null) return receivedPhase;

  const currentIndex = SESSION_LIVE_PHASE_SEQUENCE.indexOf(currentPhase);
  const receivedIndex = SESSION_LIVE_PHASE_SEQUENCE.indexOf(receivedPhase);
  return receivedIndex >= currentIndex ? receivedPhase : currentPhase;
}

/** Reports whether discussion history may be shown for the current Live phase. */
export function hasSessionLiveDiscussionOpened(phase: SessionLivePhase | null): boolean {
  return (
    phase !== null &&
    SESSION_LIVE_PHASE_SEQUENCE.indexOf(phase) >=
      SESSION_LIVE_PHASE_SEQUENCE.indexOf("discussion")
  );
}

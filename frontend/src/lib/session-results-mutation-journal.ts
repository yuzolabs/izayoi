import type { Decision } from "./api";

const SESSION_RESULTS_MUTATION_JOURNAL_SCHEMA =
  "izayoi.session-results-mutation-journal";
const SESSION_RESULTS_MUTATION_JOURNAL_SCHEMA_VERSION = 1;
const SESSION_RESULTS_MUTATION_JOURNAL_KEY_PREFIX =
  "izayoi.session-results-mutation-journal.v1:";
const SESSION_RESULTS_MUTATION_JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const SESSION_RESULTS_MUTATION_JOURNAL_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const SESSION_RESULTS_MUTATION_JOURNAL_MAX_ENTRIES = 256;
const SESSION_RESULTS_MUTATION_JOURNAL_MAX_UNSETTLED_REQUESTS = 8;
const SESSION_RESULTS_MUTATION_JOURNAL_MAX_NOTE_LENGTH = 100_000;
const SESSION_RESULTS_MUTATION_JOURNAL_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** Minimal synchronous storage capability used by the Results mutation journal. */
export interface SessionResultsMutationJournalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A decision and memo known to have been returned by the server. */
export interface SessionResultsAcknowledgedIdeaPayload {
  decision: Decision;
  note: string;
}

/** A monotonic Results decision payload that can be matched to one PATCH attempt. */
export interface SessionResultsVersionedIdeaPayload
  extends SessionResultsAcknowledgedIdeaPayload {
  version: number;
}

/** One durable per-idea queue entry in a session-scoped Results mutation journal. */
export interface SessionResultsMutationJournalEntry {
  ideaId: string;
  monotonicVersion: number;
  lastAcknowledged: SessionResultsAcknowledgedIdeaPayload;
  latestDesired: SessionResultsVersionedIdeaPayload;
  inFlight: SessionResultsVersionedIdeaPayload | null;
  unsettledInFlight: SessionResultsVersionedIdeaPayload[];
  updatedAtMs: number;
}

/** Values required to synchronously persist one Results mutation coordinator. */
export type SessionResultsMutationJournalEntryInput = Omit<
  SessionResultsMutationJournalEntry,
  "updatedAtMs"
>;

/** Exact latest acknowledgement required before a journal entry may be removed. */
export interface SessionResultsMutationJournalAcknowledgement
  extends SessionResultsVersionedIdeaPayload {
  ideaId: string;
}

/** Safe session-scoped persistence operations for Results decision recovery. */
export interface SessionResultsMutationJournal {
  /** Reads validated, unexpired entries; malformed storage is cleaned up best-effort. */
  readSessionEntries(sessionId: string): SessionResultsMutationJournalEntry[];
  /** Synchronously replaces one idea entry before its PATCH starts. */
  writeSessionEntry(
    sessionId: string,
    entry: SessionResultsMutationJournalEntryInput
  ): boolean;
  /** Removes only an entry whose current latest version and payload match this ack. */
  removeSessionEntryIfAcknowledged(
    sessionId: string,
    acknowledgement: SessionResultsMutationJournalAcknowledgement
  ): boolean;
  /** Drops entries for ideas absent from the current session GET. */
  removeUnknownSessionEntries(
    sessionId: string,
    knownIdeaIds: ReadonlySet<string>
  ): number;
}

interface StoredSessionResultsMutationJournal {
  schema: typeof SESSION_RESULTS_MUTATION_JOURNAL_SCHEMA;
  schemaVersion: typeof SESSION_RESULTS_MUTATION_JOURNAL_SCHEMA_VERSION;
  sessionId: string;
  updatedAtMs: number;
  entries: SessionResultsMutationJournalEntry[];
}

interface CreateSessionResultsMutationJournalOptions {
  storage?: SessionResultsMutationJournalStorage | null;
  now?: () => number;
  maximumAgeMs?: number;
}

type ReadStoredJournalResult =
  | { kind: "missing" }
  | { kind: "unavailable" }
  | { kind: "valid"; journal: StoredSessionResultsMutationJournal };

function isJournalRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeSessionResultsJournalId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SESSION_RESULTS_MUTATION_JOURNAL_ID_PATTERN.test(value)
  );
}

function isSessionResultsJournalDecision(value: unknown): value is Decision {
  return (
    value === "pending" ||
    value === "adopted" ||
    value === "held" ||
    value === "rejected"
  );
}

function isSafeSessionResultsJournalNote(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= SESSION_RESULTS_MUTATION_JOURNAL_MAX_NOTE_LENGTH
  );
}

function isSafeSessionResultsJournalVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1
  );
}

function isSafeSessionResultsJournalTimestamp(
  value: unknown,
  nowMs: number,
  maximumAgeMs: number
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= nowMs + SESSION_RESULTS_MUTATION_JOURNAL_MAX_FUTURE_SKEW_MS &&
    nowMs - value <= maximumAgeMs
  );
}

function parseAcknowledgedIdeaPayload(
  value: unknown
): SessionResultsAcknowledgedIdeaPayload | null {
  if (
    !isJournalRecord(value) ||
    !isSessionResultsJournalDecision(value.decision) ||
    !isSafeSessionResultsJournalNote(value.note)
  ) {
    return null;
  }
  return { decision: value.decision, note: value.note };
}

function parseVersionedIdeaPayload(
  value: unknown
): SessionResultsVersionedIdeaPayload | null {
  const acknowledgedPayload = parseAcknowledgedIdeaPayload(value);
  if (
    acknowledgedPayload === null ||
    !isJournalRecord(value) ||
    !isSafeSessionResultsJournalVersion(value.version)
  ) {
    return null;
  }
  return { version: value.version, ...acknowledgedPayload };
}

function parseMutationJournalEntry(
  value: unknown,
  nowMs: number,
  maximumAgeMs: number
): SessionResultsMutationJournalEntry | null {
  if (
    !isJournalRecord(value) ||
    !isSafeSessionResultsJournalId(value.ideaId) ||
    !isSafeSessionResultsJournalVersion(value.monotonicVersion) ||
    !isSafeSessionResultsJournalTimestamp(
      value.updatedAtMs,
      nowMs,
      maximumAgeMs
    ) ||
    !Array.isArray(value.unsettledInFlight) ||
    value.unsettledInFlight.length >
      SESSION_RESULTS_MUTATION_JOURNAL_MAX_UNSETTLED_REQUESTS
  ) {
    return null;
  }

  const monotonicVersion = value.monotonicVersion;
  const lastAcknowledged = parseAcknowledgedIdeaPayload(value.lastAcknowledged);
  const latestDesired = parseVersionedIdeaPayload(value.latestDesired);
  const inFlight =
    value.inFlight === null ? null : parseVersionedIdeaPayload(value.inFlight);
  const unsettledInFlight = value.unsettledInFlight.map(
    parseVersionedIdeaPayload
  );
  if (
    lastAcknowledged === null ||
    latestDesired === null ||
    (value.inFlight !== null && inFlight === null) ||
    unsettledInFlight.some((payload) => payload === null) ||
    latestDesired.version !== monotonicVersion ||
    (inFlight !== null && inFlight.version > monotonicVersion) ||
    unsettledInFlight.some(
      (payload) => payload !== null && payload.version > monotonicVersion
    )
  ) {
    return null;
  }

  return {
    ideaId: value.ideaId,
    monotonicVersion,
    lastAcknowledged,
    latestDesired,
    inFlight,
    unsettledInFlight:
      unsettledInFlight as SessionResultsVersionedIdeaPayload[],
    updatedAtMs: value.updatedAtMs,
  };
}

/** Returns the versioned sessionStorage key for one safe Results session ID. */
export function getSessionResultsMutationJournalStorageKey(
  sessionId: string
): string | null {
  return isSafeSessionResultsJournalId(sessionId)
    ? `${SESSION_RESULTS_MUTATION_JOURNAL_KEY_PREFIX}${sessionId}`
    : null;
}

function getBrowserSessionResultsMutationJournalStorage(): SessionResultsMutationJournalStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function hasSameVersionedIdeaPayload(
  left: SessionResultsVersionedIdeaPayload,
  right: SessionResultsVersionedIdeaPayload
): boolean {
  return (
    left.version === right.version &&
    left.decision === right.decision &&
    left.note === right.note
  );
}

/**
 * Creates a versioned per-session Results journal with injectable sessionStorage.
 *
 * Every storage access is best-effort: quota, security, serialization, and property
 * access failures never escape into the Results UI.
 */
export function createSessionResultsMutationJournal({
  storage = getBrowserSessionResultsMutationJournalStorage(),
  now = Date.now,
  maximumAgeMs = SESSION_RESULTS_MUTATION_JOURNAL_MAX_AGE_MS,
}: CreateSessionResultsMutationJournalOptions = {}): SessionResultsMutationJournal {
  const getNowMs = (): number => {
    try {
      const candidate = now();
      return Number.isSafeInteger(candidate) && candidate >= 0
        ? candidate
        : Date.now();
    } catch {
      return Date.now();
    }
  };

  const removeStoredJournal = (storageKey: string): boolean => {
    if (storage === null) return false;
    try {
      storage.removeItem(storageKey);
      return true;
    } catch {
      return false;
    }
  };

  const storeJournal = (
    storageKey: string,
    journal: StoredSessionResultsMutationJournal
  ): boolean => {
    if (storage === null) return false;
    try {
      if (journal.entries.length === 0) {
        storage.removeItem(storageKey);
      } else {
        storage.setItem(storageKey, JSON.stringify(journal));
      }
      return true;
    } catch {
      return false;
    }
  };

  const readStoredJournal = (sessionId: string): ReadStoredJournalResult => {
    const storageKey = getSessionResultsMutationJournalStorageKey(sessionId);
    if (storage === null || storageKey === null) return { kind: "unavailable" };

    let rawJournal: string | null;
    try {
      rawJournal = storage.getItem(storageKey);
    } catch {
      return { kind: "unavailable" };
    }
    if (rawJournal === null) return { kind: "missing" };

    let value: unknown;
    try {
      value = JSON.parse(rawJournal);
    } catch {
      removeStoredJournal(storageKey);
      return { kind: "missing" };
    }

    const nowMs = getNowMs();
    if (
      !isJournalRecord(value) ||
      value.schema !== SESSION_RESULTS_MUTATION_JOURNAL_SCHEMA ||
      value.schemaVersion !==
        SESSION_RESULTS_MUTATION_JOURNAL_SCHEMA_VERSION ||
      value.sessionId !== sessionId ||
      !isSafeSessionResultsJournalTimestamp(
        value.updatedAtMs,
        nowMs,
        maximumAgeMs
      ) ||
      !Array.isArray(value.entries) ||
      value.entries.length > SESSION_RESULTS_MUTATION_JOURNAL_MAX_ENTRIES
    ) {
      removeStoredJournal(storageKey);
      return { kind: "missing" };
    }

    const entriesByIdeaId = new Map<
      string,
      SessionResultsMutationJournalEntry
    >();
    let cleaned = false;
    for (const candidateEntry of value.entries) {
      const entry = parseMutationJournalEntry(
        candidateEntry,
        nowMs,
        maximumAgeMs
      );
      if (entry === null) {
        cleaned = true;
        continue;
      }
      const previousEntry = entriesByIdeaId.get(entry.ideaId);
      if (previousEntry !== undefined) cleaned = true;
      if (
        previousEntry === undefined ||
        previousEntry.updatedAtMs < entry.updatedAtMs
      ) {
        entriesByIdeaId.set(entry.ideaId, entry);
      }
    }

    const journal: StoredSessionResultsMutationJournal = {
      schema: SESSION_RESULTS_MUTATION_JOURNAL_SCHEMA,
      schemaVersion: SESSION_RESULTS_MUTATION_JOURNAL_SCHEMA_VERSION,
      sessionId,
      updatedAtMs: value.updatedAtMs,
      entries: [...entriesByIdeaId.values()],
    };
    if (cleaned) storeJournal(storageKey, journal);
    return { kind: "valid", journal };
  };

  return {
    readSessionEntries(sessionId) {
      const result = readStoredJournal(sessionId);
      return result.kind === "valid"
        ? result.journal.entries.map((entry) => ({
            ...entry,
            lastAcknowledged: { ...entry.lastAcknowledged },
            latestDesired: { ...entry.latestDesired },
            inFlight: entry.inFlight === null ? null : { ...entry.inFlight },
            unsettledInFlight: entry.unsettledInFlight.map((payload) => ({
              ...payload,
            })),
          }))
        : [];
    },

    writeSessionEntry(sessionId, entryInput) {
      const storageKey = getSessionResultsMutationJournalStorageKey(sessionId);
      if (storageKey === null || storage === null) return false;

      const nowMs = getNowMs();
      const parsedEntry = parseMutationJournalEntry(
        { ...entryInput, updatedAtMs: nowMs },
        nowMs,
        maximumAgeMs
      );
      if (parsedEntry === null) return false;

      const result = readStoredJournal(sessionId);
      if (result.kind === "unavailable") return false;
      const entries =
        result.kind === "valid"
          ? result.journal.entries.filter(
              (entry) => entry.ideaId !== parsedEntry.ideaId
            )
          : [];
      entries.push(parsedEntry);
      entries.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
      if (entries.length > SESSION_RESULTS_MUTATION_JOURNAL_MAX_ENTRIES) {
        entries.length = SESSION_RESULTS_MUTATION_JOURNAL_MAX_ENTRIES;
      }

      return storeJournal(storageKey, {
        schema: SESSION_RESULTS_MUTATION_JOURNAL_SCHEMA,
        schemaVersion: SESSION_RESULTS_MUTATION_JOURNAL_SCHEMA_VERSION,
        sessionId,
        updatedAtMs: nowMs,
        entries,
      });
    },

    removeSessionEntryIfAcknowledged(sessionId, acknowledgement) {
      if (
        !isSafeSessionResultsJournalId(acknowledgement.ideaId) ||
        parseVersionedIdeaPayload(acknowledgement) === null
      ) {
        return false;
      }
      const storageKey = getSessionResultsMutationJournalStorageKey(sessionId);
      if (storageKey === null) return false;
      const result = readStoredJournal(sessionId);
      if (result.kind !== "valid") return false;

      const matchingEntry = result.journal.entries.find(
        (entry) => entry.ideaId === acknowledgement.ideaId
      );
      if (
        matchingEntry === undefined ||
        !hasSameVersionedIdeaPayload(
          matchingEntry.latestDesired,
          acknowledgement
        )
      ) {
        return false;
      }

      return storeJournal(storageKey, {
        ...result.journal,
        updatedAtMs: getNowMs(),
        entries: result.journal.entries.filter(
          (entry) => entry.ideaId !== acknowledgement.ideaId
        ),
      });
    },

    removeUnknownSessionEntries(sessionId, knownIdeaIds) {
      const storageKey = getSessionResultsMutationJournalStorageKey(sessionId);
      if (storageKey === null) return 0;
      const result = readStoredJournal(sessionId);
      if (result.kind !== "valid") return 0;

      const retainedEntries = result.journal.entries.filter((entry) =>
        knownIdeaIds.has(entry.ideaId)
      );
      const removedCount =
        result.journal.entries.length - retainedEntries.length;
      if (removedCount === 0) return 0;
      const removed = storeJournal(storageKey, {
        ...result.journal,
        updatedAtMs: getNowMs(),
        entries: retainedEntries,
      });
      return removed ? removedCount : 0;
    },
  };
}

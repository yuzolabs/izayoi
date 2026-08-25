import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  createSessionResultsMutationJournal,
  getSessionResultsMutationJournalStorageKey,
  type SessionResultsMutationJournalEntryInput,
  type SessionResultsMutationJournalStorage,
} from "./session-results-mutation-journal";

class FakeSessionResultsJournalStorage
  implements SessionResultsMutationJournalStorage
{
  readonly values = new Map<string, string>();
  readonly operations: string[] = [];

  getItem(key: string): string | null {
    this.operations.push(`get:${key}`);
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.operations.push(`set:${key}`);
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.operations.push(`remove:${key}`);
    this.values.delete(key);
  }
}

function makeJournalEntry(
  ideaId: string,
  version = 1
): SessionResultsMutationJournalEntryInput {
  return {
    ideaId,
    monotonicVersion: version,
    lastAcknowledged: { decision: "pending", note: "Server memo" },
    latestDesired: {
      version,
      decision: "adopted",
      note: "Desired memo",
    },
    inFlight: {
      version,
      decision: "adopted",
      note: "Desired memo",
    },
    unsettledInFlight: [],
  };
}

function getRequiredStorageKey(sessionId: string): string {
  const key = getSessionResultsMutationJournalStorageKey(sessionId);
  assert.ok(key);
  return key;
}

describe("session Results mutation journal", () => {
  test("stores versioned queues separately per session and returns defensive values", () => {
    const storage = new FakeSessionResultsJournalStorage();
    let nowMs = 10_000;
    const journal = createSessionResultsMutationJournal({
      storage,
      now: () => nowMs,
    });

    assert.equal(journal.writeSessionEntry("session-a", makeJournalEntry("idea-a")), true);
    nowMs += 1;
    assert.equal(
      journal.writeSessionEntry("session-a", {
        ...makeJournalEntry("idea-b", 2),
        unsettledInFlight: [
          { version: 1, decision: "held", note: "Interrupted memo" },
        ],
      }),
      true
    );
    assert.equal(journal.writeSessionEntry("session-b", makeJournalEntry("idea-c")), true);

    const firstRead = journal.readSessionEntries("session-a");
    assert.deepEqual(
      firstRead.map((entry) => entry.ideaId).sort(),
      ["idea-a", "idea-b"]
    );
    assert.deepEqual(firstRead.find((entry) => entry.ideaId === "idea-b"), {
      ...makeJournalEntry("idea-b", 2),
      unsettledInFlight: [
        { version: 1, decision: "held", note: "Interrupted memo" },
      ],
      updatedAtMs: 10_001,
    });
    firstRead[0]!.latestDesired.note = "Mutated read";
    assert.notEqual(
      journal.readSessionEntries("session-a")[0]?.latestDesired.note,
      "Mutated read"
    );
    assert.deepEqual(
      journal.readSessionEntries("session-b").map((entry) => entry.ideaId),
      ["idea-c"]
    );
  });

  test("removes only the current matching version and payload acknowledgement", () => {
    const storage = new FakeSessionResultsJournalStorage();
    const journal = createSessionResultsMutationJournal({
      storage,
      now: () => 20_000,
    });
    assert.equal(
      journal.writeSessionEntry("session-ack", makeJournalEntry("idea-ack", 3)),
      true
    );

    assert.equal(
      journal.removeSessionEntryIfAcknowledged("session-ack", {
        ideaId: "idea-ack",
        version: 2,
        decision: "adopted",
        note: "Desired memo",
      }),
      false
    );
    assert.equal(
      journal.removeSessionEntryIfAcknowledged("session-ack", {
        ideaId: "idea-ack",
        version: 3,
        decision: "rejected",
        note: "Desired memo",
      }),
      false
    );
    assert.equal(
      journal.removeSessionEntryIfAcknowledged("session-ack", {
        ideaId: "idea-ack",
        version: 3,
        decision: "adopted",
        note: "Stale memo",
      }),
      false
    );
    assert.equal(journal.readSessionEntries("session-ack").length, 1);

    assert.equal(
      journal.removeSessionEntryIfAcknowledged("session-ack", {
        ideaId: "idea-ack",
        version: 3,
        decision: "adopted",
        note: "Desired memo",
      }),
      true
    );
    assert.equal(journal.readSessionEntries("session-ack").length, 0);
    assert.equal(
      storage.values.has(getRequiredStorageKey("session-ack")),
      false
    );
  });

  test("cleans unknown, corrupt, unsafe, and expired entries without throwing", () => {
    const storage = new FakeSessionResultsJournalStorage();
    let nowMs = 30_000;
    const journal = createSessionResultsMutationJournal({
      storage,
      now: () => nowMs,
      maximumAgeMs: 100,
    });
    journal.writeSessionEntry("session-clean", makeJournalEntry("known-idea"));
    journal.writeSessionEntry("session-clean", makeJournalEntry("removed-idea"));

    assert.equal(
      journal.removeUnknownSessionEntries(
        "session-clean",
        new Set(["known-idea"])
      ),
      1
    );
    assert.deepEqual(
      journal.readSessionEntries("session-clean").map((entry) => entry.ideaId),
      ["known-idea"]
    );

    const storageKey = getRequiredStorageKey("session-clean");
    const unsafeDocument = JSON.parse(storage.values.get(storageKey)!) as {
      entries: Array<Record<string, unknown>>;
    };
    unsafeDocument.entries.push({
      ...unsafeDocument.entries[0],
      ideaId: "../unsafe-idea",
      latestDesired: {
        version: 1,
        decision: "not-a-decision",
        note: "x".repeat(100_001),
      },
    });
    storage.values.set(storageKey, JSON.stringify(unsafeDocument));
    assert.deepEqual(
      journal.readSessionEntries("session-clean").map((entry) => entry.ideaId),
      ["known-idea"]
    );

    nowMs += 101;
    assert.deepEqual(journal.readSessionEntries("session-clean"), []);
    assert.equal(storage.values.has(storageKey), false);

    storage.values.set(storageKey, "{ definitely not JSON");
    assert.deepEqual(journal.readSessionEntries("session-clean"), []);
    assert.equal(storage.values.has(storageKey), false);
  });

  test("rejects mismatched top-level schemas and impossible queue versions", () => {
    const storage = new FakeSessionResultsJournalStorage();
    const nowMs = 50_000;
    const journal = createSessionResultsMutationJournal({
      storage,
      now: () => nowMs,
    });
    assert.equal(
      journal.writeSessionEntry(
        "session-schema",
        makeJournalEntry("idea-schema")
      ),
      true
    );
    const storageKey = getRequiredStorageKey("session-schema");
    const validRawDocument = storage.values.get(storageKey);
    assert.ok(validRawDocument);

    const makeInvalidDocument = (
      mutate: (document: Record<string, unknown>) => void
    ): string => {
      const document = JSON.parse(validRawDocument) as Record<string, unknown>;
      mutate(document);
      return JSON.stringify(document);
    };
    const invalidDocuments = [
      makeInvalidDocument((document) => {
        document.schema = "izayoi.other-schema";
      }),
      makeInvalidDocument((document) => {
        document.schemaVersion = 2;
      }),
      makeInvalidDocument((document) => {
        document.sessionId = "another-session";
      }),
      makeInvalidDocument((document) => {
        document.updatedAtMs = nowMs + 5 * 60 * 1_000 + 1;
      }),
      makeInvalidDocument((document) => {
        const entries = document.entries as Array<Record<string, unknown>>;
        assert.ok(entries[0]);
        entries[0].monotonicVersion = 2;
      }),
    ];

    for (const invalidDocument of invalidDocuments) {
      storage.values.set(storageKey, invalidDocument);
      assert.deepEqual(journal.readSessionEntries("session-schema"), []);
      assert.equal(storage.values.has(storageKey), false);
    }
  });

  test("rejects unsafe IDs and survives unavailable storage operations", () => {
    const throwingStorage: SessionResultsMutationJournalStorage = {
      getItem() {
        throw new DOMException("sessionStorage blocked", "SecurityError");
      },
      setItem() {
        throw new DOMException("sessionStorage quota", "QuotaExceededError");
      },
      removeItem() {
        throw new DOMException("sessionStorage blocked", "SecurityError");
      },
    };
    const journal = createSessionResultsMutationJournal({
      storage: throwingStorage,
      now: () => 40_000,
    });

    assert.doesNotThrow(() => journal.readSessionEntries("session-unavailable"));
    assert.deepEqual(journal.readSessionEntries("session-unavailable"), []);
    assert.doesNotThrow(() =>
      journal.writeSessionEntry(
        "session-unavailable",
        makeJournalEntry("idea-unavailable")
      )
    );
    assert.equal(
      journal.writeSessionEntry(
        "session-unavailable",
        makeJournalEntry("idea-unavailable")
      ),
      false
    );
    assert.equal(
      journal.removeSessionEntryIfAcknowledged("session-unavailable", {
        ideaId: "idea-unavailable",
        version: 1,
        decision: "adopted",
        note: "Desired memo",
      }),
      false
    );
    assert.equal(getSessionResultsMutationJournalStorageKey("../session"), null);
    assert.equal(
      journal.writeSessionEntry(
        "session-unavailable",
        makeJournalEntry("../idea")
      ),
      false
    );

    const quotaStorage: SessionResultsMutationJournalStorage = {
      getItem() {
        return null;
      },
      setItem() {
        throw new DOMException("sessionStorage quota", "QuotaExceededError");
      },
      removeItem() {},
    };
    const quotaJournal = createSessionResultsMutationJournal({
      storage: quotaStorage,
      now: () => 40_000,
    });
    assert.equal(
      quotaJournal.writeSessionEntry(
        "session-quota",
        makeJournalEntry("idea-quota")
      ),
      false
    );

    const failedCleanupStorage: SessionResultsMutationJournalStorage = {
      getItem() {
        return "{ invalid journal";
      },
      setItem() {},
      removeItem() {
        throw new DOMException("sessionStorage blocked", "SecurityError");
      },
    };
    const failedCleanupJournal = createSessionResultsMutationJournal({
      storage: failedCleanupStorage,
      now: () => 40_000,
    });
    assert.doesNotThrow(() =>
      failedCleanupJournal.readSessionEntries("session-cleanup-blocked")
    );
    assert.deepEqual(
      failedCleanupJournal.readSessionEntries("session-cleanup-blocked"),
      []
    );
  });
});

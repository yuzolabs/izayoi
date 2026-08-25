import { strict as assert } from "node:assert";
import { after, before, beforeEach, describe, test } from "node:test";

import { fireEvent } from "@testing-library/dom";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";

import {
  api,
  ApiRequestError,
  type Decision,
  type Idea,
  type Session,
} from "@/lib/api";
import {
  getResultsIdeaMemoFieldElementId,
  RESULTS_IDEA_MEMO_TOO_LONG_ERROR,
} from "@/lib/results-idea-memo-field-validation";
import { registerHappyDomTestEnvironment } from "@/test-support/happy-dom-test-environment";
import {
  createSessionResultsMutationJournal,
  type SessionResultsMutationJournal,
  type SessionResultsMutationJournalStorage,
} from "@/lib/session-results-mutation-journal";
import type { SessionResultsMutationRecoveryPolicy } from "@/lib/use-session-results-idea-mutation-coordinator";

import { SessionResults } from "./session-results";

const RESULTS_SESSION: Session = {
  id: "session-1",
  theme: "Choose a neighborhood pilot",
  constraints: "Keep the first trial reversible",
  status: "done",
  phase_progress: "done",
  agents: [],
  created_at: "2026-08-24T00:00:00Z",
  metrics: null,
};

const originalApiMethods = {
  getSession: api.getSession,
  listIdeas: api.listIdeas,
  listMessages: api.listMessages,
  updateDecision: api.updateDecision,
};

interface DeferredResult<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

interface DeferredDecisionRequest {
  ideaId: string;
  decision: Decision;
  note: string | undefined;
  deferred: DeferredResult<Idea>;
}

interface RenderedResults {
  root: Root;
  container: HTMLDivElement;
  requests: DeferredDecisionRequest[];
  unmount: () => Promise<void>;
}

interface RenderSessionResultsOptions {
  mutationJournal?: SessionResultsMutationJournal;
  mutationRecoveryPolicy?: SessionResultsMutationRecoveryPolicy;
  listIdeas?: (sessionId: string) => Promise<{ ideas: Idea[] }>;
  updateDecision?: (
    ideaId: string,
    decision: Decision,
    note?: string
  ) => Promise<Idea>;
}

class FakeResultsMutationJournalStorage
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

const IMMEDIATE_RESULTS_MUTATION_RECOVERY_POLICY: SessionResultsMutationRecoveryPolicy = {
  revalidationDelaysMs: [0],
  maximumReplayAttempts: 1,
  waitForDelay: async () => Promise.resolve(),
};

function createDeferredResult<T>(): DeferredResult<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function makeResultsIdea(
  id: string,
  decision: Decision = "pending",
  note = "Baseline memo",
  content = `Idea ${id}`,
  sessionId = RESULTS_SESSION.id
): Idea {
  return {
    id,
    session_id: sessionId,
    persona_type: "ARCHITECT",
    phase: "divergence",
    content,
    cluster_id: 1,
    synthesized: "Cluster 1 synthesis",
    scores: null,
    decision,
    note,
  };
}

function getRequiredElement<T extends Element>(
  selector: string,
  parent: ParentNode = document
): T {
  const element = parent.querySelector<T>(selector);
  assert.ok(element, `Expected DOM element matching ${selector}`);
  return element;
}

function getIdeaCard(content: string, parent: ParentNode = document): HTMLElement {
  const card = [...parent.querySelectorAll<HTMLElement>("article")].find((candidate) =>
    candidate.textContent?.includes(content)
  );
  assert.ok(card, `Expected idea card containing “${content}”`);
  return card;
}

function getButtonWithText(label: string, parent: ParentNode): HTMLButtonElement {
  const button = [...parent.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label
  );
  assert.ok(button, `Expected button with text “${label}”`);
  return button;
}

function getSaveStatus(card: ParentNode): HTMLElement {
  return getRequiredElement<HTMLElement>('[role="status"]', card);
}

function getSaveAnnouncement(container: ParentNode): string {
  return getRequiredElement<HTMLElement>("p.sr-only[role=\"status\"]", container)
    .textContent ?? "";
}

function assertCurrentDecision(card: ParentNode, decisionLabel: string): void {
  const badge = getRequiredElement<HTMLElement>(
    `[aria-label="Current decision: ${decisionLabel}"]`,
    card
  );
  assert.ok(badge);
}

async function flushSessionResultsDomUpdates(frameCount = 3): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  for (let frame = 0; frame < frameCount; frame += 1) {
    await act(
      () =>
        new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        })
    );
  }
}

async function setTextareaValue(
  textarea: HTMLTextAreaElement,
  value: string
): Promise<void> {
  await act(async () => {
    fireEvent.input(textarea, { target: { value } });
  });
}

function makeDecisionResponse(
  originalIdea: Idea,
  request: DeferredDecisionRequest
): Idea {
  return {
    ...originalIdea,
    decision: request.decision,
    note: request.note ?? originalIdea.note,
  };
}

async function resolveDecisionRequest(
  request: DeferredDecisionRequest,
  response: Idea
): Promise<void> {
  await act(async () => {
    request.deferred.resolve(response);
    await request.deferred.promise;
    await Promise.resolve();
  });
  await flushSessionResultsDomUpdates();
}

async function rejectDecisionRequest(
  request: DeferredDecisionRequest,
  reason: string | Error
): Promise<void> {
  await act(async () => {
    request.deferred.reject(
      reason instanceof Error ? reason : new Error(reason)
    );
    try {
      await request.deferred.promise;
    } catch {
      // The coordinator consumes this expected API rejection.
    }
    await Promise.resolve();
  });
  await flushSessionResultsDomUpdates();
}

async function resolveIdeasRevalidation(
  deferred: DeferredResult<{ ideas: Idea[] }>,
  ideas: Idea[]
): Promise<void> {
  await act(async () => {
    deferred.resolve({ ideas });
    await deferred.promise;
    await Promise.resolve();
  });
  await flushSessionResultsDomUpdates();
}

async function renderSessionResults(
  ideasBySessionId: Record<string, Idea[]>,
  includeSessionNavigation = false,
  options: RenderSessionResultsOptions = {}
): Promise<RenderedResults> {
  const requests: DeferredDecisionRequest[] = [];
  api.getSession = async (sessionId) => ({ ...RESULTS_SESSION, id: sessionId });
  api.listIdeas =
    options.listIdeas ??
    (async (sessionId) => ({
      ideas: ideasBySessionId[sessionId] ?? [],
    }));
  api.listMessages = async () => ({ messages: [] });
  api.updateDecision =
    options.updateDecision ??
    ((ideaId, decision, note) => {
      const deferred = createDeferredResult<Idea>();
      requests.push({ ideaId, decision, note, deferred });
      return deferred.promise;
    });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <StrictMode>
        <MemoryRouter initialEntries={["/session/session-1/results"]}>
          {includeSessionNavigation && (
            <Link to="/session/session-2/results">Open second session</Link>
          )}
          <Routes>
            <Route
              path="/session/:id/results"
              element={
                <SessionResults
                  mutationJournal={options.mutationJournal}
                  mutationRecoveryPolicy={options.mutationRecoveryPolicy}
                />
              }
            />
          </Routes>
        </MemoryRouter>
      </StrictMode>
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  await flushSessionResultsDomUpdates();

  return {
    root,
    container,
    requests,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

let cleanupHappyDomEnvironment: (() => Promise<void>) | undefined;

before(() => {
  cleanupHappyDomEnvironment = registerHappyDomTestEnvironment({
    reactActEnvironment: true,
    url: "http://localhost/session/session-1/results",
  }).cleanup;
});

beforeEach(() => {
  window.sessionStorage.clear();
});

after(async () => {
  api.getSession = originalApiMethods.getSession;
  api.listIdeas = originalApiMethods.listIdeas;
  api.listMessages = originalApiMethods.listMessages;
  api.updateDecision = originalApiMethods.updateDecision;
  await cleanupHappyDomEnvironment?.();
});

describe("Session Results per-idea save mutation coordinator", () => {
  test("single-flights same-tick Adopt then Reject and sends only the latest queued payload", async () => {
    const originalIdea = makeResultsIdea("one");
    const rendered = await renderSessionResults({ "session-1": [originalIdea] });
    try {
      const initialCard = getIdeaCard(originalIdea.content, rendered.container);
      await act(async () => {
        getButtonWithText("Adopt", initialCard).click();
        getButtonWithText("Reject", initialCard).click();
      });

      assert.equal(rendered.requests.length, 1);
      assert.deepEqual(
        {
          ideaId: rendered.requests[0]?.ideaId,
          decision: rendered.requests[0]?.decision,
          note: rendered.requests[0]?.note,
        },
        { ideaId: originalIdea.id, decision: "adopted", note: originalIdea.note }
      );
      let currentCard = getIdeaCard(originalIdea.content, rendered.container);
      assertCurrentDecision(currentCard, "Rejected");
      assert.match(getSaveStatus(currentCard).textContent ?? "", /Saving/);
      assert.equal(getButtonWithText("Adopt", currentCard).disabled, false);
      assert.equal(getButtonWithText("Reject", currentCard).disabled, false);

      const firstRequest = rendered.requests[0];
      assert.ok(firstRequest);
      await resolveDecisionRequest(
        firstRequest,
        makeDecisionResponse(originalIdea, firstRequest)
      );

      assert.equal(rendered.requests.length, 2);
      const latestRequest = rendered.requests[1];
      assert.ok(latestRequest);
      assert.deepEqual(
        { decision: latestRequest.decision, note: latestRequest.note },
        { decision: "rejected", note: originalIdea.note }
      );
      currentCard = getIdeaCard(originalIdea.content, rendered.container);
      assertCurrentDecision(currentCard, "Rejected");
      assert.match(getSaveStatus(currentCard).textContent ?? "", /Saving/);

      await resolveDecisionRequest(
        latestRequest,
        makeDecisionResponse(originalIdea, latestRequest)
      );
      currentCard = getIdeaCard(originalIdea.content, rendered.container);
      assertCurrentDecision(currentCard, "Rejected");
      assert.equal(getSaveStatus(currentCard).textContent?.trim(), "Saved");
      assert.match(getSaveAnnouncement(rendered.container), /Saved rejected decision/);
    } finally {
      await rendered.unmount();
    }
  });

  test("merges a memo entered during an in-flight decision into the queued desired state", async () => {
    const originalIdea = makeResultsIdea("memo");
    const rendered = await renderSessionResults({ "session-1": [originalIdea] });
    try {
      let card = getIdeaCard(originalIdea.content, rendered.container);
      await act(async () => getButtonWithText("Adopt", card).click());
      card = getIdeaCard(originalIdea.content, rendered.container);
      const textarea = getRequiredElement<HTMLTextAreaElement>("textarea", card);
      assert.equal(textarea.disabled, false);
      await setTextareaValue(textarea, "Queued decision memo");
      await act(async () => getButtonWithText("Save memo", card).click());

      assert.equal(rendered.requests.length, 1);
      const decisionRequest = rendered.requests[0];
      assert.ok(decisionRequest);
      await resolveDecisionRequest(
        decisionRequest,
        makeDecisionResponse(originalIdea, decisionRequest)
      );

      assert.equal(rendered.requests.length, 2);
      const memoRequest = rendered.requests[1];
      assert.ok(memoRequest);
      assert.deepEqual(
        { decision: memoRequest.decision, note: memoRequest.note },
        { decision: "adopted", note: "Queued decision memo" }
      );
      card = getIdeaCard(originalIdea.content, rendered.container);
      assertCurrentDecision(card, "Adopted");
      assert.match(getSaveStatus(card).textContent ?? "", /Saving/);
      assert.equal(
        getRequiredElement<HTMLTextAreaElement>("textarea", card).value,
        "Queued decision memo"
      );

      await resolveDecisionRequest(
        memoRequest,
        makeDecisionResponse(originalIdea, memoRequest)
      );
      card = getIdeaCard(originalIdea.content, rendered.container);
      assert.equal(getSaveStatus(card).textContent?.trim(), "Saved");
      assert.equal(
        getRequiredElement<HTMLTextAreaElement>("textarea", card).value,
        "Queued decision memo"
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("reload GET pending waits for the interrupted Adopt acknowledgement before settling", async () => {
    const originalIdea = makeResultsIdea("reload-adopt");
    const storage = new FakeResultsMutationJournalStorage();
    const journal = createSessionResultsMutationJournal({ storage });
    const firstRender = await renderSessionResults(
      { "session-1": [originalIdea] },
      false,
      {
        mutationJournal: journal,
        mutationRecoveryPolicy:
          IMMEDIATE_RESULTS_MUTATION_RECOVERY_POLICY,
      }
    );

    const firstCard = getIdeaCard(originalIdea.content, firstRender.container);
    await act(async () => getButtonWithText("Adopt", firstCard).click());
    const interruptedRequest = firstRender.requests[0];
    assert.ok(interruptedRequest);
    assert.equal(journal.readSessionEntries("session-1").length, 1);
    await firstRender.unmount();

    const recoveryRevalidation = createDeferredResult<{ ideas: Idea[] }>();
    let listIdeasCallCount = 0;
    const secondRender = await renderSessionResults(
      { "session-1": [originalIdea] },
      false,
      {
        mutationJournal: journal,
        mutationRecoveryPolicy:
          IMMEDIATE_RESULTS_MUTATION_RECOVERY_POLICY,
        listIdeas: async () => {
          listIdeasCallCount += 1;
          return listIdeasCallCount <= 2
            ? { ideas: [originalIdea] }
            : recoveryRevalidation.promise;
        },
      }
    );
    try {
      let recoveredCard = getIdeaCard(
        originalIdea.content,
        secondRender.container
      );
      assertCurrentDecision(recoveredCard, "Adopted");
      assert.match(getSaveStatus(recoveredCard).textContent ?? "", /Recovery check/);
      assert.equal(secondRender.requests.length, 0);

      const adoptedIdea = makeDecisionResponse(
        originalIdea,
        interruptedRequest
      );
      await resolveDecisionRequest(interruptedRequest, adoptedIdea);
      assert.equal(
        journal.readSessionEntries("session-1").length,
        1,
        "a completion from the unmounted generation must not clear the journal"
      );
      await resolveIdeasRevalidation(recoveryRevalidation, [adoptedIdea]);

      recoveredCard = getIdeaCard(
        originalIdea.content,
        secondRender.container
      );
      assertCurrentDecision(recoveredCard, "Adopted");
      assert.equal(getSaveStatus(recoveredCard).textContent?.trim(), "Saved");
      assert.equal(secondRender.requests.length, 0);
      assert.equal(journal.readSessionEntries("session-1").length, 0);
    } finally {
      await secondRender.unmount();
    }
  });

  test("reload queues latest Reject and memo until the interrupted Adopt commits", async () => {
    const originalIdea = makeResultsIdea("reload-latest-wins");
    const storage = new FakeResultsMutationJournalStorage();
    const journal = createSessionResultsMutationJournal({ storage });
    const firstRender = await renderSessionResults(
      { "session-1": [originalIdea] },
      false,
      {
        mutationJournal: journal,
        mutationRecoveryPolicy:
          IMMEDIATE_RESULTS_MUTATION_RECOVERY_POLICY,
      }
    );
    const firstCard = getIdeaCard(originalIdea.content, firstRender.container);
    await act(async () => getButtonWithText("Adopt", firstCard).click());
    const interruptedAdoptRequest = firstRender.requests[0];
    assert.ok(interruptedAdoptRequest);
    await firstRender.unmount();

    const recoveryRevalidation = createDeferredResult<{ ideas: Idea[] }>();
    let listIdeasCallCount = 0;
    const secondRender = await renderSessionResults(
      { "session-1": [originalIdea] },
      false,
      {
        mutationJournal: journal,
        mutationRecoveryPolicy:
          IMMEDIATE_RESULTS_MUTATION_RECOVERY_POLICY,
        listIdeas: async () => {
          listIdeasCallCount += 1;
          return listIdeasCallCount <= 2
            ? { ideas: [originalIdea] }
            : recoveryRevalidation.promise;
        },
      }
    );
    try {
      let recoveredCard = getIdeaCard(
        originalIdea.content,
        secondRender.container
      );
      assertCurrentDecision(recoveredCard, "Adopted");
      await setTextareaValue(
        getRequiredElement<HTMLTextAreaElement>("textarea", recoveredCard),
        "Latest rejection memo"
      );
      await act(async () =>
        getButtonWithText("Reject", recoveredCard).click()
      );
      recoveredCard = getIdeaCard(
        originalIdea.content,
        secondRender.container
      );
      assertCurrentDecision(recoveredCard, "Rejected");
      assert.match(getSaveStatus(recoveredCard).textContent ?? "", /Recovering/);
      assert.equal(secondRender.requests.length, 0);

      const adoptedIdea = makeDecisionResponse(
        originalIdea,
        interruptedAdoptRequest
      );
      await resolveDecisionRequest(interruptedAdoptRequest, adoptedIdea);
      await resolveIdeasRevalidation(recoveryRevalidation, [adoptedIdea]);

      assert.equal(secondRender.requests.length, 1);
      const latestRequest = secondRender.requests[0];
      assert.ok(latestRequest);
      assert.deepEqual(
        {
          decision: latestRequest.decision,
          note: latestRequest.note,
        },
        { decision: "rejected", note: "Latest rejection memo" }
      );
      await resolveDecisionRequest(
        latestRequest,
        makeDecisionResponse(adoptedIdea, latestRequest)
      );

      recoveredCard = getIdeaCard(
        originalIdea.content,
        secondRender.container
      );
      assertCurrentDecision(recoveredCard, "Rejected");
      assert.equal(getSaveStatus(recoveredCard).textContent?.trim(), "Saved");
      assert.equal(journal.readSessionEntries("session-1").length, 0);
    } finally {
      await secondRender.unmount();
    }
  });

  test("uses an explicit bounded replay and verification status when old PATCH remains ambiguous", async () => {
    const originalIdea = makeResultsIdea("bounded-recovery");
    let serverIdea = originalIdea;
    const storage = new FakeResultsMutationJournalStorage();
    const journal = createSessionResultsMutationJournal({ storage });
    journal.writeSessionEntry("session-1", {
      ideaId: originalIdea.id,
      monotonicVersion: 2,
      lastAcknowledged: {
        decision: originalIdea.decision,
        note: originalIdea.note,
      },
      latestDesired: {
        version: 2,
        decision: "rejected",
        note: "Bounded latest memo",
      },
      inFlight: {
        version: 1,
        decision: "adopted",
        note: originalIdea.note,
      },
      unsettledInFlight: [],
    });

    const rendered = await renderSessionResults(
      { "session-1": [originalIdea] },
      false,
      {
        mutationJournal: journal,
        mutationRecoveryPolicy:
          IMMEDIATE_RESULTS_MUTATION_RECOVERY_POLICY,
        listIdeas: async () => ({ ideas: [serverIdea] }),
      }
    );
    try {
      assert.equal(rendered.requests.length, 1);
      const [replayJournalEntry] = journal.readSessionEntries("session-1");
      assert.ok(replayJournalEntry);
      assert.equal(replayJournalEntry.monotonicVersion, 3);
      assert.equal(replayJournalEntry.latestDesired.version, 3);
      assert.equal(replayJournalEntry.inFlight?.version, 3);
      assert.deepEqual(
        replayJournalEntry.unsettledInFlight.map((payload) => payload.version),
        [1]
      );
      let card = getIdeaCard(originalIdea.content, rendered.container);
      assertCurrentDecision(card, "Rejected");
      assert.match(
        getSaveStatus(card).textContent ?? "",
        /Recovery window ended; replaying latest change 1\/1/
      );

      const replayRequest = rendered.requests[0];
      assert.ok(replayRequest);
      serverIdea = makeDecisionResponse(originalIdea, replayRequest);
      await resolveDecisionRequest(replayRequest, serverIdea);

      card = getIdeaCard(originalIdea.content, rendered.container);
      assertCurrentDecision(card, "Rejected");
      assert.equal(getSaveStatus(card).textContent?.trim(), "Saved");
      assert.equal(journal.readSessionEntries("session-1").length, 0);
    } finally {
      await rendered.unmount();
    }
  });

  test("replays latest Reject again when old Adopt commits after the first recovery replay", async () => {
    const originalIdea = makeResultsIdea("late-old-commit");
    const storage = new FakeResultsMutationJournalStorage();
    const journal = createSessionResultsMutationJournal({ storage });
    journal.writeSessionEntry("session-1", {
      ideaId: originalIdea.id,
      monotonicVersion: 2,
      lastAcknowledged: {
        decision: originalIdea.decision,
        note: originalIdea.note,
      },
      latestDesired: {
        version: 2,
        decision: "rejected",
        note: "Latest after late commit",
      },
      inFlight: {
        version: 1,
        decision: "adopted",
        note: originalIdea.note,
      },
      unsettledInFlight: [],
    });
    const lateCommitRevalidation = createDeferredResult<{ ideas: Idea[] }>();
    let listIdeasCallCount = 0;
    const recoveryPolicy: SessionResultsMutationRecoveryPolicy = {
      ...IMMEDIATE_RESULTS_MUTATION_RECOVERY_POLICY,
      maximumReplayAttempts: 2,
    };
    const rendered = await renderSessionResults(
      { "session-1": [originalIdea] },
      false,
      {
        mutationJournal: journal,
        mutationRecoveryPolicy: recoveryPolicy,
        listIdeas: async () => {
          listIdeasCallCount += 1;
          return listIdeasCallCount <= 3
            ? { ideas: [originalIdea] }
            : lateCommitRevalidation.promise;
        },
      }
    );
    try {
      assert.equal(rendered.requests.length, 1);
      const firstRejectReplay = rendered.requests[0];
      assert.ok(firstRejectReplay);
      assert.equal(firstRejectReplay.decision, "rejected");
      await resolveDecisionRequest(
        firstRejectReplay,
        makeDecisionResponse(originalIdea, firstRejectReplay)
      );

      const lateAdoptIdea: Idea = {
        ...originalIdea,
        decision: "adopted",
      };
      await resolveIdeasRevalidation(lateCommitRevalidation, [lateAdoptIdea]);
      assert.equal(rendered.requests.length, 2);
      const finalRejectReplay = rendered.requests[1];
      assert.ok(finalRejectReplay);
      assert.deepEqual(
        {
          decision: finalRejectReplay.decision,
          note: finalRejectReplay.note,
        },
        { decision: "rejected", note: "Latest after late commit" }
      );
      const [finalReplayJournalEntry] =
        journal.readSessionEntries("session-1");
      assert.ok(finalReplayJournalEntry);
      assert.equal(finalReplayJournalEntry.monotonicVersion, 4);
      assert.equal(finalReplayJournalEntry.inFlight?.version, 4);
      assert.deepEqual(finalReplayJournalEntry.unsettledInFlight, []);
      await resolveDecisionRequest(
        finalRejectReplay,
        makeDecisionResponse(lateAdoptIdea, finalRejectReplay)
      );

      const card = getIdeaCard(originalIdea.content, rendered.container);
      assertCurrentDecision(card, "Rejected");
      assert.equal(getSaveStatus(card).textContent?.trim(), "Saved");
      assert.equal(journal.readSessionEntries("session-1").length, 0);
    } finally {
      await rendered.unmount();
    }
  });

  test("rolls back a failed reload replay, retains its journal, and retries the exact payload", async () => {
    const originalIdea = makeResultsIdea("reload-retry");
    const storage = new FakeResultsMutationJournalStorage();
    const journal = createSessionResultsMutationJournal({ storage });
    journal.writeSessionEntry("session-1", {
      ideaId: originalIdea.id,
      monotonicVersion: 1,
      lastAcknowledged: {
        decision: originalIdea.decision,
        note: originalIdea.note,
      },
      latestDesired: {
        version: 1,
        decision: "adopted",
        note: "Reload replay memo",
      },
      inFlight: null,
      unsettledInFlight: [],
    });

    const rendered = await renderSessionResults(
      { "session-1": [originalIdea] },
      false,
      {
        mutationJournal: journal,
        mutationRecoveryPolicy:
          IMMEDIATE_RESULTS_MUTATION_RECOVERY_POLICY,
      }
    );
    try {
      assert.equal(rendered.requests.length, 1);
      const failedReplay = rendered.requests[0];
      assert.ok(failedReplay);
      await rejectDecisionRequest(failedReplay, "Reload replay unavailable");

      let card = getIdeaCard(originalIdea.content, rendered.container);
      assertCurrentDecision(card, "Pending");
      assert.match(getSaveStatus(card).textContent ?? "", /Save failed/);
      assert.equal(journal.readSessionEntries("session-1").length, 1);
      await act(async () =>
        getButtonWithText("Retry failed save", card).click()
      );

      assert.equal(rendered.requests.length, 2);
      const retryRequest = rendered.requests[1];
      assert.ok(retryRequest);
      assert.deepEqual(
        { decision: retryRequest.decision, note: retryRequest.note },
        { decision: "adopted", note: "Reload replay memo" }
      );
      await resolveDecisionRequest(
        retryRequest,
        makeDecisionResponse(originalIdea, retryRequest)
      );

      card = getIdeaCard(originalIdea.content, rendered.container);
      assertCurrentDecision(card, "Adopted");
      assert.equal(getSaveStatus(card).textContent?.trim(), "Saved");
      assert.equal(journal.readSessionEntries("session-1").length, 0);
    } finally {
      await rendered.unmount();
    }
  });

  test("ignores an old failure and continues with the latest desired request", async () => {
    const originalIdea = makeResultsIdea("old-failure");
    const rendered = await renderSessionResults({ "session-1": [originalIdea] });
    try {
      const card = getIdeaCard(originalIdea.content, rendered.container);
      await act(async () => {
        getButtonWithText("Adopt", card).click();
        getButtonWithText("Reject", card).click();
      });
      const oldRequest = rendered.requests[0];
      assert.ok(oldRequest);
      await rejectDecisionRequest(oldRequest, "Old request failed");

      assert.equal(rendered.requests.length, 2);
      const latestRequest = rendered.requests[1];
      assert.ok(latestRequest);
      const optimisticCard = getIdeaCard(originalIdea.content, rendered.container);
      assertCurrentDecision(optimisticCard, "Rejected");
      assert.match(getSaveStatus(optimisticCard).textContent ?? "", /Saving/);
      assert.equal(
        [...optimisticCard.querySelectorAll("button")].some(
          (button) => button.textContent?.trim() === "Retry failed save"
        ),
        false
      );
      assert.doesNotMatch(getSaveAnnouncement(rendered.container), /Could not save/);

      await resolveDecisionRequest(
        latestRequest,
        makeDecisionResponse(originalIdea, latestRequest)
      );
      const savedCard = getIdeaCard(originalIdea.content, rendered.container);
      assertCurrentDecision(savedCard, "Rejected");
      assert.equal(getSaveStatus(savedCard).textContent?.trim(), "Saved");
    } finally {
      await rendered.unmount();
    }
  });

  test("rolls back only the latest failure and retries its exact desired payload", async () => {
    const originalIdea = makeResultsIdea("retry");
    const rendered = await renderSessionResults({ "session-1": [originalIdea] });
    try {
      let card = getIdeaCard(originalIdea.content, rendered.container);
      const textarea = getRequiredElement<HTMLTextAreaElement>("textarea", card);
      await setTextareaValue(textarea, "Failed desired memo");
      await act(async () => getButtonWithText("Adopt", card).click());
      const failedRequest = rendered.requests[0];
      assert.ok(failedRequest);
      await rejectDecisionRequest(failedRequest, "Decision service unavailable");

      card = getIdeaCard(originalIdea.content, rendered.container);
      assertCurrentDecision(card, "Pending");
      assert.match(getSaveStatus(card).textContent ?? "", /Save failed/);
      assert.equal(
        getRequiredElement<HTMLTextAreaElement>("textarea", card).value,
        "Failed desired memo"
      );
      assert.match(getSaveAnnouncement(rendered.container), /Could not save/);

      await setTextareaValue(
        getRequiredElement<HTMLTextAreaElement>("textarea", card),
        "Unsent edit after failure"
      );
      await act(async () => getButtonWithText("Retry failed save", card).click());

      assert.equal(rendered.requests.length, 2);
      const retryRequest = rendered.requests[1];
      assert.ok(retryRequest);
      assert.deepEqual(
        { decision: retryRequest.decision, note: retryRequest.note },
        { decision: "adopted", note: "Failed desired memo" }
      );
      card = getIdeaCard(originalIdea.content, rendered.container);
      assertCurrentDecision(card, "Adopted");
      assert.match(getSaveStatus(card).textContent ?? "", /Saving/);

      await resolveDecisionRequest(
        retryRequest,
        makeDecisionResponse(originalIdea, retryRequest)
      );
      card = getIdeaCard(originalIdea.content, rendered.container);
      assertCurrentDecision(card, "Adopted");
      assert.equal(getSaveStatus(card).textContent?.trim(), "Saved");
      assert.equal(
        getRequiredElement<HTMLTextAreaElement>("textarea", card).value,
        "Failed desired memo"
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("saves different ideas in parallel without duplicating StrictMode sends", async () => {
    const firstIdea = makeResultsIdea("parallel-first");
    const secondIdea = makeResultsIdea("parallel-second");
    const storage = new FakeResultsMutationJournalStorage();
    const journal = createSessionResultsMutationJournal({ storage });
    const rendered = await renderSessionResults(
      {
        "session-1": [firstIdea, secondIdea],
      },
      false,
      { mutationJournal: journal }
    );
    try {
      const firstCard = getIdeaCard(firstIdea.content, rendered.container);
      const secondCard = getIdeaCard(secondIdea.content, rendered.container);
      await act(async () => {
        getButtonWithText("Adopt", firstCard).click();
        getButtonWithText("Reject", secondCard).click();
      });

      assert.equal(rendered.requests.length, 2);
      const firstRequest = rendered.requests.find(
        (request) => request.ideaId === firstIdea.id
      );
      const secondRequest = rendered.requests.find(
        (request) => request.ideaId === secondIdea.id
      );
      assert.ok(firstRequest);
      assert.ok(secondRequest);
      assert.equal(firstRequest.decision, "adopted");
      assert.equal(secondRequest.decision, "rejected");
      assert.deepEqual(
        journal
          .readSessionEntries("session-1")
          .map((entry) => entry.ideaId)
          .sort(),
        [firstIdea.id, secondIdea.id].sort()
      );

      await resolveDecisionRequest(
        secondRequest,
        makeDecisionResponse(secondIdea, secondRequest)
      );
      assert.equal(
        getSaveStatus(getIdeaCard(secondIdea.content, rendered.container)).textContent?.trim(),
        "Saved"
      );
      assert.match(
        getSaveStatus(getIdeaCard(firstIdea.content, rendered.container)).textContent ?? "",
        /Saving/
      );
      assert.equal(rendered.requests.length, 2);
      assert.deepEqual(
        journal
          .readSessionEntries("session-1")
          .map((entry) => entry.ideaId),
        [firstIdea.id]
      );

      await resolveDecisionRequest(
        firstRequest,
        makeDecisionResponse(firstIdea, firstRequest)
      );
      assert.equal(
        getSaveStatus(getIdeaCard(firstIdea.content, rendered.container)).textContent?.trim(),
        "Saved"
      );
      assert.equal(rendered.requests.length, 2);
      assert.equal(journal.readSessionEntries("session-1").length, 0);
    } finally {
      await rendered.unmount();
    }
  });

  test("invalidates same-id completions across a session data reload", async () => {
    const firstSessionIdea = makeResultsIdea(
      "shared-id",
      "pending",
      "First baseline",
      "First session idea",
      "session-1"
    );
    const secondSessionIdea = makeResultsIdea(
      "shared-id",
      "held",
      "Second baseline",
      "Second session idea",
      "session-2"
    );
    const storage = new FakeResultsMutationJournalStorage();
    const journal = createSessionResultsMutationJournal({ storage });
    const rendered = await renderSessionResults(
      {
        "session-1": [firstSessionIdea],
        "session-2": [secondSessionIdea],
      },
      true,
      { mutationJournal: journal }
    );
    try {
      let card = getIdeaCard(firstSessionIdea.content, rendered.container);
      await act(async () => getButtonWithText("Adopt", card).click());
      const staleRequest = rendered.requests[0];
      assert.ok(staleRequest);
      assert.equal(journal.readSessionEntries("session-1").length, 1);

      const secondSessionLink = [...rendered.container.querySelectorAll("a")].find(
        (candidate) => candidate.textContent?.trim() === "Open second session"
      );
      assert.ok(secondSessionLink);
      await act(async () => secondSessionLink.click());
      await flushSessionResultsDomUpdates();
      card = getIdeaCard(secondSessionIdea.content, rendered.container);
      assertCurrentDecision(card, "Held");
      await act(async () => getButtonWithText("Reject", card).click());
      const currentRequest = rendered.requests[1];
      assert.ok(currentRequest);
      assert.equal(currentRequest.ideaId, staleRequest.ideaId);
      assert.equal(journal.readSessionEntries("session-2").length, 1);

      await resolveDecisionRequest(
        staleRequest,
        makeDecisionResponse(firstSessionIdea, staleRequest)
      );
      card = getIdeaCard(secondSessionIdea.content, rendered.container);
      assertCurrentDecision(card, "Rejected");
      assert.match(getSaveStatus(card).textContent ?? "", /Saving/);
      assert.doesNotMatch(getSaveAnnouncement(rendered.container), /Saved adopted/);
      assert.equal(rendered.requests.length, 2);
      assert.equal(
        journal.readSessionEntries("session-1").length,
        1,
        "session switch must preserve the interrupted session journal"
      );
      assert.equal(journal.readSessionEntries("session-2").length, 1);

      await resolveDecisionRequest(
        currentRequest,
        makeDecisionResponse(secondSessionIdea, currentRequest)
      );
      card = getIdeaCard(secondSessionIdea.content, rendered.container);
      assertCurrentDecision(card, "Rejected");
      assert.equal(getSaveStatus(card).textContent?.trim(), "Saved");
      assert.equal(journal.readSessionEntries("session-2").length, 0);
      assert.equal(journal.readSessionEntries("session-1").length, 1);
    } finally {
      await rendered.unmount();
    }
  });

  test("writes the current journal synchronously before starting PATCH", async () => {
    const originalIdea = makeResultsIdea("write-before-patch");
    const timeline: string[] = [];
    const values = new Map<string, string>();
    const storage: SessionResultsMutationJournalStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        timeline.push("journal:set");
        values.set(key, value);
      },
      removeItem: (key) => {
        timeline.push("journal:remove");
        values.delete(key);
      },
    };
    const journal = createSessionResultsMutationJournal({ storage });
    const deferredPatch = createDeferredResult<Idea>();
    const rendered = await renderSessionResults(
      { "session-1": [originalIdea] },
      false,
      {
        mutationJournal: journal,
        updateDecision: async () => {
          timeline.push("patch:start");
          return deferredPatch.promise;
        },
      }
    );
    try {
      const card = getIdeaCard(originalIdea.content, rendered.container);
      await act(async () => getButtonWithText("Adopt", card).click());
      assert.ok(timeline.indexOf("journal:set") >= 0);
      assert.ok(
        timeline.indexOf("journal:set") < timeline.indexOf("patch:start")
      );

      await act(async () => {
        deferredPatch.resolve({
          ...originalIdea,
          decision: "adopted",
        });
        await deferredPatch.promise;
      });
      await flushSessionResultsDomUpdates();
    } finally {
      await rendered.unmount();
    }
  });

  test("keeps saving when sessionStorage is unavailable", async () => {
    const originalIdea = makeResultsIdea("storage-unavailable");
    const throwingStorage: SessionResultsMutationJournalStorage = {
      getItem() {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem() {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem() {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    const journal = createSessionResultsMutationJournal({
      storage: throwingStorage,
    });
    const rendered = await renderSessionResults(
      { "session-1": [originalIdea] },
      false,
      { mutationJournal: journal }
    );
    try {
      const card = getIdeaCard(originalIdea.content, rendered.container);
      await act(async () => getButtonWithText("Adopt", card).click());
      const request = rendered.requests[0];
      assert.ok(request);
      await resolveDecisionRequest(
        request,
        makeDecisionResponse(originalIdea, request)
      );
      assert.equal(
        getSaveStatus(
          getIdeaCard(originalIdea.content, rendered.container)
        ).textContent?.trim(),
        "Saved"
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("cancels a bounded recovery delay on unmount without revalidating or replaying", async () => {
    const originalIdea = makeResultsIdea("cancel-recovery-delay");
    const storage = new FakeResultsMutationJournalStorage();
    const journal = createSessionResultsMutationJournal({ storage });
    journal.writeSessionEntry("session-1", {
      ideaId: originalIdea.id,
      monotonicVersion: 1,
      lastAcknowledged: {
        decision: originalIdea.decision,
        note: originalIdea.note,
      },
      latestDesired: {
        version: 1,
        decision: "adopted",
        note: originalIdea.note,
      },
      inFlight: {
        version: 1,
        decision: "adopted",
        note: originalIdea.note,
      },
      unsettledInFlight: [],
    });

    let recoverySignal: AbortSignal | undefined;
    let recoveryDelayWasAborted = false;
    let listIdeasCallCount = 0;
    const recoveryPolicy: SessionResultsMutationRecoveryPolicy = {
      revalidationDelaysMs: [1_000],
      maximumReplayAttempts: 1,
      waitForDelay: (_delayMs, cancellationSignal) =>
        new Promise<void>((resolve) => {
          recoverySignal = cancellationSignal;
          if (cancellationSignal?.aborted) {
            recoveryDelayWasAborted = true;
            resolve();
            return;
          }
          cancellationSignal?.addEventListener(
            "abort",
            () => {
              recoveryDelayWasAborted = true;
              resolve();
            },
            { once: true }
          );
        }),
    };
    const rendered = await renderSessionResults(
      { "session-1": [originalIdea] },
      false,
      {
        mutationJournal: journal,
        mutationRecoveryPolicy: recoveryPolicy,
        listIdeas: async () => {
          listIdeasCallCount += 1;
          return { ideas: [originalIdea] };
        },
      }
    );

    assert.ok(recoverySignal);
    assert.equal(recoverySignal.aborted, false);
    assert.equal(rendered.requests.length, 0);
    const callsBeforeUnmount = listIdeasCallCount;
    await rendered.unmount();
    await act(async () => Promise.resolve());

    assert.equal(recoverySignal.aborted, true);
    assert.equal(recoveryDelayWasAborted, true);
    assert.equal(listIdeasCallCount, callsBeforeUnmount);
    assert.equal(rendered.requests.length, 0);
    assert.equal(journal.readSessionEntries("session-1").length, 1);
  });

  test("does not publish, resend, or clear the journal after unmount", async () => {
    const originalIdea = makeResultsIdea("unmount");
    const storage = new FakeResultsMutationJournalStorage();
    const journal = createSessionResultsMutationJournal({ storage });
    const rendered = await renderSessionResults(
      { "session-1": [originalIdea] },
      false,
      { mutationJournal: journal }
    );
    const card = getIdeaCard(originalIdea.content, rendered.container);
    await act(async () => getButtonWithText("Adopt", card).click());
    const staleRequest = rendered.requests[0];
    assert.ok(staleRequest);

    await rendered.unmount();
    await resolveDecisionRequest(
      staleRequest,
      makeDecisionResponse(originalIdea, staleRequest)
    );
    assert.equal(rendered.requests.length, 1);
    assert.equal(rendered.container.childElementCount, 0);
    assert.equal(journal.readSessionEntries("session-1").length, 1);
  });
});

describe("Session Results idea memo note contract", () => {
  test("trims Unicode memo payload, clears whitespace-only notes, and restores journal notes", async () => {
    const originalIdea = makeResultsIdea("memo-note", "pending", "Server memo");
    const storage = new FakeResultsMutationJournalStorage();
    const journal = createSessionResultsMutationJournal({ storage });
    const firstRender = await renderSessionResults(
      { "session-1": [originalIdea] },
      false,
      {
        mutationJournal: journal,
        mutationRecoveryPolicy: IMMEDIATE_RESULTS_MUTATION_RECOVERY_POLICY,
      }
    );
    try {
      let card = getIdeaCard(originalIdea.content, firstRender.container);
      await setTextareaValue(
        getRequiredElement<HTMLTextAreaElement>("textarea", card),
        "\u3000\u63a1\u7528\u7406\u7531\u3000"
      );
      await act(async () => getButtonWithText("Save memo", card).click());
      const trimRequest = firstRender.requests[0];
      assert.ok(trimRequest);
      assert.equal(trimRequest.note, "\u63a1\u7528\u7406\u7531");
      assert.equal(
        journal.readSessionEntries("session-1")[0]?.latestDesired.note,
        "\u63a1\u7528\u7406\u7531"
      );
      await resolveDecisionRequest(
        trimRequest,
        makeDecisionResponse(originalIdea, trimRequest)
      );

      card = getIdeaCard(originalIdea.content, firstRender.container);
      await setTextareaValue(
        getRequiredElement<HTMLTextAreaElement>("textarea", card),
        "  \u3000  "
      );
      await act(async () => getButtonWithText("Save memo", card).click());
      const clearRequest = firstRender.requests[1];
      assert.ok(clearRequest);
      assert.equal(clearRequest.note, "");
      await resolveDecisionRequest(
        clearRequest,
        makeDecisionResponse(
          { ...originalIdea, note: "\u63a1\u7528\u7406\u7531" },
          clearRequest
        )
      );
      card = getIdeaCard(originalIdea.content, firstRender.container);
      assert.equal(
        getRequiredElement<HTMLTextAreaElement>("textarea", card).value,
        ""
      );
    } finally {
      await firstRender.unmount();
    }

    const recoveredIdea = makeResultsIdea(
      "memo-note",
      "pending",
      "Server memo"
    );
    journal.writeSessionEntry("session-1", {
      ideaId: recoveredIdea.id,
      monotonicVersion: 1,
      lastAcknowledged: {
        decision: recoveredIdea.decision,
        note: recoveredIdea.note,
      },
      latestDesired: {
        version: 1,
        decision: "adopted",
        note: "  Recovered memo  ",
      },
      inFlight: null,
      unsettledInFlight: [],
    });
    const secondRender = await renderSessionResults(
      { "session-1": [recoveredIdea] },
      false,
      {
        mutationJournal: journal,
        mutationRecoveryPolicy: IMMEDIATE_RESULTS_MUTATION_RECOVERY_POLICY,
      }
    );
    try {
      const recoveredCard = getIdeaCard(
        recoveredIdea.content,
        secondRender.container
      );
      assert.equal(
        getRequiredElement<HTMLTextAreaElement>("textarea", recoveredCard)
          .value,
        "Recovered memo"
      );
      const replayRequest = secondRender.requests[0];
      assert.ok(replayRequest);
      assert.deepEqual(
        { decision: replayRequest.decision, note: replayRequest.note },
        { decision: "adopted", note: "Recovered memo" }
      );
      await resolveDecisionRequest(
        replayRequest,
        makeDecisionResponse(recoveredIdea, replayRequest)
      );
      assert.equal(
        getRequiredElement<HTMLTextAreaElement>("textarea", recoveredCard)
          .value,
        "Recovered memo"
      );
      assert.equal(journal.readSessionEntries("session-1").length, 0);
    } finally {
      await secondRender.unmount();
    }
  });

  test("maps a 422 note location to the memo field and keeps a general alert fallback", async () => {
    const originalIdea = makeResultsIdea("memo-422");
    const rendered = await renderSessionResults({
      "session-1": [originalIdea],
    });
    try {
      let card = getIdeaCard(originalIdea.content, rendered.container);
      await setTextareaValue(
        getRequiredElement<HTMLTextAreaElement>("textarea", card),
        "Field memo"
      );
      await act(async () => getButtonWithText("Save memo", card).click());
      const noteRequest = rendered.requests[0];
      assert.ok(noteRequest);
      await rejectDecisionRequest(
        noteRequest,
        new ApiRequestError(422, "note: Server rejected the memo.", [
          {
            location: ["body", "note"],
            message: "Server rejected the memo.",
            type: "value_error",
          },
        ])
      );

      card = getIdeaCard(originalIdea.content, rendered.container);
      const memoError = card.querySelector(
        `#${getResultsIdeaMemoFieldElementId(originalIdea.id, "error")}`
      );
      assert.equal(memoError?.textContent?.trim(), "Server rejected the memo.");
      assert.doesNotMatch(card.textContent ?? "", /\[object Object\]/);
      assert.doesNotMatch(card.textContent ?? "", /Save failed: Server rejected/);

      await setTextareaValue(
        getRequiredElement<HTMLTextAreaElement>("textarea", card),
        "Corrected memo"
      );
      assert.equal(
        card.querySelector(
          `#${getResultsIdeaMemoFieldElementId(originalIdea.id, "error")}`
        ),
        null
      );

      await act(async () => getButtonWithText("Save memo", card).click());
      const generalRequest = rendered.requests[1];
      assert.ok(generalRequest);
      assert.equal(generalRequest.note, "Corrected memo");
      await rejectDecisionRequest(
        generalRequest,
        new ApiRequestError(422, "decision: Invalid decision.", [
          {
            location: ["body", "decision"],
            message: "Invalid decision.",
            type: "value_error",
          },
        ])
      );
      card = getIdeaCard(originalIdea.content, rendered.container);
      assert.equal(
        card.querySelector(
          `#${getResultsIdeaMemoFieldElementId(originalIdea.id, "error")}`
        ),
        null
      );
      assert.match(getSaveStatus(card).textContent ?? "", /Save failed/);
      assert.match(getSaveStatus(card).textContent ?? "", /Invalid decision/);
      assert.doesNotMatch(card.textContent ?? "", /\[object Object\]/);
    } finally {
      await rendered.unmount();
    }
  });

  test("rolls back a failed trimmed memo and retries the exact normalized payload", async () => {
    const originalIdea = makeResultsIdea("memo-retry");
    const rendered = await renderSessionResults({
      "session-1": [originalIdea],
    });
    try {
      let card = getIdeaCard(originalIdea.content, rendered.container);
      await setTextareaValue(
        getRequiredElement<HTMLTextAreaElement>("textarea", card),
        "  Retry memo  "
      );
      await act(async () => getButtonWithText("Adopt", card).click());
      const failedRequest = rendered.requests[0];
      assert.ok(failedRequest);
      assert.equal(failedRequest.note, "Retry memo");
      await rejectDecisionRequest(failedRequest, "Decision service unavailable");

      card = getIdeaCard(originalIdea.content, rendered.container);
      assertCurrentDecision(card, "Pending");
      assert.match(getSaveStatus(card).textContent ?? "", /Save failed/);
      assert.equal(
        getRequiredElement<HTMLTextAreaElement>("textarea", card).value,
        "Retry memo"
      );

      await setTextareaValue(
        getRequiredElement<HTMLTextAreaElement>("textarea", card),
        "Unsent edit after failure"
      );
      await act(async () => getButtonWithText("Retry failed save", card).click());
      const retryRequest = rendered.requests[1];
      assert.ok(retryRequest);
      assert.deepEqual(
        { decision: retryRequest.decision, note: retryRequest.note },
        { decision: "adopted", note: "Retry memo" }
      );
      await resolveDecisionRequest(
        retryRequest,
        makeDecisionResponse(originalIdea, retryRequest)
      );
      card = getIdeaCard(originalIdea.content, rendered.container);
      assertCurrentDecision(card, "Adopted");
      assert.equal(getSaveStatus(card).textContent?.trim(), "Saved");
      assert.equal(
        getRequiredElement<HTMLTextAreaElement>("textarea", card).value,
        "Retry memo"
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("does not PATCH a programmatic 2001-character memo from Results", async () => {
    const originalIdea = makeResultsIdea("memo-too-long", "pending", "");
    const rendered = await renderSessionResults({
      "session-1": [originalIdea],
    });
    try {
      const card = getIdeaCard(originalIdea.content, rendered.container);
      const textarea = getRequiredElement<HTMLTextAreaElement>(
        "textarea",
        card
      );
      await setTextareaValue(textarea, "m".repeat(2_001));
      assert.equal(
        card
          .querySelector(
            `#${getResultsIdeaMemoFieldElementId(originalIdea.id, "error")}`
          )
          ?.textContent?.trim(),
        RESULTS_IDEA_MEMO_TOO_LONG_ERROR
      );
      await act(async () => getButtonWithText("Save memo", card).click());
      await act(async () => getButtonWithText("Adopt", card).click());
      assert.equal(rendered.requests.length, 0);
    } finally {
      await rendered.unmount();
    }
  });
});

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { api, type Idea, type Session } from "@/lib/api";
import { registerHappyDomTestEnvironment } from "@/test-support/happy-dom-test-environment";
import {
  getSessionResultsClusterHeaderId,
  SESSION_RESULTS_CLEAR_FILTER_CONTROL_ID,
  SESSION_RESULTS_COLLAPSE_ALL_CONTROL_ID,
  SESSION_RESULTS_EXPAND_ALL_CONTROL_ID,
} from "@/lib/use-session-results-focus-recovery";

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

interface RenderedResults {
  root: Root;
  container: HTMLDivElement;
  unmount: () => Promise<void>;
}

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
  clusterId: number,
  decision: Idea["decision"] = "pending"
): Idea {
  return {
    id,
    session_id: RESULTS_SESSION.id,
    persona_type: "ARCHITECT",
    phase: "divergence",
    content: `Idea ${id}`,
    cluster_id: clusterId,
    synthesized: `Cluster ${clusterId} synthesis`,
    scores: null,
    decision,
    note: "",
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

function getButtonWithText(label: string, parent: ParentNode = document): HTMLButtonElement {
  const button = [...parent.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label
  );
  assert.ok(button, `Expected button with text “${label}”`);
  return button;
}

function getDecisionFilterButton(label: string): HTMLButtonElement {
  const filterGroup = getRequiredElement<HTMLElement>(
    '[role="group"][aria-label="Filter ideas by decision"]'
  );
  const button = [...filterGroup.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim().startsWith(label)
  );
  assert.ok(button, `Expected ${label} decision filter`);
  return button;
}

async function flushSessionResultsDomUpdates(frameCount = 3): Promise<void> {
  await act(async () => {
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

async function renderSessionResults(
  ideas: Idea[],
  updateDecision: typeof api.updateDecision = async (
    ideaId,
    decision,
    note
  ) => {
    const currentIdea = ideas.find((idea) => idea.id === ideaId);
    assert.ok(currentIdea);
    return { ...currentIdea, decision, note: note ?? currentIdea.note };
  }
): Promise<RenderedResults> {
  api.getSession = async () => RESULTS_SESSION;
  api.listIdeas = async () => ({ ideas });
  api.listMessages = async () => ({ messages: [] });
  api.updateDecision = updateDecision;

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <StrictMode>
        <MemoryRouter initialEntries={["/session/session-1/results"]}>
          <Routes>
            <Route path="/session/:id/results" element={<SessionResults />} />
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

after(async () => {
  api.getSession = originalApiMethods.getSession;
  api.listIdeas = originalApiMethods.listIdeas;
  api.listMessages = originalApiMethods.listMessages;
  api.updateDecision = originalApiMethods.updateDecision;
  await cleanupHappyDomEnvironment?.();
});

describe("Session Results DOM focus recovery", () => {
  test("moves Expand all focus to Collapse all and back after each disclosure commit", async () => {
    const renderedResults = await renderSessionResults([
      makeResultsIdea("first", 1),
      makeResultsIdea("second", 2),
    ]);
    try {
      const expandAllControl = getRequiredElement<HTMLButtonElement>(
        `#${SESSION_RESULTS_EXPAND_ALL_CONTROL_ID}`
      );
      const collapseAllControl = getRequiredElement<HTMLButtonElement>(
        `#${SESSION_RESULTS_COLLAPSE_ALL_CONTROL_ID}`
      );

      expandAllControl.focus();
      assert.equal(document.activeElement, expandAllControl);
      await act(async () => expandAllControl.click());
      await flushSessionResultsDomUpdates();
      assert.equal(expandAllControl.disabled, true);
      assert.equal(collapseAllControl.disabled, false);
      assert.equal(document.activeElement, collapseAllControl);

      await act(async () => collapseAllControl.click());
      await flushSessionResultsDomUpdates();
      assert.equal(collapseAllControl.disabled, true);
      assert.equal(expandAllControl.disabled, false);
      assert.equal(document.activeElement, expandAllControl);
    } finally {
      await renderedResults.unmount();
    }
  });

  test("focuses the first matching expanded cluster when a filter removes the focused cluster", async () => {
    const renderedResults = await renderSessionResults([
      makeResultsIdea("pending", 1, "pending"),
      makeResultsIdea("rejected", 2, "rejected"),
    ]);
    try {
      const firstClusterHeader = getRequiredElement<HTMLButtonElement>(
        `#${getSessionResultsClusterHeaderId("cluster:1")}`
      );
      const rejectedFilter = getDecisionFilterButton("Rejected");
      firstClusterHeader.focus();
      assert.equal(document.activeElement, firstClusterHeader);

      await act(async () => rejectedFilter.click());
      await flushSessionResultsDomUpdates();

      const secondClusterHeader = getRequiredElement<HTMLButtonElement>(
        `#${getSessionResultsClusterHeaderId("cluster:2")}`
      );
      assert.equal(secondClusterHeader.getAttribute("aria-expanded"), "true");
      assert.equal(document.activeElement, secondClusterHeader);
    } finally {
      await renderedResults.unmount();
    }
  });

  test("keeps outside focus instead of stealing it during a filter update", async () => {
    const renderedResults = await renderSessionResults([
      makeResultsIdea("pending", 1, "pending"),
      makeResultsIdea("rejected", 2, "rejected"),
    ]);
    try {
      const markdownExport = getRequiredElement<HTMLButtonElement>(
        '[aria-label="Export results"] button'
      );
      const rejectedFilter = getDecisionFilterButton("Rejected");
      markdownExport.focus();
      assert.equal(document.activeElement, markdownExport);

      await act(async () => rejectedFilter.click());
      await flushSessionResultsDomUpdates();

      assert.equal(document.activeElement, markdownExport);
    } finally {
      await renderedResults.unmount();
    }
  });

  test("recovers a successful filtered decision save to the next expanded cluster", async () => {
    const firstIdea = makeResultsIdea("first", 1, "pending");
    const secondIdea = makeResultsIdea("second", 2, "pending");
    const decisionResponse = createDeferredResult<Idea>();
    const renderedResults = await renderSessionResults(
      [firstIdea, secondIdea],
      () => decisionResponse.promise
    );
    try {
      const pendingFilter = getDecisionFilterButton("Pending");
      pendingFilter.focus();
      await act(async () => pendingFilter.click());
      await flushSessionResultsDomUpdates();

      const firstClusterHeader = getRequiredElement<HTMLButtonElement>(
        `#${getSessionResultsClusterHeaderId("cluster:1")}`
      );
      const firstCluster = firstClusterHeader.closest("section");
      assert.ok(firstCluster);
      const adoptControl = getButtonWithText("Adopt", firstCluster);
      adoptControl.focus();
      assert.equal(document.activeElement, adoptControl);

      await act(async () => adoptControl.click());
      await flushSessionResultsDomUpdates();

      const secondClusterHeader = getRequiredElement<HTMLButtonElement>(
        `#${getSessionResultsClusterHeaderId("cluster:2")}`
      );
      assert.equal(secondClusterHeader.getAttribute("aria-expanded"), "true");
      assert.equal(document.activeElement, secondClusterHeader);

      await act(async () => {
        decisionResponse.resolve({ ...firstIdea, decision: "adopted" });
        await decisionResponse.promise;
      });
      await flushSessionResultsDomUpdates();
      assert.equal(document.activeElement, secondClusterHeader);
    } finally {
      await renderedResults.unmount();
    }
  });

  test("uses Clear filter at zero matches, then recovers again when rollback restores the card", async () => {
    const onlyIdea = makeResultsIdea("only", 1, "pending");
    const decisionResponse = createDeferredResult<Idea>();
    const renderedResults = await renderSessionResults(
      [onlyIdea],
      () => decisionResponse.promise
    );
    try {
      const pendingFilter = getDecisionFilterButton("Pending");
      pendingFilter.focus();
      await act(async () => pendingFilter.click());
      await flushSessionResultsDomUpdates();

      const clusterHeader = getRequiredElement<HTMLButtonElement>(
        `#${getSessionResultsClusterHeaderId("cluster:1")}`
      );
      const cluster = clusterHeader.closest("section");
      assert.ok(cluster);
      const adoptControl = getButtonWithText("Adopt", cluster);
      adoptControl.focus();

      await act(async () => adoptControl.click());
      await flushSessionResultsDomUpdates();

      const clearFilterControl = getRequiredElement<HTMLButtonElement>(
        `#${SESSION_RESULTS_CLEAR_FILTER_CONTROL_ID}`
      );
      assert.equal(document.activeElement, clearFilterControl);

      await act(async () => {
        decisionResponse.reject(new Error("Decision service unavailable"));
        try {
          await decisionResponse.promise;
        } catch {
          // The view turns this expected rejection into its rollback state.
        }
      });
      await flushSessionResultsDomUpdates();

      const restoredClusterHeader = getRequiredElement<HTMLButtonElement>(
        `#${getSessionResultsClusterHeaderId("cluster:1")}`
      );
      assert.equal(restoredClusterHeader.getAttribute("aria-expanded"), "true");
      assert.equal(document.activeElement, restoredClusterHeader);
      assert.equal(
        getButtonWithText("Retry failed save").textContent?.trim(),
        "Retry failed save"
      );
    } finally {
      await renderedResults.unmount();
    }
  });
});

describe("Session Results focus scroll geometry (CSS contract)", () => {
  test("document scroller keeps a top inset so focus recovery clears the sticky app header", () => {
    // useSessionResultsFocusRecovery calls focus() without preventScroll, so
    // recovered cluster-header focus relies on the document scroller's
    // scroll-padding-top to land below the 3.5rem sticky app header — the
    // same inset Tab/Shift+Tab journeys use. Bottom stays 0 on Results: the
    // html.izayoi-create-actionbar-visible bottom gap is Create-only and its
    // lifecycle is owned by the Create actionbar component.
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    const htmlRule =
      [...css.matchAll(/^html\s*\{([^}]*)\}/gm)]
        .map((match) => match[1])
        .find((body) => body.includes("scroll-padding")) ?? "";
    assert.ok(htmlRule, "a dedicated html rule carries the document scroller insets");
    assert.match(
      htmlRule,
      /scroll-padding-top:\s*(?:[4-9]|\d{2,})(?:\.\d+)?rem/,
      "document scroller reserves at least 4.5rem above recovered focus targets"
    );
    assert.match(
      htmlRule,
      /scroll-padding-bottom:\s*0px/,
      "Results keeps bottom inset 0 (Create-only bottom gap)"
    );
  });
});

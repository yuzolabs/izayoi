import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";

import { StrictMode, act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

import { api, type Session, type SessionStatus } from "@/lib/api";
import { registerHappyDomTestEnvironment } from "@/test-support/happy-dom-test-environment";

import { History } from "./history";

interface DeferredHistoryResponse {
  promise: Promise<{ sessions: Session[] }>;
  resolve: (value: { sessions: Session[] }) => void;
  reject: (reason: unknown) => void;
}

interface RenderedHistory {
  container: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
}

const originalListSessions = api.listSessions;

function createDeferredHistoryResponse(): DeferredHistoryResponse {
  let resolvePromise!: (value: { sessions: Session[] }) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<{ sessions: Session[] }>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function makeHistoryViewSession(
  status: SessionStatus,
  createdAt: string,
  overrides: Partial<Session> = {}
): Session {
  return {
    id: `session-${status}`,
    theme: `${status} council`,
    constraints: `Keep ${status} reversible`,
    status,
    phase_progress: status,
    agents: [],
    created_at: createdAt,
    metrics: null,
    ...overrides,
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

async function flushHistoryDomUpdates(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderHistory(strict = false): Promise<RenderedHistory> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const routedHistory: ReactElement = (
    <MemoryRouter initialEntries={["/history"]}>
      <History />
    </MemoryRouter>
  );

  await act(async () => {
    root.render(strict ? <StrictMode>{routedHistory}</StrictMode> : routedHistory);
    await Promise.resolve();
  });

  return {
    container,
    root,
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
    url: "http://localhost/history",
  }).cleanup;
});

after(async () => {
  api.listSessions = originalListSessions;
  await cleanupHappyDomEnvironment?.();
});

describe("History view loading and row semantics", () => {
  test("announces loading, then renders a latest-first semantic list for mixed statuses", async () => {
    const response = createDeferredHistoryResponse();
    api.listSessions = () => response.promise;
    const renderedHistory = await renderHistory();

    try {
      assert.equal(renderedHistory.container.firstElementChild?.getAttribute("aria-busy"), "true");
      assert.match(
        getRequiredElement<HTMLElement>('[role="status"]', renderedHistory.container)
          .textContent ?? "",
        /Loading session history/
      );

      const sessions = [
        makeHistoryViewSession("done", "2025-01-06T00:00:00Z", {
          metrics: {
            total_ideas: 0,
            unique_ideas: 0,
            non_duplicate_ratio: 0,
            semantic_dispersion: 0,
            collapse_alert: false,
          },
        }),
        makeHistoryViewSession("framing", "2025-01-01T00:00:00Z"),
        makeHistoryViewSession("error", "invalid"),
        makeHistoryViewSession("discussion", "2025-01-03T00:00:00Z"),
        makeHistoryViewSession("convergence", "2025-01-04T00:00:00Z"),
        makeHistoryViewSession("divergence", "2025-01-02T00:00:00Z"),
      ];
      await act(async () => {
        response.resolve({ sessions });
        await response.promise;
      });
      await flushHistoryDomUpdates();

      assert.equal(renderedHistory.container.firstElementChild?.getAttribute("aria-busy"), "false");
      const list = getRequiredElement<HTMLUListElement>("ul", renderedHistory.container);
      assert.equal(list.querySelectorAll(":scope > li").length, 6);
      assert.deepEqual(
        [...list.querySelectorAll("h3 a")].map((link) => link.textContent?.trim()),
        [
          "done council",
          "convergence council",
          "discussion council",
          "divergence council",
          "framing council",
          "error council",
        ]
      );

      for (const label of [
        "Framing",
        "Divergence",
        "Discussion",
        "Convergence",
        "Done",
        "Error",
      ]) {
        const status = getRequiredElement<HTMLElement>(
          `[aria-label="Status: ${label}"]`,
          list
        );
        assert.ok(status.querySelector("svg"), `${label} should include a status icon`);
        assert.equal(status.textContent?.trim(), label);
      }

      assert.equal(
        getRequiredElement<HTMLAnchorElement>(
          'a[aria-label="Open live: framing council"]',
          list
        ).getAttribute("href"),
        "/session/session-framing"
      );
      assert.equal(
        getRequiredElement<HTMLAnchorElement>(
          'a[aria-label="Review decisions: done council"]',
          list
        ).getAttribute("href"),
        "/session/session-done/results"
      );
      assert.equal(
        getRequiredElement<HTMLAnchorElement>(
          'a[aria-label="Inspect failure: error council"]',
          list
        ).getAttribute("href"),
        "/session/session-error/results"
      );
      assert.match(list.textContent ?? "", /0 ideas · NDR 0.00 · dispersion 0.00/);
      assert.match(list.textContent ?? "", /Metrics unavailable/);
      assert.match(list.textContent ?? "", /Jan 06, 2025 at 00:00 UTC/);
      assert.match(
        getRequiredElement<HTMLElement>(
          'p[role="status"]',
          renderedHistory.container
        ).textContent ?? "",
        /6 sessions loaded/
      );
    } finally {
      await renderedHistory.unmount();
    }
  });

  test("renders an announced empty state with a first-session action", async () => {
    api.listSessions = async () => ({ sessions: [] });
    const renderedHistory = await renderHistory();

    try {
      await flushHistoryDomUpdates();
      assert.match(renderedHistory.container.textContent ?? "", /No past sessions/);
      assert.match(
        getRequiredElement<HTMLElement>(
          'p[role="status"]',
          renderedHistory.container
        ).textContent ?? "",
        /No past sessions found/
      );
      const emptySection = getRequiredElement<HTMLElement>(
        '[aria-labelledby="session-history-empty-heading"]',
        renderedHistory.container
      );
      const firstSessionAction = getRequiredElement<HTMLAnchorElement>(
        'a[href="/"]',
        emptySection
      );
      assert.equal(firstSessionAction.textContent?.trim(), "Start first session");
      const mastheadNewSessionAction = getRequiredElement<HTMLAnchorElement>(
        'a[href="/"]',
        getRequiredElement<HTMLElement>("header", renderedHistory.container)
      );
      assert.equal(mastheadNewSessionAction.textContent?.trim(), "New session");
    } finally {
      await renderedHistory.unmount();
    }
  });
});

describe("History view request lifecycle", () => {
  test("shows a network error and replaces it with loading while Retry runs", async () => {
    const retryResponse = createDeferredHistoryResponse();
    let requestCount = 0;
    api.listSessions = () => {
      requestCount += 1;
      return requestCount === 1
        ? Promise.reject(new Error("Network offline"))
        : retryResponse.promise;
    };
    const renderedHistory = await renderHistory();

    try {
      await flushHistoryDomUpdates();
      const alert = getRequiredElement<HTMLElement>(
        '[role="alert"]',
        renderedHistory.container
      );
      assert.match(alert.textContent ?? "", /Could not load session history/);
      assert.match(alert.textContent ?? "", /Network offline/);
      const errorHeading = getRequiredElement<HTMLHeadingElement>("h2", alert);
      assert.equal(errorHeading.textContent?.trim(), "Could not load session history");
      assert.equal(alert.querySelector("h1, h3, h4, h5, h6"), null);
      assert.equal(renderedHistory.container.querySelectorAll("h1").length, 1);

      const retryButton = getRequiredElement<HTMLButtonElement>("button", alert);
      assert.equal(retryButton.textContent?.trim(), "Retry");
      await act(async () => retryButton.click());
      await flushHistoryDomUpdates();
      assert.equal(requestCount, 2);
      assert.equal(renderedHistory.container.querySelector('[role="alert"]'), null);
      assert.match(
        getRequiredElement<HTMLElement>(
          '[role="status"]',
          renderedHistory.container
        ).textContent ?? "",
        /Loading session history/
      );

      await act(async () => {
        retryResponse.resolve({ sessions: [] });
        await retryResponse.promise;
      });
      await flushHistoryDomUpdates();
      assert.match(renderedHistory.container.textContent ?? "", /No past sessions/);
    } finally {
      await renderedHistory.unmount();
    }
  });

  test("ignores a stale StrictMode response and a response after unmount", async () => {
    const staleResponse = createDeferredHistoryResponse();
    const currentResponse = createDeferredHistoryResponse();
    const pendingResponses = [staleResponse, currentResponse];
    api.listSessions = () => {
      const response = pendingResponses.shift();
      assert.ok(response, "Expected one request per StrictMode effect setup");
      return response.promise;
    };
    const renderedHistory = await renderHistory(true);

    try {
      assert.equal(pendingResponses.length, 0);
      await act(async () => {
        currentResponse.resolve({
          sessions: [makeHistoryViewSession("done", "2026-01-01T00:00:00Z")],
        });
        await currentResponse.promise;
      });
      await flushHistoryDomUpdates();
      assert.match(renderedHistory.container.textContent ?? "", /done council/);

      await act(async () => {
        staleResponse.resolve({
          sessions: [makeHistoryViewSession("framing", "2027-01-01T00:00:00Z")],
        });
        await staleResponse.promise;
      });
      await flushHistoryDomUpdates();
      assert.match(renderedHistory.container.textContent ?? "", /done council/);
      assert.doesNotMatch(renderedHistory.container.textContent ?? "", /framing council/);
    } finally {
      await renderedHistory.unmount();
    }

    const afterUnmountResponse = createDeferredHistoryResponse();
    api.listSessions = () => afterUnmountResponse.promise;
    const unmountedHistory = await renderHistory();
    await unmountedHistory.unmount();
    await act(async () => {
      afterUnmountResponse.resolve({ sessions: [] });
      await afterUnmountResponse.promise;
    });
    assert.equal(unmountedHistory.container.childElementCount, 0);
  });
});

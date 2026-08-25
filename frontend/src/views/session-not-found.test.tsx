import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";

import { getAllByRole, getByRole, queryAllByRole, queryByRole } from "@testing-library/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { api, ApiRequestError, type Session } from "@/lib/api";
import {
  FakeSessionEventSource,
  installFakeSessionEventSource,
} from "@/test-support/fake-session-event-source";
import { registerHappyDomTestEnvironment } from "@/test-support/happy-dom-test-environment";

import { SessionLive } from "./session-live";
import { SessionResults } from "./session-results";

const MISSING_SESSION_ID = "session-missing";

const EXISTING_SESSION: Session = {
  id: "session-exists",
  theme: "Existing council",
  constraints: "Keep going",
  status: "divergence",
  phase_progress: "divergence",
  agents: [],
  created_at: "2026-08-24T00:00:00Z",
  metrics: null,
};

const originalApiMethods = {
  getSession: api.getSession,
  listIdeas: api.listIdeas,
  listMessages: api.listMessages,
  personas: api.personas,
};

interface RenderedView {
  container: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
}

interface ConsoleErrorProbe {
  consoleErrors: unknown[][];
  restore: () => void;
}

async function flushViewDomUpdates(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function captureConsoleErrors(): ConsoleErrorProbe {
  const consoleErrors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...errorArguments: unknown[]) => {
    consoleErrors.push(errorArguments);
  };
  return {
    consoleErrors,
    restore: () => {
      console.error = originalConsoleError;
    },
  };
}

async function renderSessionLiveView(sessionId: string): Promise<RenderedView> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/session/${sessionId}`]}>
        <Routes>
          <Route path="/session/:id" element={<SessionLive />} />
        </Routes>
      </MemoryRouter>
    );
    await Promise.resolve();
  });
  await flushViewDomUpdates();

  return {
    container,
    root,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function renderSessionResultsView(sessionId: string): Promise<RenderedView> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/session/${sessionId}/results`]}>
        <Routes>
          <Route path="/session/:id/results" element={<SessionResults />} />
        </Routes>
      </MemoryRouter>
    );
    await Promise.resolve();
  });
  await flushViewDomUpdates();

  return {
    container,
    root,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function getSessionNotFoundAlert(container: HTMLElement): HTMLElement {
  return getByRole(container, "alert");
}

function assertSessionNotFoundRecoveryLinks(container: HTMLElement): void {
  const historyLink = getByRole(container, "link", { name: "History" });
  const newSessionLink = getByRole(container, "link", { name: "New session" });
  assert.equal(historyLink.getAttribute("href"), "/history");
  assert.equal(newSessionLink.getAttribute("href"), "/");
}

function assertNoLiveRunningWorkspaceChrome(container: HTMLElement): void {
  assert.equal(queryByRole(container, "heading", { name: "The council at work" }), null);
  assert.equal(queryByRole(container, "link", { name: /Results/ }), null);
  assert.equal(container.querySelector('[aria-label="Session phases"]'), null);
  const statusLabels = queryAllByRole(container, "status").map((status) =>
    status.textContent?.replace(/\s+/g, " ").trim()
  );
  assert.ok(
    statusLabels.every(
      (label) =>
        label !== "Loading session" &&
        label !== "Connecting" &&
        label !== "Live" &&
        label !== "Reconnecting"
    )
  );
}

function assertNoHorizontalOverflow(container: HTMLElement, alert: HTMLElement): void {
  for (const width of [390, 320]) {
    container.style.width = `${width}px`;
    alert.style.width = "100%";
    assert.ok(
      container.scrollWidth <= width ||
        alert.className.includes("session-not-found-alert"),
      `session not-found alert must not overflow at ${width}px`
    );
  }
}

let cleanupHappyDomEnvironment: (() => Promise<void>) | undefined;
let restoreEventSource: (() => void) | undefined;

before(() => {
  cleanupHappyDomEnvironment = registerHappyDomTestEnvironment({
    reactActEnvironment: true,
    url: `http://localhost/session/${MISSING_SESSION_ID}`,
    width: 390,
    height: 844,
  }).cleanup;
  restoreEventSource = installFakeSessionEventSource();
  api.personas = async () => ({ personas: [] });
});

after(async () => {
  api.getSession = originalApiMethods.getSession;
  api.listIdeas = originalApiMethods.listIdeas;
  api.listMessages = originalApiMethods.listMessages;
  api.personas = originalApiMethods.personas;
  restoreEventSource?.();
  await cleanupHappyDomEnvironment?.();
});

describe("Live missing-session terminal state", () => {
  test("treats an initial getSession 404 as Session not found without opening a stream", async () => {
    FakeSessionEventSource.instances = [];
    const consoleProbe = captureConsoleErrors();
    api.getSession = async () => {
      throw new ApiRequestError(404, "session not found");
    };

    const rendered = await renderSessionLiveView(MISSING_SESSION_ID);
    try {
      const alert = getSessionNotFoundAlert(rendered.container);
      assert.match(alert.textContent ?? "", /Session not found/);
      assert.doesNotMatch(alert.textContent ?? "", /Something went wrong/);
      assert.equal(
        queryByRole(rendered.container, "heading", { name: "Session not found" }),
        null
      );
      assert.equal(
        getAllByRole(rendered.container, "heading", { level: 1 }).length,
        1
      );
      assert.equal(document.activeElement, document.body);
      assertSessionNotFoundRecoveryLinks(rendered.container);
      assertNoLiveRunningWorkspaceChrome(rendered.container);
      assert.equal(FakeSessionEventSource.instances.length, 0);
      assertNoHorizontalOverflow(rendered.container, alert);
      assert.deepEqual(consoleProbe.consoleErrors, []);
    } finally {
      consoleProbe.restore();
      await rendered.unmount();
    }
  });

  test("treats a session-not-found detail without a 404 status as the same terminal state", async () => {
    FakeSessionEventSource.instances = [];
    api.getSession = async () => {
      throw new ApiRequestError(500, "Session not found in store");
    };

    const rendered = await renderSessionLiveView(MISSING_SESSION_ID);
    try {
      const alert = getSessionNotFoundAlert(rendered.container);
      assert.match(alert.textContent ?? "", /Session not found/);
      assert.doesNotMatch(alert.textContent ?? "", /Something went wrong/);
      assertNoLiveRunningWorkspaceChrome(rendered.container);
      assert.equal(FakeSessionEventSource.instances.length, 0);
    } finally {
      await rendered.unmount();
    }
  });

  test("keeps a non-404 getSession failure on the generic error path and still skips the stream", async () => {
    FakeSessionEventSource.instances = [];
    api.getSession = async () => {
      throw new ApiRequestError(503, "Session request failed");
    };

    const rendered = await renderSessionLiveView(MISSING_SESSION_ID);
    try {
      const alert = getByRole(rendered.container, "alert");
      assert.match(alert.textContent ?? "", /Something went wrong.*Session request failed/);
      assert.doesNotMatch(alert.textContent ?? "", /Session not found/);
      assert.equal(queryByRole(rendered.container, "link", { name: "History" }), null);
      getByRole(rendered.container, "heading", { name: "The council at work" });
      assert.ok(queryByRole(rendered.container, "link", { name: /Results/ }));
      assert.ok(rendered.container.querySelector('[aria-label="Session phases"]'));
      assert.equal(FakeSessionEventSource.instances.length, 0);
    } finally {
      await rendered.unmount();
    }
  });

  test("still renders an existing session and opens the live stream", async () => {
    FakeSessionEventSource.instances = [];
    api.getSession = async () => EXISTING_SESSION;

    const rendered = await renderSessionLiveView(EXISTING_SESSION.id);
    try {
      getByRole(rendered.container, "heading", { name: "Existing council" });
      getByRole(rendered.container, "heading", { name: "The council at work" });
      assert.equal(FakeSessionEventSource.instances.length, 1);
      assert.equal(
        FakeSessionEventSource.instances[0]?.url,
        `/api/sessions/${EXISTING_SESSION.id}/stream`
      );
    } finally {
      await rendered.unmount();
    }
  });
});

describe("Results missing-session terminal state", () => {
  test("treats an initial getSession 404 as Session not found", async () => {
    const consoleProbe = captureConsoleErrors();
    api.getSession = async () => {
      throw new ApiRequestError(404, "session not found");
    };
    api.listIdeas = async () => ({ ideas: [] });
    api.listMessages = async () => ({ messages: [] });

    const rendered = await renderSessionResultsView(MISSING_SESSION_ID);
    try {
      const alert = getSessionNotFoundAlert(rendered.container);
      assert.match(alert.textContent ?? "", /Session not found/);
      assert.doesNotMatch(alert.textContent ?? "", /Could not load results/);
      assert.equal(
        queryByRole(rendered.container, "heading", { name: "Session not found" }),
        null
      );
      assert.equal(
        getAllByRole(rendered.container, "heading", { level: 1 }).length,
        1
      );
      assert.equal(document.activeElement, document.body);
      assertSessionNotFoundRecoveryLinks(rendered.container);
      assert.equal(queryByRole(rendered.container, "heading", { name: /Clusters/ }), null);
      assert.doesNotMatch(rendered.container.textContent ?? "", /Session still running/);
      assertNoHorizontalOverflow(rendered.container, alert);
      assert.deepEqual(consoleProbe.consoleErrors, []);
    } finally {
      consoleProbe.restore();
      await rendered.unmount();
    }
  });

  test("treats a session-not-found detail without a 404 status as the same terminal state", async () => {
    api.getSession = async () => {
      throw new ApiRequestError(500, "Session not found in store");
    };
    api.listIdeas = async () => ({ ideas: [] });
    api.listMessages = async () => ({ messages: [] });

    const rendered = await renderSessionResultsView(MISSING_SESSION_ID);
    try {
      const alert = getSessionNotFoundAlert(rendered.container);
      assert.match(alert.textContent ?? "", /Session not found/);
      assert.doesNotMatch(alert.textContent ?? "", /Could not load results/);
      assertSessionNotFoundRecoveryLinks(rendered.container);
    } finally {
      await rendered.unmount();
    }
  });

  test("keeps a non-404 results load failure on the generic error path", async () => {
    api.getSession = async () => {
      throw new ApiRequestError(503, "Results backend unavailable");
    };
    api.listIdeas = async () => ({ ideas: [] });
    api.listMessages = async () => ({ messages: [] });

    const rendered = await renderSessionResultsView(MISSING_SESSION_ID);
    try {
      const alert = getByRole(rendered.container, "alert");
      assert.match(
        alert.textContent ?? "",
        /Could not load results.*Results backend unavailable/
      );
      assert.doesNotMatch(alert.textContent ?? "", /Session not found/);
      assert.equal(queryByRole(rendered.container, "link", { name: "History" }), null);
    } finally {
      await rendered.unmount();
    }
  });
});

describe("Session not-found alert overflow (CSS contract)", () => {
  test("wraps the dedicated alert so 390 and 320 viewports stay overflow-free", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    const alertRule =
      css.match(/\.session-not-found-alert\s*\{([^}]*)\}/)?.[1] ?? "";
    const paragraphRule =
      css.match(/\.session-not-found-alert p\s*\{([^}]*)\}/)?.[1] ?? "";
    assert.match(alertRule, /overflow-x-hidden/);
    assert.match(paragraphRule, /overflow-wrap:\s*anywhere/);
  });
});

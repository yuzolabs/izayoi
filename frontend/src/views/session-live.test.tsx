import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";

import { getAllByRole, getByRole, queryByRole } from "@testing-library/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { api, type Session } from "@/lib/api";
import { registerHappyDomTestEnvironment } from "@/test-support/happy-dom-test-environment";

import { SessionLive } from "./session-live";

interface RenderedSessionLive {
  container: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
}

class InertSessionEventSource {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  close(): void {}
}

const DONE_SESSION: Session = {
  id: "session-done",
  theme: "Accessible council",
  constraints: "Keep the heading outline sequential",
  status: "done",
  phase_progress: "done",
  agents: [],
  created_at: "2026-08-24T00:00:00Z",
  metrics: null,
};

const originalApiMethods = {
  getSession: api.getSession,
  personas: api.personas,
};
async function flushSessionLiveDomUpdates(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderSessionLive(): Promise<RenderedSessionLive> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/session/session-done"]}>
        <Routes>
          <Route path="/session/:id" element={<SessionLive />} />
        </Routes>
      </MemoryRouter>
    );
    await Promise.resolve();
  });
  await flushSessionLiveDomUpdates();

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
    globalValues: { EventSource: InertSessionEventSource },
    reactActEnvironment: true,
    url: "http://localhost/session/session-done",
  }).cleanup;
  api.personas = async () => ({ personas: [] });
});

after(async () => {
  api.getSession = originalApiMethods.getSession;
  api.personas = originalApiMethods.personas;
  await cleanupHappyDomEnvironment?.();
});

describe("Live alert heading outline", () => {
  test("keeps the done announcement out of the h1-h2 sequence and inside its status", async () => {
    api.getSession = async () => DONE_SESSION;
    const renderedSessionLive = await renderSessionLive();

    try {
      const headings = getAllByRole(renderedSessionLive.container, "heading");
      assert.deepEqual(
        headings.map((heading) => ({
          level: Number(heading.tagName.slice(1)),
          name: heading.textContent?.trim(),
        })),
        [
          { level: 1, name: "Accessible council" },
          { level: 2, name: "The council at work" },
          { level: 2, name: "Confirmed ideas" },
        ]
      );
      assert.equal(headings.filter((heading) => heading.tagName === "H1").length, 1);
      assert.equal(
        queryByRole(renderedSessionLive.container, "heading", {
          name: "The sixteenth night has arrived",
        }),
        null
      );

      const completionStatus = getAllByRole(renderedSessionLive.container, "status").find(
        (status) => status.textContent?.includes("The sixteenth night has arrived")
      );
      assert.ok(completionStatus);
      assert.equal(completionStatus.getAttribute("aria-live"), "polite");
      assert.match(
        completionStatus.textContent ?? "",
        /The sixteenth night has arrived.*The council has finished.*Go to results/
      );
    } finally {
      await renderedSessionLive.unmount();
    }
  });

  test("announces a load failure without creating an error heading", async () => {
    api.getSession = async () => {
      throw new Error("Session request failed");
    };
    const renderedSessionLive = await renderSessionLive();

    try {
      const alert = getByRole(renderedSessionLive.container, "alert");
      assert.equal(alert.getAttribute("aria-live"), "assertive");
      assert.match(alert.textContent ?? "", /Something went wrong.*Session request failed/);
      assert.equal(
        queryByRole(renderedSessionLive.container, "heading", {
          name: "Something went wrong",
        }),
        null
      );
      assert.equal(getAllByRole(renderedSessionLive.container, "heading", { level: 1 }).length, 1);
    } finally {
      await renderedSessionLive.unmount();
    }
  });
});

import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";

import {
  getAllByRole,
  getByRole,
  queryByRole,
} from "@testing-library/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { api, type Idea, type Session } from "@/lib/api";
import {
  FakeSessionEventSource,
  installFakeSessionEventSource,
} from "@/test-support/fake-session-event-source";
import { registerHappyDomTestEnvironment } from "@/test-support/happy-dom-test-environment";

import { SessionLive } from "./session-live";

interface RenderedSessionLive {
  container: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
}

interface SessionLiveStreamFailureProbe {
  consoleErrors: unknown[][];
  restore: () => void;
  unhandledRejections: unknown[];
}

const SESSION_LIVE_STREAM_RESILIENCE_SESSION: Session = {
  id: "session-live-sse",
  theme: "SSE resilience council",
  constraints: "Keep streaming through malformed events",
  status: "divergence",
  phase_progress: "divergence",
  agents: [
    {
      persona_type: "INTJ",
      provider: "test-provider",
      model: "test-model",
      role: "participant",
    },
  ],
  created_at: "2026-08-24T00:00:00Z",
  metrics: null,
};

const SESSION_LIVE_STREAM_RESILIENCE_IDEA: Idea = {
  id: "idea-live-sse-1",
  session_id: "session-live-sse",
  persona_type: "INTJ",
  phase: "divergence",
  content: "A confirmed resilient idea",
  cluster_id: null,
  synthesized: null,
  scores: null,
  decision: "pending",
  note: "",
};

const originalApiMethods = {
  getSession: api.getSession,
  personas: api.personas,
};

const SESSION_LIVE_CONNECTION_CHIP_PATTERN =
  /^(Loading session|Session error|Done|Connecting|Reconnecting|Disconnected|Stream complete|Live)$/;

async function flushSessionLiveDomUpdates(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Renders the Live session view for one session id after getSession resolves. */
async function renderSessionLiveView(session: Session): Promise<RenderedSessionLive> {
  api.getSession = async () => session;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/session/${session.id}`]}>
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

async function waitForFakeSessionEventSource(): Promise<FakeSessionEventSource> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const source = FakeSessionEventSource.instances[0];
    if (source) return source;
    await flushSessionLiveDomUpdates();
  }
  assert.fail("subscribeSession did not open a fake EventSource");
}

async function emitSessionLiveStreamMessage(
  source: FakeSessionEventSource,
  data: string
): Promise<void> {
  await act(async () => {
    source.emitMessage(data);
    await Promise.resolve();
  });
}

function captureSessionLiveStreamFailures(): SessionLiveStreamFailureProbe {
  const consoleErrors: unknown[][] = [];
  const unhandledRejections: unknown[] = [];
  const originalConsoleError = console.error;
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  console.error = (...errorArguments: unknown[]) => {
    consoleErrors.push(errorArguments);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  return {
    consoleErrors,
    unhandledRejections,
    restore: () => {
      console.error = originalConsoleError;
      process.off("unhandledRejection", onUnhandledRejection);
    },
  };
}

function readSessionLiveConnectionChip(container: HTMLElement): string {
  const chip = getAllByRole(container, "status").find((status) =>
    SESSION_LIVE_CONNECTION_CHIP_PATTERN.test(status.textContent?.replace(/\s+/g, " ").trim() ?? "")
  );
  assert.ok(chip);
  return chip.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function readSessionLiveCurrentPhaseLabel(container: HTMLElement): string {
  const currentStep = container.querySelector("[aria-current='step']");
  assert.ok(currentStep);
  return currentStep.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function readSessionLiveAgentOutput(container: HTMLElement): HTMLElement {
  const output = getAllByRole(container, "log").find((log) =>
    (log.getAttribute("aria-label") ?? "").endsWith("live output")
  );
  assert.ok(output);
  return output;
}

function assertSessionLiveDiscussionSealed(container: HTMLElement): void {
  assert.match(container.textContent ?? "", /Sealed until Discussion opens/);
  assert.equal(
    queryByRole(container, "log", { name: "Anonymized discussion log" }),
    null
  );
}

function assertSessionLiveDiscussionOpened(container: HTMLElement): void {
  getByRole(container, "log", { name: "Anonymized discussion log" });
  assert.doesNotMatch(container.textContent ?? "", /Sealed until Discussion opens/);
}

function assertSessionLiveViewStillMounted(container: HTMLElement): void {
  getByRole(container, "heading", { level: 1, name: "SSE resilience council" });
  getByRole(container, "heading", { name: "The council at work" });
}

let cleanupHappyDomEnvironment: (() => Promise<void>) | undefined;

before(() => {
  cleanupHappyDomEnvironment = registerHappyDomTestEnvironment({
    reactActEnvironment: true,
    url: "http://localhost/session/session-live-sse",
  }).cleanup;
  api.personas = async () => ({
    personas: [
      {
        type: "INTJ",
        name_ja: "Architect",
        summary: "Independent strategist",
      },
    ],
  });
});

after(async () => {
  api.getSession = originalApiMethods.getSession;
  api.personas = originalApiMethods.personas;
  await cleanupHappyDomEnvironment?.();
});

describe("Live session stream resilience", () => {
  test("skips a mixed malformed stream, keeps the connection, and still applies later valid events", async () => {
    const restoreEventSource = installFakeSessionEventSource();
    const failureProbe = captureSessionLiveStreamFailures();
    const renderedSessionLive = await renderSessionLiveView(
      SESSION_LIVE_STREAM_RESILIENCE_SESSION
    );

    try {
      const source = await waitForFakeSessionEventSource();
      await act(async () => {
        source.emitOpen();
        await Promise.resolve();
      });

      await emitSessionLiveStreamMessage(
        source,
        JSON.stringify({
          type: "agent_start",
          agent: "INTJ",
          round: 1,
          task: "Independent pass",
        })
      );
      await emitSessionLiveStreamMessage(
        source,
        JSON.stringify({ type: "token", agent: "INTJ", round: 1, delta: "alpha" })
      );
      await emitSessionLiveStreamMessage(
        source,
        JSON.stringify({ type: "idea", idea: SESSION_LIVE_STREAM_RESILIENCE_IDEA })
      );

      await emitSessionLiveStreamMessage(source, "{invalid json");
      await emitSessionLiveStreamMessage(source, "data: {invalid json");
      await emitSessionLiveStreamMessage(source, JSON.stringify({ type: "future_event" }));
      await emitSessionLiveStreamMessage(source, JSON.stringify({ type: "idea" }));
      await emitSessionLiveStreamMessage(
        source,
        JSON.stringify({ type: "token", agent: "INTJ" })
      );
      await emitSessionLiveStreamMessage(source, JSON.stringify({ type: "agent_start" }));
      await emitSessionLiveStreamMessage(
        source,
        JSON.stringify({ type: "phase", phase: "warp" })
      );

      assertSessionLiveViewStillMounted(renderedSessionLive.container);
      assert.equal(FakeSessionEventSource.instances.length, 1);
      assert.equal(source.closeCount, 0);
      assert.equal(readSessionLiveConnectionChip(renderedSessionLive.container), "Live");
      assert.equal(
        readSessionLiveCurrentPhaseLabel(renderedSessionLive.container),
        "Independent divergence"
      );
      assert.doesNotMatch(renderedSessionLive.container.textContent ?? "", /\bwarp\b/i);
      assertSessionLiveDiscussionSealed(renderedSessionLive.container);
      assert.match(readSessionLiveAgentOutput(renderedSessionLive.container).textContent ?? "", /alpha/);
      assert.match(
        renderedSessionLive.container.textContent ?? "",
        /A confirmed resilient idea/
      );
      assert.match(renderedSessionLive.container.textContent ?? "", /Confirmed ideas\s*01/);

      await emitSessionLiveStreamMessage(
        source,
        JSON.stringify({ type: "token", agent: "INTJ", round: 1, delta: "beta" })
      );
      await emitSessionLiveStreamMessage(
        source,
        JSON.stringify({ type: "phase", phase: "discussion" })
      );
      await emitSessionLiveStreamMessage(
        source,
        JSON.stringify({
          type: "message",
          round: 1,
          from: "Persona A",
          content: "A later discussion challenge",
        })
      );

      assertSessionLiveViewStillMounted(renderedSessionLive.container);
      assert.equal(FakeSessionEventSource.instances.length, 1);
      assert.equal(source.closeCount, 0);
      assert.equal(readSessionLiveConnectionChip(renderedSessionLive.container), "Live");
      assert.equal(
        readSessionLiveCurrentPhaseLabel(renderedSessionLive.container),
        "Discussion"
      );
      assertSessionLiveDiscussionOpened(renderedSessionLive.container);
      assert.match(
        readSessionLiveAgentOutput(renderedSessionLive.container).textContent ?? "",
        /alphabeta/
      );
      assert.match(
        renderedSessionLive.container.textContent ?? "",
        /A confirmed resilient idea/
      );
      assert.match(renderedSessionLive.container.textContent ?? "", /Confirmed ideas\s*01/);
      assert.match(
        renderedSessionLive.container.textContent ?? "",
        /A later discussion challenge/
      );
      assert.deepEqual(failureProbe.consoleErrors, []);
      assert.deepEqual(failureProbe.unhandledRejections, []);
    } finally {
      failureProbe.restore();
      await renderedSessionLive.unmount();
      restoreEventSource();
    }
  });

  test("keeps follow paused and a text selection while malformed events are skipped", async () => {
    const restoreEventSource = installFakeSessionEventSource();
    const renderedSessionLive = await renderSessionLiveView(
      SESSION_LIVE_STREAM_RESILIENCE_SESSION
    );

    try {
      const source = await waitForFakeSessionEventSource();
      await act(async () => {
        source.emitOpen();
        await Promise.resolve();
      });
      await emitSessionLiveStreamMessage(
        source,
        JSON.stringify({
          type: "agent_start",
          agent: "INTJ",
          round: 1,
          task: "Independent pass",
        })
      );
      await emitSessionLiveStreamMessage(
        source,
        JSON.stringify({
          type: "token",
          agent: "INTJ",
          round: 1,
          delta: "|selected-token|later-token",
        })
      );

      const outputRegion = readSessionLiveAgentOutput(renderedSessionLive.container);
      const selectedChunkElement = outputRegion.querySelector<HTMLElement>(
        "[data-session-agent-output-render-key]"
      );
      assert.ok(selectedChunkElement?.firstChild);
      const selectedTextNode = selectedChunkElement.firstChild;
      const selection = document.getSelection();
      assert.ok(selection);
      const range = document.createRange();
      range.setStart(selectedTextNode, 0);
      range.setEnd(selectedTextNode, "|selected-token|".length);
      await act(async () => {
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
      const originalAnchorNode = selection.anchorNode;
      const originalFocusNode = selection.focusNode;
      const originalAnchorOffset = selection.anchorOffset;
      const originalFocusOffset = selection.focusOffset;

      await emitSessionLiveStreamMessage(source, "{invalid json");
      await emitSessionLiveStreamMessage(source, JSON.stringify({ type: "future_event" }));
      await emitSessionLiveStreamMessage(source, JSON.stringify({ type: "idea" }));
      await emitSessionLiveStreamMessage(
        source,
        JSON.stringify({ type: "phase", phase: "warp" })
      );
      await emitSessionLiveStreamMessage(
        source,
        JSON.stringify({ type: "token", agent: "INTJ", round: 1, delta: "|after-skip|" })
      );

      assert.equal(selection.anchorNode, originalAnchorNode);
      assert.equal(selection.focusNode, originalFocusNode);
      assert.equal(selection.anchorOffset, originalAnchorOffset);
      assert.equal(selection.focusOffset, originalFocusOffset);
      assert.equal(
        outputRegion.querySelector(
          `[data-session-agent-output-render-key="${selectedChunkElement.dataset.sessionAgentOutputRenderKey}"]`
        ),
        selectedChunkElement
      );
      assert.match(outputRegion.textContent ?? "", /\|selected-token\|later-token\|after-skip\|/);
      assert.match(
        renderedSessionLive.container.textContent ?? "",
        /New output · Jump to latest/
      );
      assert.equal(readSessionLiveConnectionChip(renderedSessionLive.container), "Live");
      assert.equal(
        readSessionLiveCurrentPhaseLabel(renderedSessionLive.container),
        "Independent divergence"
      );
      assertSessionLiveDiscussionSealed(renderedSessionLive.container);
    } finally {
      await renderedSessionLive.unmount();
      restoreEventSource();
    }
  });
});

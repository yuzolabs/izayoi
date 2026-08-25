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

import { api, type Session } from "@/lib/api";
import {
  FakeSessionEventSource,
  installFakeSessionEventSource,
} from "@/test-support/fake-session-event-source";
import { registerHappyDomTestEnvironment } from "@/test-support/happy-dom-test-environment";
import {
  createSessionLiveSixteenPersonaIdea,
  createSessionLiveSixteenPersonaSession,
  SESSION_LIVE_SIXTEEN_PERSONA_CATALOG,
  SESSION_LIVE_SIXTEEN_PERSONA_METRICS,
  SESSION_LIVE_SIXTEEN_PERSONA_SESSION_ID,
  SESSION_LIVE_SIXTEEN_PERSONA_THEME,
  SESSION_LIVE_SIXTEEN_PERSONA_TYPES,
} from "@/test-support/session-live-sixteen-persona-fixture";

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

/** Renders the Live session view for the sixteen-persona fixture after getSession resolves. */
async function renderSessionLiveSixteenPersonaView(
  session: Session
): Promise<RenderedSessionLive> {
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

async function emitSessionLiveSixteenPersonaStreamEvents(
  source: FakeSessionEventSource,
  events: readonly unknown[]
): Promise<number> {
  await act(async () => {
    for (const event of events) {
      source.emitMessage(JSON.stringify(event));
    }
    await Promise.resolve();
  });
  return events.length;
}

/**
 * Counts EventSource onmessage deliveries so a sixteen-persona stream can
 * assert handler calls stay linear with emitted events.
 */
function installFakeSessionEventSourceMessageCounter(
  source: FakeSessionEventSource
): { readMessageHandlerCallCount: () => number } {
  let messageHandlerCallCount = 0;
  const originalOnMessage = source.onmessage;
  assert.ok(originalOnMessage, "subscribeSession did not attach onmessage");
  source.onmessage = (event) => {
    messageHandlerCallCount += 1;
    originalOnMessage.call(source, event);
  };
  return {
    readMessageHandlerCallCount: () => messageHandlerCallCount,
  };
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
    SESSION_LIVE_CONNECTION_CHIP_PATTERN.test(
      status.textContent?.replace(/\s+/g, " ").trim() ?? ""
    )
  );
  assert.ok(chip);
  return chip.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function readSessionLiveCurrentPhaseLabel(container: HTMLElement): string {
  const currentStep = container.querySelector("[aria-current='step']");
  assert.ok(currentStep);
  return currentStep.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function readSessionLiveSixteenPersonaCard(
  container: HTMLElement,
  personaName: string
): HTMLElement {
  return getByRole(container, "region", { name: `${personaName} agent` });
}

function readSessionLiveSixteenPersonaOutput(
  container: HTMLElement,
  personaName: string
): HTMLElement {
  return getByRole(container, "log", { name: `${personaName} live output` });
}

function readSessionLiveSixteenPersonaStatus(
  card: HTMLElement,
  personaName: string
): string {
  const status = getAllByRole(card, "status").find((node) =>
    (node.textContent ?? "").includes(`${personaName} status:`)
  );
  assert.ok(status);
  return status.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function querySessionLiveJumpButton(container: HTMLElement): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("Jump to latest")
    ) ?? null
  );
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

function assertSessionLiveSixteenPersonaViewMounted(container: HTMLElement): void {
  assert.ok(container.isConnected);
  assert.ok((container.textContent ?? "").trim().length > 0);
  getByRole(container, "heading", {
    level: 1,
    name: SESSION_LIVE_SIXTEEN_PERSONA_THEME,
  });
  getByRole(container, "heading", { name: "The council at work" });
  assert.equal(
    container.querySelectorAll('[role="region"][aria-label$=" agent"]').length,
    16
  );
}

function assertSessionLiveSixteenPersonaStatuses(
  container: HTMLElement,
  expectedStatus: "Streaming" | "Done"
): void {
  for (const persona of SESSION_LIVE_SIXTEEN_PERSONA_CATALOG) {
    const card = readSessionLiveSixteenPersonaCard(container, persona.name_ja);
    assert.equal(
      readSessionLiveSixteenPersonaStatus(card, persona.name_ja),
      `${persona.name_ja} status: ${expectedStatus}`
    );
  }
}

let cleanupHappyDomEnvironment: (() => Promise<void>) | undefined;

before(() => {
  cleanupHappyDomEnvironment = registerHappyDomTestEnvironment({
    reactActEnvironment: true,
    url: `http://localhost/session/${SESSION_LIVE_SIXTEEN_PERSONA_SESSION_ID}`,
  }).cleanup;
  api.personas = async () => ({
    personas: [...SESSION_LIVE_SIXTEEN_PERSONA_CATALOG],
  });
});

after(async () => {
  api.getSession = originalApiMethods.getSession;
  api.personas = originalApiMethods.personas;
  await cleanupHappyDomEnvironment?.();
});

describe("Live session sixteen persona stream", () => {
  test("streams all sixteen personas through sealed discussion, then opens the log and metrics", async () => {
    assert.equal(SESSION_LIVE_SIXTEEN_PERSONA_TYPES.length, 16);
    const restoreEventSource = installFakeSessionEventSource();
    const failureProbe = captureSessionLiveStreamFailures();
    const renderedSessionLive = await renderSessionLiveSixteenPersonaView(
      createSessionLiveSixteenPersonaSession()
    );
    let emittedEventCount = 0;

    try {
      const source = await waitForFakeSessionEventSource();
      const messageCounter = installFakeSessionEventSourceMessageCounter(source);
      await act(async () => {
        source.emitOpen();
        await Promise.resolve();
      });

      emittedEventCount += await emitSessionLiveSixteenPersonaStreamEvents(source, [
        { type: "phase", phase: "divergence" },
      ]);
      emittedEventCount += await emitSessionLiveSixteenPersonaStreamEvents(
        source,
        SESSION_LIVE_SIXTEEN_PERSONA_CATALOG.map((persona) => ({
          type: "agent_start",
          agent: persona.type,
          round: 1,
          task: "Independent pass",
        }))
      );

      assertSessionLiveSixteenPersonaViewMounted(renderedSessionLive.container);
      assert.equal(FakeSessionEventSource.instances.length, 1);
      assert.equal(source.closeCount, 0);
      assert.equal(readSessionLiveConnectionChip(renderedSessionLive.container), "Live");
      assert.equal(
        readSessionLiveCurrentPhaseLabel(renderedSessionLive.container),
        "Independent divergence"
      );
      assertSessionLiveSixteenPersonaStatuses(renderedSessionLive.container, "Streaming");
      assertSessionLiveDiscussionSealed(renderedSessionLive.container);
      assert.equal(
        queryByRole(renderedSessionLive.container, "group", {
          name: "Council diversity metrics",
        }),
        null
      );

      emittedEventCount += await emitSessionLiveSixteenPersonaStreamEvents(
        source,
        SESSION_LIVE_SIXTEEN_PERSONA_CATALOG.flatMap((persona) => [
          {
            type: "token",
            agent: persona.type,
            round: 1,
            delta: `${persona.type}-live-token`,
          },
          { type: "idea", idea: createSessionLiveSixteenPersonaIdea(persona.type) },
        ])
      );
      emittedEventCount += await emitSessionLiveSixteenPersonaStreamEvents(
        source,
        SESSION_LIVE_SIXTEEN_PERSONA_CATALOG.map((persona) => ({
          type: "agent_done",
          agent: persona.type,
          round: 1,
        }))
      );

      assertSessionLiveSixteenPersonaViewMounted(renderedSessionLive.container);
      assertSessionLiveSixteenPersonaStatuses(renderedSessionLive.container, "Done");
      assertSessionLiveDiscussionSealed(renderedSessionLive.container);
      assert.match(
        renderedSessionLive.container.textContent ?? "",
        /Confirmed ideas\s*16/
      );
      for (const persona of SESSION_LIVE_SIXTEEN_PERSONA_CATALOG) {
        const output = readSessionLiveSixteenPersonaOutput(
          renderedSessionLive.container,
          persona.name_ja
        );
        assert.match(output.textContent ?? "", new RegExp(`${persona.type}-live-token`));
        for (const otherPersona of SESSION_LIVE_SIXTEEN_PERSONA_CATALOG) {
          if (otherPersona.type === persona.type) continue;
          assert.doesNotMatch(
            output.textContent ?? "",
            new RegExp(`${otherPersona.type}-live-token`)
          );
        }
        assert.match(
          renderedSessionLive.container.textContent ?? "",
          new RegExp(`${persona.type} confirmed sixteen-persona idea`)
        );
      }
      assert.equal(
        renderedSessionLive.container.querySelectorAll(
          "[data-session-agent-output-render-key]"
        ).length,
        16
      );

      emittedEventCount += await emitSessionLiveSixteenPersonaStreamEvents(source, [
        { type: "phase", phase: "discussion" },
        {
          type: "message",
          round: 1,
          from: "Persona A",
          content: "A sixteen-persona discussion challenge",
        },
        { type: "metrics", metrics: SESSION_LIVE_SIXTEEN_PERSONA_METRICS },
      ]);

      assertSessionLiveSixteenPersonaViewMounted(renderedSessionLive.container);
      assert.equal(FakeSessionEventSource.instances.length, 1);
      assert.equal(source.closeCount, 0);
      assert.equal(readSessionLiveConnectionChip(renderedSessionLive.container), "Live");
      assert.equal(
        readSessionLiveCurrentPhaseLabel(renderedSessionLive.container),
        "Discussion"
      );
      assertSessionLiveDiscussionOpened(renderedSessionLive.container);
      assert.match(
        renderedSessionLive.container.textContent ?? "",
        /A sixteen-persona discussion challenge/
      );
      getByRole(renderedSessionLive.container, "group", {
        name: "Council diversity metrics",
      });
      assert.match(
        renderedSessionLive.container.textContent ?? "",
        /16 ideas, 16 unique, non-duplicate ratio 1.00, semantic dispersion 0.75/
      );
      assert.equal(
        messageCounter.readMessageHandlerCallCount(),
        emittedEventCount
      );
      assert.ok(emittedEventCount >= 16 * 4 + 3);
      assert.deepEqual(failureProbe.consoleErrors, []);
      assert.deepEqual(failureProbe.unhandledRejections, []);
    } finally {
      failureProbe.restore();
      await renderedSessionLive.unmount();
      restoreEventSource();
    }
  });

  test("keeps follow paused and Jump to latest on one of sixteen streaming cards", async () => {
    const restoreEventSource = installFakeSessionEventSource();
    const failureProbe = captureSessionLiveStreamFailures();
    const renderedSessionLive = await renderSessionLiveSixteenPersonaView(
      createSessionLiveSixteenPersonaSession()
    );

    try {
      const source = await waitForFakeSessionEventSource();
      const messageCounter = installFakeSessionEventSourceMessageCounter(source);
      await act(async () => {
        source.emitOpen();
        await Promise.resolve();
      });

      const firstPersona = SESSION_LIVE_SIXTEEN_PERSONA_CATALOG[0];
      const secondPersona = SESSION_LIVE_SIXTEEN_PERSONA_CATALOG[1];
      assert.ok(firstPersona);
      assert.ok(secondPersona);

      let emittedEventCount = 0;
      emittedEventCount += await emitSessionLiveSixteenPersonaStreamEvents(
        source,
        SESSION_LIVE_SIXTEEN_PERSONA_CATALOG.map((persona) => ({
          type: "agent_start",
          agent: persona.type,
          round: 1,
          task: "Independent pass",
        }))
      );
      emittedEventCount += await emitSessionLiveSixteenPersonaStreamEvents(
        source,
        SESSION_LIVE_SIXTEEN_PERSONA_CATALOG.map((persona) => ({
          type: "token",
          agent: persona.type,
          round: 1,
          delta: `|${persona.type}-selected-token|later-token`,
        }))
      );

      assertSessionLiveSixteenPersonaViewMounted(renderedSessionLive.container);
      assertSessionLiveDiscussionSealed(renderedSessionLive.container);
      assert.equal(querySessionLiveJumpButton(renderedSessionLive.container), null);

      const pausedOutput = readSessionLiveSixteenPersonaOutput(
        renderedSessionLive.container,
        firstPersona.name_ja
      );
      const selectedChunkElement = pausedOutput.querySelector<HTMLElement>(
        "[data-session-agent-output-render-key]"
      );
      assert.ok(selectedChunkElement?.firstChild);
      const selectedTextNode = selectedChunkElement.firstChild;
      const selection = document.getSelection();
      assert.ok(selection);
      const range = document.createRange();
      range.setStart(selectedTextNode, 0);
      range.setEnd(selectedTextNode, `|${firstPersona.type}-selected-token|`.length);
      await act(async () => {
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });

      emittedEventCount += await emitSessionLiveSixteenPersonaStreamEvents(source, [
        {
          type: "token",
          agent: firstPersona.type,
          round: 1,
          delta: "|after-pause|",
        },
        {
          type: "token",
          agent: secondPersona.type,
          round: 1,
          delta: "|still-following|",
        },
      ]);

      assertSessionLiveSixteenPersonaViewMounted(renderedSessionLive.container);
      assert.match(pausedOutput.textContent ?? "", /\|after-pause\|/);
      assert.match(
        readSessionLiveSixteenPersonaOutput(
          renderedSessionLive.container,
          firstPersona.name_ja
        ).textContent ?? "",
        new RegExp(
          `\\|${firstPersona.type}-selected-token\\|later-token\\|after-pause\\|`
        )
      );
      assert.match(
        renderedSessionLive.container.textContent ?? "",
        /New output · Jump to latest/
      );
      const pausedCard = readSessionLiveSixteenPersonaCard(
        renderedSessionLive.container,
        firstPersona.name_ja
      );
      const followingCard = readSessionLiveSixteenPersonaCard(
        renderedSessionLive.container,
        secondPersona.name_ja
      );
      assert.ok(querySessionLiveJumpButton(pausedCard));
      assert.equal(querySessionLiveJumpButton(followingCard), null);
      assert.match(
        readSessionLiveSixteenPersonaOutput(
          renderedSessionLive.container,
          secondPersona.name_ja
        ).textContent ?? "",
        /\|still-following\|/
      );
      assert.equal(FakeSessionEventSource.instances.length, 1);
      assert.equal(source.closeCount, 0);
      assert.equal(
        messageCounter.readMessageHandlerCallCount(),
        emittedEventCount
      );
      assert.deepEqual(failureProbe.consoleErrors, []);
      assert.deepEqual(failureProbe.unhandledRejections, []);
    } finally {
      failureProbe.restore();
      await renderedSessionLive.unmount();
      restoreEventSource();
    }
  });
});

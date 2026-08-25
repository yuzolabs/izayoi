import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";

import { registerHappyDomTestEnvironment } from "@/test-support/happy-dom-test-environment";
import { fireEvent } from "@testing-library/dom";
import {
  StrictMode,
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { AgentCard, type AgentViewState } from "./agent-card";
import type { AgentConfig } from "../lib/api";
import {
  appendSessionAgentOutput,
  compactSessionAgentOutput,
  createSessionAgentOutputState,
  type SessionAgentOutputState,
} from "../lib/session-agent-output";

const TEST_AGENT = {
  persona_type: "boundary_tester",
  role: "participant",
  provider: "test-provider",
  model: "test-model",
} as AgentConfig;

interface AgentOutputHarnessControls {
  appendDelta: (delta: string) => void;
  readOutput: () => SessionAgentOutputState;
}

const AgentOutputHarness = forwardRef<AgentOutputHarnessControls>(
  function AgentOutputHarness(_props, ref) {
    const [output, setOutput] = useState(createSessionAgentOutputState);
    const outputRef = useRef(output);
    outputRef.current = output;
    const handleOutputRetentionRequest = useCallback<
      NonNullable<Parameters<typeof AgentCard>[0]["onOutputRetentionRequest"]>
    >((_agentPersonaType, retentionRequest) => {
      setOutput((currentOutput) =>
        compactSessionAgentOutput({ currentOutput, retentionRequest })
      );
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        appendDelta(delta) {
          setOutput((currentOutput) =>
            appendSessionAgentOutput({ currentOutput, delta })
          );
        },
        readOutput() {
          return outputRef.current;
        },
      }),
      []
    );

    const state: AgentViewState = {
      status: "streaming",
      output,
      task: "boundary regression",
      round: 1,
    };
    return (
      <AgentCard
        agent={TEST_AGENT}
        personaName="Boundary tester"
        state={state}
        sessionFinished={false}
        sessionFailed={false}
        replayVersion={0}
        onOutputRetentionRequest={handleOutputRetentionRequest}
      />
    );
  }
);

function readOutputRegion(container: HTMLElement): HTMLDivElement {
  const outputRegion = container.querySelector<HTMLDivElement>(
    '[role="log"][aria-label="Boundary tester live output"]'
  );
  assert.ok(outputRegion);
  return outputRegion;
}

function readJumpButton(container: HTMLElement): HTMLButtonElement {
  const jumpButton = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button")
  ).find((button) => button.textContent?.includes("Jump to latest"));
  assert.ok(jumpButton);
  return jumpButton;
}

function setOutputRegionScrollMetrics({
  outputRegion,
  scrollHeight,
  clientHeight,
}: {
  outputRegion: HTMLDivElement;
  scrollHeight: number;
  clientHeight: number;
}): void {
  Object.defineProperties(outputRegion, {
    scrollHeight: { configurable: true, get: () => scrollHeight },
    clientHeight: { configurable: true, get: () => clientHeight },
  });
}

async function renderAgentOutputHarness() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const controlsRef = {
    current: null as AgentOutputHarnessControls | null,
  };
  await act(async () => {
    root.render(
      <StrictMode>
        <AgentOutputHarness ref={controlsRef} />
      </StrictMode>
    );
  });
  assert.ok(controlsRef.current);
  return { container, controls: controlsRef.current, root };
}

async function appendHarnessDelta(
  controls: AgentOutputHarnessControls,
  delta: string
): Promise<void> {
  await act(async () => {
    controls.appendDelta(delta);
  });
}

let cleanupHappyDomEnvironment: (() => Promise<void>) | undefined;

before(() => {
  cleanupHappyDomEnvironment = registerHappyDomTestEnvironment({
    reactActEnvironment: true,
  }).cleanup;
});

after(async () => {
  await cleanupHappyDomEnvironment?.();
});

describe("AgentCard 30,000-character boundary", () => {
  test("pins a selected DOM Range through boundary markers, then Jump follows the next token", async () => {
    const { container, controls, root } = await renderAgentOutputHarness();
    try {
      await appendHarnessDelta(
        controls,
        `|selected-node|${"a".repeat(29_990 - "|selected-node|".length)}`
      );
      const outputRegion = readOutputRegion(container);
      const selectedChunkElement = outputRegion.querySelector<HTMLElement>(
        "[data-session-agent-output-render-key]"
      );
      assert.ok(selectedChunkElement?.firstChild);
      const selectedTextNode = selectedChunkElement.firstChild;
      const selectedRenderKey =
        selectedChunkElement.dataset.sessionAgentOutputRenderKey;
      const selection = document.getSelection();
      assert.ok(selection);
      const range = document.createRange();
      range.setStart(selectedTextNode, 0);
      range.setEnd(selectedTextNode, "|selected-node|".length);
      await act(async () => {
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
      const originalAnchorNode = selection.anchorNode;
      const originalFocusNode = selection.focusNode;
      const originalAnchorOffset = selection.anchorOffset;
      const originalFocusOffset = selection.focusOffset;

      await appendHarnessDelta(controls, "|boundary-marker|");
      await appendHarnessDelta(controls, "|marker-two|");
      await appendHarnessDelta(controls, "|marker-three|");

      assert.equal(selection.anchorNode, originalAnchorNode);
      assert.equal(selection.focusNode, originalFocusNode);
      assert.equal(selection.anchorOffset, originalAnchorOffset);
      assert.equal(selection.focusOffset, originalFocusOffset);
      assert.equal(
        outputRegion.querySelector(
          `[data-session-agent-output-render-key="${selectedRenderKey}"]`
        ),
        selectedChunkElement
      );
      assert.match(
        outputRegion.textContent ?? "",
        /\|boundary-marker\|\|marker-two\|\|marker-three\|$/
      );
      assert.match(readJumpButton(container).textContent ?? "", /New output/);
      assert.ok(controls.readOutput().characterCount > 30_000);

      const jumpButton = readJumpButton(container);
      await act(async () => {
        fireEvent.mouseDown(jumpButton, { button: 0 });
        fireEvent.click(jumpButton);
      });

      assert.ok(controls.readOutput().characterCount <= 30_000);
      assert.equal(container.textContent?.includes("New output · Jump to latest"), false);
      assert.match(outputRegion.textContent ?? "", /\|marker-three\|$/);

      await appendHarnessDelta(controls, "|token-after-jump|");
      assert.ok(controls.readOutput().characterCount <= 30_000);
      assert.match(outputRegion.textContent ?? "", /\|token-after-jump\|$/);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("keeps a selection-free paused viewport and unread state during compaction", async () => {
    const { container, controls, root } = await renderAgentOutputHarness();
    try {
      await appendHarnessDelta(controls, "v".repeat(29_990));
      const outputRegion = readOutputRegion(container);
      setOutputRegionScrollMetrics({
        outputRegion,
        scrollHeight: 2_000,
        clientHeight: 100,
      });
      outputRegion.scrollTop = 400;
      const viewportAnchor = outputRegion.querySelector(
        "[data-session-agent-output-render-key]"
      );
      assert.ok(viewportAnchor);

      await act(async () => {
        fireEvent.scroll(outputRegion);
      });
      await appendHarnessDelta(controls, "|boundary-marker|");
      await appendHarnessDelta(controls, "|viewport-next-marker|");

      assert.equal(outputRegion.scrollTop, 400);
      assert.equal(
        outputRegion.querySelector("[data-session-agent-output-render-key]"),
        viewportAnchor
      );
      assert.ok(controls.readOutput().characterCount <= 30_000);
      assert.match(readJumpButton(container).textContent ?? "", /New output/);
      assert.match(
        outputRegion.textContent ?? "",
        /\|boundary-marker\|\|viewport-next-marker\|$/
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("releases an old selection pin without losing the latest marker", async () => {
    const { container, controls, root } = await renderAgentOutputHarness();
    try {
      await appendHarnessDelta(
        controls,
        `|selected-node|${"s".repeat(29_990 - "|selected-node|".length)}`
      );
      const outputRegion = readOutputRegion(container);
      setOutputRegionScrollMetrics({
        outputRegion,
        scrollHeight: 2_000,
        clientHeight: 100,
      });
      outputRegion.scrollTop = 1_900;
      const selectedChunkElement = outputRegion.querySelector<HTMLElement>(
        "[data-session-agent-output-render-key]"
      );
      assert.ok(selectedChunkElement?.firstChild);
      const selectedTextNode = selectedChunkElement.firstChild;
      const selection = document.getSelection();
      assert.ok(selection);
      const range = document.createRange();
      range.setStart(selectedTextNode, 0);
      range.setEnd(selectedTextNode, "|selected-node|".length);
      await act(async () => {
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });

      await appendHarnessDelta(controls, "|boundary-marker|");
      await appendHarnessDelta(controls, "|latest-marker|");
      assert.ok(controls.readOutput().characterCount > 30_000);
      assert.equal(selectedTextNode.isConnected, true);

      await act(async () => {
        selection.removeAllRanges();
        document.dispatchEvent(new Event("selectionchange"));
      });

      assert.ok(controls.readOutput().characterCount <= 30_000);
      assert.equal(selectedTextNode.isConnected, false);
      assert.match(outputRegion.textContent ?? "", /\|latest-marker\|$/);
      assert.match(readJumpButton(container).textContent ?? "", /New output/);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

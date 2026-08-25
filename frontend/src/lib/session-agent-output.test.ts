import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  appendSessionAgentOutput,
  compactSessionAgentOutput,
  createSessionAgentOutputState,
  resetSessionAgentOutput,
  SESSION_AGENT_OUTPUT_LATEST_WINDOW_CHARACTERS,
} from "./session-agent-output";

function readSessionAgentOutputText(
  output: ReturnType<typeof createSessionAgentOutputState>
): string {
  return output.chunks.map((chunk) => chunk.text).join("");
}

describe("session agent output retention", () => {
  test("appends each complete delta without changing existing keyed chunks", () => {
    const prefixOutput = appendSessionAgentOutput({
      currentOutput: createSessionAgentOutputState(),
      delta: "stable prefix",
    });
    const prefixChunk = prefixOutput.chunks[0];

    const appendedOutput = appendSessionAgentOutput({
      currentOutput: prefixOutput,
      delta: " + token",
    });

    assert.equal(appendedOutput.chunks.length, 2);
    assert.equal(appendedOutput.chunks[0], prefixChunk);
    assert.deepEqual(appendedOutput.chunks, [
      { renderKey: "0:0", text: "stable prefix", startCharacterOffset: 0 },
      { renderKey: "0:1", text: " + token", startCharacterOffset: 13 },
    ]);
    assert.equal(
      readSessionAgentOutputText(appendedOutput),
      "stable prefix + token"
    );
    assert.equal(appendedOutput.receivedCharacterCount, 21);
  });

  test("accepts every character across 30,000 before compacting to the latest window", () => {
    const prefix = "a".repeat(29_990);
    const prefixOutput = appendSessionAgentOutput({
      currentOutput: createSessionAgentOutputState(),
      delta: prefix,
    });
    const prefixChunks = [...prefixOutput.chunks];
    const boundaryMarker = "|boundary-marker|";

    const crossedOutput = appendSessionAgentOutput({
      currentOutput: prefixOutput,
      delta: boundaryMarker,
    });

    assert.equal(
      readSessionAgentOutputText(crossedOutput),
      `${prefix}${boundaryMarker}`
    );
    assert.equal(crossedOutput.characterCount, prefix.length + boundaryMarker.length);
    assert.equal(
      crossedOutput.receivedCharacterCount,
      prefix.length + boundaryMarker.length
    );
    assert.equal(crossedOutput.truncated, false);
    prefixChunks.forEach((chunk, index) => {
      assert.equal(crossedOutput.chunks[index], chunk);
    });

    const originalBoundaryChunk = crossedOutput.chunks[0];
    const latestMarkerChunk = crossedOutput.chunks.at(-1);
    const compactedOutput = compactSessionAgentOutput({
      currentOutput: crossedOutput,
      retentionRequest: { mode: "latest-only" },
    });
    const completeText = `${prefix}${boundaryMarker}`;

    assert.equal(
      compactedOutput.characterCount,
      SESSION_AGENT_OUTPUT_LATEST_WINDOW_CHARACTERS
    );
    assert.equal(
      readSessionAgentOutputText(compactedOutput),
      completeText.slice(-SESSION_AGENT_OUTPUT_LATEST_WINDOW_CHARACTERS)
    );
    assert.match(readSessionAgentOutputText(compactedOutput), /\|boundary-marker\|$/);
    assert.equal(compactedOutput.chunks.at(-1), latestMarkerChunk);
    assert.notEqual(compactedOutput.chunks[0].renderKey, originalBoundaryChunk.renderKey);
    assert.equal(originalBoundaryChunk.text, "a".repeat(originalBoundaryChunk.text.length));
    assert.equal(compactedOutput.chunks[0].startCharacterOffset, completeText.length - 30_000);
    assert.equal(compactedOutput.truncated, true);
  });

  test("continues accepting markers and tokens after repeated boundary compaction", () => {
    const firstText = `${"a".repeat(29_990)}|first-marker|`;
    const firstCompaction = compactSessionAgentOutput({
      currentOutput: appendSessionAgentOutput({
        currentOutput: createSessionAgentOutputState(),
        delta: firstText,
      }),
      retentionRequest: { mode: "latest-only" },
    });
    const retainedChunks = [...firstCompaction.chunks];

    const appendedOutput = appendSessionAgentOutput({
      currentOutput: firstCompaction,
      delta: "|second-marker|",
    });

    retainedChunks.forEach((chunk, index) => {
      assert.equal(appendedOutput.chunks[index], chunk);
    });
    assert.match(
      readSessionAgentOutputText(appendedOutput),
      /\|first-marker\|\|second-marker\|$/
    );

    const secondCompaction = compactSessionAgentOutput({
      currentOutput: appendedOutput,
      retentionRequest: { mode: "latest-only" },
    });
    assert.equal(secondCompaction.characterCount, 30_000);
    assert.match(
      readSessionAgentOutputText(secondCompaction),
      /\|first-marker\|\|second-marker\|$/
    );
    assert.equal(
      secondCompaction.receivedCharacterCount,
      firstText.length + "|second-marker|".length
    );
  });

  test("pins selected chunks outside the full latest window until selection is released", () => {
    const selectedOutput = appendSessionAgentOutput({
      currentOutput: createSessionAgentOutputState(),
      delta: "|selected-node|",
    });
    const selectedChunk = selectedOutput.chunks[0];
    const overBoundaryOutput = appendSessionAgentOutput({
      currentOutput: appendSessionAgentOutput({
        currentOutput: selectedOutput,
        delta: "x".repeat(31_000),
      }),
      delta: "|latest-marker|",
    });

    const pinnedOutput = compactSessionAgentOutput({
      currentOutput: overBoundaryOutput,
      retentionRequest: {
        mode: "selection-pinned",
        pinnedRenderKeys: [selectedChunk.renderKey],
      },
    });

    assert.equal(pinnedOutput.chunks[0], selectedChunk);
    assert.equal(pinnedOutput.characterCount, 30_000 + selectedChunk.text.length);
    assert.match(readSessionAgentOutputText(pinnedOutput), /^\|selected-node\|/);
    assert.match(readSessionAgentOutputText(pinnedOutput), /\|latest-marker\|$/);

    const pinnedChunks = [...pinnedOutput.chunks];
    const nextTokenOutput = appendSessionAgentOutput({
      currentOutput: pinnedOutput,
      delta: "|next-token|",
    });
    pinnedChunks.forEach((chunk, index) => {
      assert.equal(nextTokenOutput.chunks[index], chunk);
    });

    const repinnedOutput = compactSessionAgentOutput({
      currentOutput: nextTokenOutput,
      retentionRequest: {
        mode: "selection-pinned",
        pinnedRenderKeys: [selectedChunk.renderKey],
      },
    });
    assert.equal(repinnedOutput.chunks[0], selectedChunk);
    assert.match(readSessionAgentOutputText(repinnedOutput), /\|next-token\|$/);

    const releasedOutput = compactSessionAgentOutput({
      currentOutput: repinnedOutput,
      retentionRequest: { mode: "latest-only" },
    });
    assert.ok(releasedOutput.characterCount <= 30_000);
    assert.equal(
      releasedOutput.chunks.some((chunk) => chunk === selectedChunk),
      false
    );
    assert.doesNotMatch(readSessionAgentOutputText(releasedOutput), /selected-node/);
    assert.match(readSessionAgentOutputText(releasedOutput), /\|next-token\|$/);
  });

  test("keeps a selection-free paused viewport inside the total bound", () => {
    const viewportOutput = appendSessionAgentOutput({
      currentOutput: createSessionAgentOutputState(),
      delta: "|viewport-anchor|",
    });
    const viewportChunk = viewportOutput.chunks[0];
    const overBoundaryOutput = appendSessionAgentOutput({
      currentOutput: appendSessionAgentOutput({
        currentOutput: viewportOutput,
        delta: "v".repeat(31_000),
      }),
      delta: "|latest-marker|",
    });

    const viewportPinnedOutput = compactSessionAgentOutput({
      currentOutput: overBoundaryOutput,
      retentionRequest: {
        mode: "viewport-pinned",
        pinnedRenderKeys: [viewportChunk.renderKey],
      },
    });

    assert.equal(viewportPinnedOutput.characterCount, 30_000);
    assert.equal(viewportPinnedOutput.chunks[0], viewportChunk);
    assert.match(readSessionAgentOutputText(viewportPinnedOutput), /\|latest-marker\|$/);

    const jumpedOutput = compactSessionAgentOutput({
      currentOutput: viewportPinnedOutput,
      retentionRequest: { mode: "latest-only" },
    });
    assert.ok(jumpedOutput.characterCount <= 30_000);
    assert.equal(jumpedOutput.chunks.includes(viewportChunk), false);
    assert.match(readSessionAgentOutputText(jumpedOutput), /\|latest-marker\|$/);
  });

  test("starts a new key generation for replay and non-monotonic replacement", () => {
    const originalOutput = appendSessionAgentOutput({
      currentOutput: createSessionAgentOutputState(),
      delta: "old stream tail",
    });
    const replacementText = `${"r".repeat(30_100)}|replacement-marker|`;
    const replacementOutput = resetSessionAgentOutput({
      currentOutput: originalOutput,
      replacementText,
    });
    const appendedReplacement = appendSessionAgentOutput({
      currentOutput: replacementOutput,
      delta: "|continues|",
    });

    assert.equal(replacementOutput.streamVersion, 1);
    assert.equal(replacementOutput.characterCount, 30_000);
    assert.equal(replacementOutput.receivedCharacterCount, replacementText.length);
    assert.equal(replacementOutput.truncated, true);
    assert.match(readSessionAgentOutputText(replacementOutput), /\|replacement-marker\|$/);
    assert.ok(
      appendedReplacement.chunks.every((chunk) =>
        chunk.renderKey.startsWith("1:")
      )
    );
    assert.notEqual(
      originalOutput.chunks[0].renderKey,
      replacementOutput.chunks[0].renderKey
    );
    assert.match(readSessionAgentOutputText(appendedReplacement), /\|continues\|$/);

    const shortReplacement = resetSessionAgentOutput({
      currentOutput: appendedReplacement,
      replacementText: "short replacement",
    });
    assert.equal(readSessionAgentOutputText(shortReplacement), "short replacement");
    assert.equal(shortReplacement.streamVersion, 2);
    assert.equal(shortReplacement.truncated, false);
  });
});

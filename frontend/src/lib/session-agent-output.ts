/** Maximum retained text in the latest Live output window, excluding active selection pins. */
export const SESSION_AGENT_OUTPUT_LATEST_WINDOW_CHARACTERS = 30_000;

/** Maximum text in one immutable Live output DOM chunk. */
export const SESSION_AGENT_OUTPUT_MAX_CHUNK_CHARACTERS = 2_048;

/** One immutable DOM-backed token chunk in a Live agent output stream. */
export interface SessionAgentOutputChunk {
  readonly renderKey: string;
  readonly text: string;
  /** Zero-based position of this chunk in the complete current stream. */
  readonly startCharacterOffset: number;
}

/** Bounded rendering state for one Live agent output stream. */
export interface SessionAgentOutputState {
  readonly chunks: readonly SessionAgentOutputChunk[];
  /** Characters currently retained in DOM-backed chunks; selection pins may temporarily exceed 30,000. */
  readonly characterCount: number;
  /** Characters accepted from the current stream, including compacted history. */
  readonly receivedCharacterCount: number;
  readonly nextChunkSequence: number;
  readonly streamVersion: number;
  /** Increments only when retention removes or splits an existing chunk. */
  readonly retentionVersion: number;
  readonly truncated: boolean;
}

/** Reader-owned pins that control safe Live output compaction. */
export type SessionAgentOutputRetentionRequest =
  | {
      /** Keeps the full latest window plus selected and visible nodes; temporary overflow is allowed. */
      mode: "selection-pinned";
      pinnedRenderKeys: readonly string[];
    }
  | {
      /** Keeps visible nodes inside the 30,000-character total bound. */
      mode: "viewport-pinned";
      pinnedRenderKeys: readonly string[];
    }
  | {
      /** Keeps only the latest 30,000 characters after following or an explicit jump. */
      mode: "latest-only";
      pinnedRenderKeys?: never;
    };

/** Creates empty append-only output state for a newly mounted agent stream. */
export function createSessionAgentOutputState(): SessionAgentOutputState {
  return {
    chunks: [],
    characterCount: 0,
    receivedCharacterCount: 0,
    nextChunkSequence: 0,
    streamVersion: 0,
    retentionVersion: 0,
    truncated: false,
  };
}

function createKeyedSessionAgentOutputChunks({
  text,
  streamVersion,
  firstChunkSequence,
  firstCharacterOffset,
}: {
  text: string;
  streamVersion: number;
  firstChunkSequence: number;
  firstCharacterOffset: number;
}): readonly SessionAgentOutputChunk[] {
  const chunks: SessionAgentOutputChunk[] = [];
  for (
    let textOffset = 0;
    textOffset < text.length;
    textOffset += SESSION_AGENT_OUTPUT_MAX_CHUNK_CHARACTERS
  ) {
    chunks.push({
      renderKey: `${streamVersion}:${firstChunkSequence + chunks.length}`,
      text: text.slice(
        textOffset,
        textOffset + SESSION_AGENT_OUTPUT_MAX_CHUNK_CHARACTERS
      ),
      startCharacterOffset: firstCharacterOffset + textOffset,
    });
  }
  return chunks;
}

/**
 * Appends every character in one SSE delta as new keyed chunks without changing
 * or removing any existing chunk. Retention runs separately after DOM pins are read.
 */
export function appendSessionAgentOutput({
  currentOutput,
  delta,
}: {
  currentOutput: SessionAgentOutputState;
  delta: string;
}): SessionAgentOutputState {
  if (delta.length === 0) return currentOutput;

  const appendedChunks = createKeyedSessionAgentOutputChunks({
    text: delta,
    streamVersion: currentOutput.streamVersion,
    firstChunkSequence: currentOutput.nextChunkSequence,
    firstCharacterOffset: currentOutput.receivedCharacterCount,
  });

  return {
    ...currentOutput,
    chunks: [...currentOutput.chunks, ...appendedChunks],
    characterCount: currentOutput.characterCount + delta.length,
    receivedCharacterCount: currentOutput.receivedCharacterCount + delta.length,
    nextChunkSequence: currentOutput.nextChunkSequence + appendedChunks.length,
  };
}

function selectBoundedViewportPinnedKeys({
  currentOutput,
  requestedPinnedRenderKeys,
}: {
  currentOutput: SessionAgentOutputState;
  requestedPinnedRenderKeys: readonly string[];
}): ReadonlySet<string> {
  const chunksByRenderKey = new Map(
    currentOutput.chunks.map((chunk) => [chunk.renderKey, chunk] as const)
  );
  const pinnedRenderKeys = new Set<string>();
  let remainingPinCharacters =
    SESSION_AGENT_OUTPUT_LATEST_WINDOW_CHARACTERS -
    SESSION_AGENT_OUTPUT_MAX_CHUNK_CHARACTERS;

  for (const renderKey of requestedPinnedRenderKeys) {
    const chunk = chunksByRenderKey.get(renderKey);
    if (!chunk || pinnedRenderKeys.has(renderKey)) continue;
    if (chunk.text.length > remainingPinCharacters) continue;
    pinnedRenderKeys.add(renderKey);
    remainingPinCharacters -= chunk.text.length;
  }

  return pinnedRenderKeys;
}

function readSessionAgentOutputPinnedKeys({
  currentOutput,
  retentionRequest,
}: {
  currentOutput: SessionAgentOutputState;
  retentionRequest: SessionAgentOutputRetentionRequest;
}): ReadonlySet<string> {
  if (retentionRequest.mode === "latest-only") return new Set();
  if (retentionRequest.mode === "selection-pinned") {
    return new Set(retentionRequest.pinnedRenderKeys);
  }
  return selectBoundedViewportPinnedKeys({
    currentOutput,
    requestedPinnedRenderKeys: retentionRequest.pinnedRenderKeys,
  });
}

function hasSameSessionAgentOutputChunks(
  firstChunks: readonly SessionAgentOutputChunk[],
  secondChunks: readonly SessionAgentOutputChunk[]
): boolean {
  return (
    firstChunks.length === secondChunks.length &&
    firstChunks.every((chunk, index) => chunk === secondChunks[index])
  );
}

/**
 * Compacts old unpinned chunks while retaining the newest text. A split boundary
 * always receives a new render key, so React never rewrites an existing text node.
 */
export function compactSessionAgentOutput({
  currentOutput,
  retentionRequest,
}: {
  currentOutput: SessionAgentOutputState;
  retentionRequest: SessionAgentOutputRetentionRequest;
}): SessionAgentOutputState {
  const pinnedRenderKeys = readSessionAgentOutputPinnedKeys({
    currentOutput,
    retentionRequest,
  });
  const latestWindowStartOffset = Math.max(
    0,
    currentOutput.receivedCharacterCount -
      SESSION_AGENT_OUTPUT_LATEST_WINDOW_CHARACTERS
  );
  const retainedChunksByIndex = new Map<number, SessionAgentOutputChunk>();
  let nextChunkSequence = currentOutput.nextChunkSequence;
  let remainingLatestCharacters = SESSION_AGENT_OUTPUT_LATEST_WINDOW_CHARACTERS;

  if (retentionRequest.mode === "viewport-pinned") {
    currentOutput.chunks.forEach((chunk, chunkIndex) => {
      if (pinnedRenderKeys.has(chunk.renderKey)) {
        retainedChunksByIndex.set(chunkIndex, chunk);
        remainingLatestCharacters -= chunk.text.length;
      }
    });
  }

  for (
    let chunkIndex = currentOutput.chunks.length - 1;
    chunkIndex >= 0;
    chunkIndex -= 1
  ) {
    const chunk = currentOutput.chunks[chunkIndex];
    const chunkEndOffset = chunk.startCharacterOffset + chunk.text.length;
    const isPinned = pinnedRenderKeys.has(chunk.renderKey);

    if (retentionRequest.mode === "selection-pinned" && isPinned) {
      retainedChunksByIndex.set(chunkIndex, chunk);
    }
    if (retentionRequest.mode === "viewport-pinned" && isPinned) continue;
    if (
      chunkEndOffset <= latestWindowStartOffset ||
      remainingLatestCharacters <= 0
    ) {
      continue;
    }

    const availableTextStartOffset = Math.max(
      chunk.startCharacterOffset,
      latestWindowStartOffset,
      chunkEndOffset - remainingLatestCharacters
    );
    const retainedTextOffset =
      availableTextStartOffset - chunk.startCharacterOffset;
    if (retainedTextOffset === 0) {
      retainedChunksByIndex.set(chunkIndex, chunk);
      remainingLatestCharacters -= chunk.text.length;
      continue;
    }

    if (retentionRequest.mode === "selection-pinned" && isPinned) {
      remainingLatestCharacters -= chunkEndOffset - latestWindowStartOffset;
      continue;
    }

    const retainedText = chunk.text.slice(retainedTextOffset);
    retainedChunksByIndex.set(chunkIndex, {
      renderKey: `${currentOutput.streamVersion}:${nextChunkSequence}`,
      text: retainedText,
      startCharacterOffset: availableTextStartOffset,
    });
    nextChunkSequence += 1;
    remainingLatestCharacters -= retainedText.length;
  }

  const retainedChunks = [...retainedChunksByIndex.entries()]
    .sort(([firstIndex], [secondIndex]) => firstIndex - secondIndex)
    .map(([, chunk]) => chunk);

  if (hasSameSessionAgentOutputChunks(currentOutput.chunks, retainedChunks)) {
    return currentOutput;
  }

  return {
    ...currentOutput,
    chunks: retainedChunks,
    characterCount: retainedChunks.reduce(
      (characterCount, chunk) => characterCount + chunk.text.length,
      0
    ),
    nextChunkSequence,
    retentionVersion: currentOutput.retentionVersion + 1,
    truncated: true,
  };
}

/**
 * Starts a new keyed generation for replay, replacement, or agent switching.
 * Replacements intentionally invalidate old Ranges and begin at the latest bound.
 */
export function resetSessionAgentOutput({
  currentOutput,
  replacementText = "",
}: {
  currentOutput: SessionAgentOutputState;
  replacementText?: string;
}): SessionAgentOutputState {
  const streamVersion = currentOutput.streamVersion + 1;
  const chunks = createKeyedSessionAgentOutputChunks({
    text: replacementText,
    streamVersion,
    firstChunkSequence: 0,
    firstCharacterOffset: 0,
  });
  const replacementOutput: SessionAgentOutputState = {
    chunks,
    characterCount: replacementText.length,
    receivedCharacterCount: replacementText.length,
    nextChunkSequence: chunks.length,
    streamVersion,
    retentionVersion: currentOutput.retentionVersion,
    truncated: false,
  };

  return compactSessionAgentOutput({
    currentOutput: replacementOutput,
    retentionRequest: { mode: "latest-only" },
  });
}

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  isSessionLiveScrollNearLatest,
  reduceSessionLiveFollowState,
  type SessionLiveFollowState,
} from "./use-session-live-follow";

describe("session Live follow state", () => {
  test("pauses for a region selection and records the next append as unread", () => {
    let state: SessionLiveFollowState = { mode: "following", hasNewContent: false };

    state = reduceSessionLiveFollowState(state, { type: "selection-created-in-region" });
    assert.deepEqual(state, { mode: "paused", hasNewContent: false });

    state = reduceSessionLiveFollowState(state, { type: "content-appended" });
    assert.deepEqual(state, { mode: "paused", hasNewContent: true });

    state = reduceSessionLiveFollowState(state, { type: "content-appended" });
    assert.deepEqual(state, { mode: "paused", hasNewContent: true });
  });

  test("pauses after leaving the latest edge", () => {
    const state = reduceSessionLiveFollowState(
      { mode: "following", hasNewContent: false },
      { type: "left-latest" }
    );

    assert.deepEqual(state, { mode: "paused", hasNewContent: false });
  });

  test("resumes only at the latest edge, by an explicit jump, or after content reset", () => {
    const paused: SessionLiveFollowState = { mode: "paused", hasNewContent: true };

    assert.deepEqual(reduceSessionLiveFollowState(paused, { type: "reached-latest" }), {
      mode: "following",
      hasNewContent: false,
    });
    assert.deepEqual(reduceSessionLiveFollowState(paused, { type: "jump-to-latest" }), {
      mode: "following",
      hasNewContent: false,
    });
    assert.deepEqual(reduceSessionLiveFollowState(paused, { type: "content-reset" }), {
      mode: "following",
      hasNewContent: false,
    });
  });

  test("treats only the final 48 pixels as near the latest edge", () => {
    assert.equal(
      isSessionLiveScrollNearLatest({ scrollTop: 452, scrollHeight: 600, clientHeight: 100 }),
      true
    );
    assert.equal(
      isSessionLiveScrollNearLatest({ scrollTop: 451, scrollHeight: 600, clientHeight: 100 }),
      false
    );
  });
});

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  getInitialSessionLivePhase,
  hasSessionLiveDiscussionOpened,
  reduceSessionLivePhase,
} from "./session-live-phase";

describe("session Live phase state", () => {
  test("does not invent a current phase for an errored session", () => {
    assert.equal(getInitialSessionLivePhase("error"), null);
    assert.equal(getInitialSessionLivePhase("warp"), null);
    assert.equal(getInitialSessionLivePhase("discussion"), "discussion");
  });

  test("accepts the first valid phase and never regresses during replay", () => {
    assert.equal(
      reduceSessionLivePhase({ currentPhase: null, receivedPhase: "framing" }),
      "framing"
    );
    assert.equal(
      reduceSessionLivePhase({ currentPhase: "discussion", receivedPhase: "divergence" }),
      "discussion"
    );
    assert.equal(
      reduceSessionLivePhase({ currentPhase: "discussion", receivedPhase: "convergence" }),
      "convergence"
    );
    assert.equal(
      reduceSessionLivePhase({ currentPhase: "convergence", receivedPhase: "error" }),
      "convergence"
    );
    assert.equal(
      reduceSessionLivePhase({ currentPhase: "divergence", receivedPhase: "warp" }),
      "divergence"
    );
  });

  test("keeps discussion hidden until discussion or a later phase", () => {
    assert.equal(hasSessionLiveDiscussionOpened(null), false);
    assert.equal(hasSessionLiveDiscussionOpened("framing"), false);
    assert.equal(hasSessionLiveDiscussionOpened("divergence"), false);
    assert.equal(hasSessionLiveDiscussionOpened("discussion"), true);
    assert.equal(hasSessionLiveDiscussionOpened("done"), true);
    assert.equal(
      hasSessionLiveDiscussionOpened(
        reduceSessionLivePhase({ currentPhase: "divergence", receivedPhase: "warp" })
      ),
      false
    );
  });
});

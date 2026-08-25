import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  FakeSessionEventSource,
  installFakeSessionEventSource,
} from "@/test-support/fake-session-event-source";

import {
  api,
  ApiRequestError,
  formatApiValidationIssue,
  parsePydanticValidationIssues,
  parseSessionStreamEvent,
  subscribeSession,
  type Idea,
  type SessionStreamConnectionState,
  type StreamEvent,
} from "./api";

/** Frozen-contract idea used to prove later valid events still parse after skips. */
const SESSION_STREAM_RESILIENCE_IDEA: Idea = {
  id: "idea-resilience-1",
  session_id: "session-resilience",
  persona_type: "INTJ",
  phase: "divergence",
  content: "A later valid idea",
  cluster_id: null,
  synthesized: null,
  scores: null,
  decision: "pending",
  note: "",
};

describe("API request error parsing", () => {
  test("safely parses and formats Pydantic detail arrays", () => {
    const issues = parsePydanticValidationIssues([
      {
        type: "string_too_long",
        loc: ["body", "theme"],
        msg: "String should have at most 2000 characters",
        input: { deliberately: "not stringified" },
      },
      {
        type: "value_error",
        loc: ["body", "agents", 0, "provider"],
        msg: "Provider is unavailable",
      },
      { loc: { malformed: true }, msg: "Location is malformed" },
      { loc: ["body", "constraints"], msg: { malformed: true } },
      null,
    ]);

    assert.deepEqual(issues, [
      {
        location: ["body", "theme"],
        message: "String should have at most 2000 characters",
        type: "string_too_long",
      },
      {
        location: ["body", "agents", 0, "provider"],
        message: "Provider is unavailable",
        type: "value_error",
      },
      {
        location: [],
        message: "Location is malformed",
        type: null,
      },
    ]);
    assert.deepEqual(issues.map(formatApiValidationIssue), [
      "theme: String should have at most 2000 characters",
      "agents.0.provider: Provider is unavailable",
      "Location is malformed",
    ]);
    assert.ok(issues.every((issue) => !formatApiValidationIssue(issue).includes("[object Object]")));
  });

  test("throws a structured ApiRequestError for a 422 response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          detail: [
            {
              type: "string_too_long",
              loc: ["body", "theme"],
              msg: "Theme is too long",
            },
            {
              type: "value_error",
              loc: ["body", "agents"],
              msg: "Choose an agent",
            },
          ],
        }),
        { status: 422, statusText: "Unprocessable Entity" }
      )) as typeof fetch;

    try {
      await assert.rejects(api.providers(), (error: unknown) => {
        assert.ok(error instanceof ApiRequestError);
        assert.equal(error.name, "ApiRequestError");
        assert.equal(error.status, 422);
        assert.equal(error.validationIssues.length, 2);
        assert.equal(error.message, "theme: Theme is too long; agents: Choose an agent");
        assert.doesNotMatch(error.message, /\[object Object\]/);
        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses safe text and status fallbacks for non-array details", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: unknown[] = [
      { detail: "Readable backend error" },
      { detail: { unsafe: "object" } },
    ];
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(bodies.shift()), {
        status: 500,
        statusText: "Server Error",
      })) as typeof fetch;

    try {
      await assert.rejects(api.providers(), {
        name: "ApiRequestError",
        message: "Readable backend error",
      });
      await assert.rejects(api.providers(), (error: unknown) => {
        assert.ok(error instanceof ApiRequestError);
        assert.equal(error.message, "500 Server Error");
        assert.doesNotMatch(error.message, /\[object Object\]/);
        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("session stream payload parser", () => {
  test("accepts the frozen payload fields and rejects malformed events", () => {
    assert.deepEqual(
      parseSessionStreamEvent(
        JSON.stringify({ type: "message", round: 2, from: "Persona A", content: "Hello" })
      ),
      { type: "message", round: 2, from: "Persona A", content: "Hello" }
    );
    assert.equal(parseSessionStreamEvent("not json"), null);
    assert.equal(parseSessionStreamEvent("{invalid json"), null);
    assert.equal(parseSessionStreamEvent("null"), null);
    assert.equal(parseSessionStreamEvent(JSON.stringify({ type: "token", agent: "INTJ" })), null);
    assert.equal(parseSessionStreamEvent(JSON.stringify({ type: "idea" })), null);
    assert.equal(parseSessionStreamEvent(JSON.stringify({ type: "future_event" })), null);
    assert.deepEqual(parseSessionStreamEvent(JSON.stringify({ type: "phase", phase: "warp" })), {
      type: "phase",
      phase: "warp",
    });
  });
});

describe("session stream connection state", () => {
  test("retries once with a replay reset, then reports a terminal disconnect", () => {
    const restoreEventSource = installFakeSessionEventSource();
    try {
      const states: SessionStreamConnectionState[] = [];
      const events: StreamEvent[] = [];
      const errors: string[] = [];
      let resetCount = 0;
      const unsubscribe = subscribeSession("session-1", {
        onEvent: (event) => events.push(event),
        onReset: () => {
          resetCount += 1;
        },
        onConnectionStateChange: (state) => states.push(state),
        onError: (message) => errors.push(message),
      });

      const firstSource = FakeSessionEventSource.instances[0];
      assert.ok(firstSource);
      assert.equal(firstSource.url, "/api/sessions/session-1/stream");
      firstSource.emitOpen();
      firstSource.emitMessage(
        JSON.stringify({ type: "token", agent: "INTJ", round: 1, delta: "one" })
      );
      firstSource.emitError();

      const secondSource = FakeSessionEventSource.instances[1];
      assert.ok(secondSource);
      assert.equal(resetCount, 1);
      assert.equal(firstSource.closeCount, 1);
      secondSource.emitOpen();
      secondSource.emitMessage("null");
      secondSource.emitError();

      assert.deepEqual(states, [
        "connecting",
        "connected",
        "reconnecting",
        "connected",
        "disconnected",
      ]);
      assert.deepEqual(events, [
        { type: "token", agent: "INTJ", round: 1, delta: "one" },
      ]);
      assert.deepEqual(errors, ["Lost the connection to the session stream."]);
      assert.equal(secondSource.closeCount, 1);
      unsubscribe();
    } finally {
      restoreEventSource();
    }
  });

  test("waits for server close after done and ignores queued work after cleanup", () => {
    const restoreEventSource = installFakeSessionEventSource();
    try {
      const states: SessionStreamConnectionState[] = [];
      const events: StreamEvent[] = [];
      let resetCount = 0;
      const unsubscribe = subscribeSession("session-2", {
        onEvent: (event) => events.push(event),
        onReset: () => {
          resetCount += 1;
        },
        onConnectionStateChange: (state) => states.push(state),
      });

      const source = FakeSessionEventSource.instances[0];
      assert.ok(source);
      source.emitOpen();
      source.emitMessage(JSON.stringify({ type: "phase", phase: "done", label: "Done" }));
      source.emitError();

      assert.deepEqual(states, ["connecting", "connected", "complete"]);
      assert.deepEqual(events, [{ type: "phase", phase: "done", label: "Done" }]);
      assert.equal(resetCount, 0);
      assert.equal(source.closeCount, 1);

      unsubscribe();
      unsubscribe();
      assert.equal(source.closeCount, 1);
    } finally {
      restoreEventSource();
    }
  });

  test("detaches handlers and makes unsubscribe idempotent", () => {
    const restoreEventSource = installFakeSessionEventSource();
    try {
      const events: StreamEvent[] = [];
      const unsubscribe = subscribeSession("session-3", {
        onEvent: (event) => events.push(event),
        onReset: () => undefined,
      });
      const source = FakeSessionEventSource.instances[0];
      assert.ok(source);
      const queuedMessageHandler = source.onmessage;

      unsubscribe();
      unsubscribe();
      queuedMessageHandler?.({
        data: JSON.stringify({ type: "error", message: "late" }),
      } as MessageEvent<string>);

      assert.equal(source.closeCount, 1);
      assert.equal(source.onopen, null);
      assert.equal(source.onmessage, null);
      assert.equal(source.onerror, null);
      assert.deepEqual(events, []);
    } finally {
      restoreEventSource();
    }
  });
});

describe("session stream malformed event resilience", () => {
  test("skips mid-stream invalid JSON, unknown types, and missing fields on the same connection", () => {
    const restoreEventSource = installFakeSessionEventSource();
    try {
      const states: SessionStreamConnectionState[] = [];
      const events: StreamEvent[] = [];
      const errors: string[] = [];
      let resetCount = 0;
      const unsubscribe = subscribeSession("session-resilience", {
        onEvent: (event) => events.push(event),
        onReset: () => {
          resetCount += 1;
        },
        onConnectionStateChange: (state) => states.push(state),
        onError: (message) => errors.push(message),
      });

      const source = FakeSessionEventSource.instances[0];
      assert.ok(source);
      source.emitOpen();
      source.emitMessage(
        JSON.stringify({ type: "token", agent: "INTJ", round: 1, delta: "alpha" })
      );
      source.emitMessage("{invalid json");
      source.emitMessage("data: {invalid json");
      source.emitMessage(JSON.stringify({ type: "future_event" }));
      source.emitMessage(JSON.stringify({ type: "idea" }));
      source.emitMessage(JSON.stringify({ type: "token", agent: "INTJ" }));
      source.emitMessage(JSON.stringify({ type: "agent_start" }));
      source.emitMessage(JSON.stringify({ type: "phase", phase: "warp" }));
      source.emitMessage(
        JSON.stringify({ type: "token", agent: "INTJ", round: 1, delta: "beta" })
      );
      source.emitMessage(
        JSON.stringify({ type: "idea", idea: SESSION_STREAM_RESILIENCE_IDEA })
      );
      source.emitMessage(JSON.stringify({ type: "phase", phase: "discussion" }));

      assert.equal(FakeSessionEventSource.instances.length, 1);
      assert.equal(source.closeCount, 0);
      assert.equal(resetCount, 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(states, ["connecting", "connected"]);
      assert.deepEqual(events, [
        { type: "token", agent: "INTJ", round: 1, delta: "alpha" },
        { type: "phase", phase: "warp" },
        { type: "token", agent: "INTJ", round: 1, delta: "beta" },
        { type: "idea", idea: SESSION_STREAM_RESILIENCE_IDEA },
        { type: "phase", phase: "discussion" },
      ]);
      unsubscribe();
    } finally {
      restoreEventSource();
    }
  });

  test("does not treat a non-canonical warp phase as a terminal stream close", () => {
    const restoreEventSource = installFakeSessionEventSource();
    try {
      const states: SessionStreamConnectionState[] = [];
      const events: StreamEvent[] = [];
      let resetCount = 0;
      const unsubscribe = subscribeSession("session-warp", {
        onEvent: (event) => events.push(event),
        onReset: () => {
          resetCount += 1;
        },
        onConnectionStateChange: (state) => states.push(state),
      });

      const firstSource = FakeSessionEventSource.instances[0];
      assert.ok(firstSource);
      firstSource.emitOpen();
      firstSource.emitMessage(JSON.stringify({ type: "phase", phase: "warp" }));
      firstSource.emitError();

      const secondSource = FakeSessionEventSource.instances[1];
      assert.ok(secondSource);
      secondSource.emitOpen();

      assert.deepEqual(events, [{ type: "phase", phase: "warp" }]);
      assert.equal(resetCount, 1);
      assert.deepEqual(states, ["connecting", "connected", "reconnecting", "connected"]);
      assert.equal(firstSource.closeCount, 1);
      assert.equal(secondSource.closeCount, 0);
      unsubscribe();
    } finally {
      restoreEventSource();
    }
  });
});

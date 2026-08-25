import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { api, ApiRequestError } from "./api";
import {
  classifySessionRequestFailure,
  isSessionNotFoundRequestError,
} from "./session-not-found-request-error";

describe("session not found request error", () => {
  test("treats an ApiRequestError 404 as a missing session", () => {
    assert.equal(
      isSessionNotFoundRequestError(new ApiRequestError(404, "404 Not Found")),
      true
    );
    assert.deepEqual(
      classifySessionRequestFailure(new ApiRequestError(404, "404 Not Found"), "fallback"),
      { kind: "not-found" }
    );
  });

  test("treats a parsed session-not-found detail as a missing session", () => {
    assert.equal(
      isSessionNotFoundRequestError(new ApiRequestError(500, "Session not found in store")),
      true
    );
    assert.equal(isSessionNotFoundRequestError(new Error("session not found")), true);
  });

  test("leaves other request failures on the generic error path", () => {
    const unavailable = new ApiRequestError(503, "Session request failed");
    assert.equal(isSessionNotFoundRequestError(unavailable), false);
    assert.deepEqual(classifySessionRequestFailure(unavailable, "fallback"), {
      kind: "error",
      message: "Session request failed",
    });
    assert.deepEqual(classifySessionRequestFailure(new TypeError("Failed to fetch"), "fallback"), {
      kind: "error",
      message: "Failed to fetch",
    });
    assert.deepEqual(classifySessionRequestFailure("not-an-error", "Failed to load session"), {
      kind: "error",
      message: "Failed to load session",
    });
  });

  test("reuses getSession detail parsing for a 404 session not found body", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "session not found" }), {
        status: 404,
        statusText: "Not Found",
      })) as typeof fetch;

    try {
      await assert.rejects(api.getSession("session-missing"), (error: unknown) => {
        assert.ok(error instanceof ApiRequestError);
        assert.equal(error.status, 404);
        assert.equal(error.message, "session not found");
        assert.equal(isSessionNotFoundRequestError(error), true);
        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

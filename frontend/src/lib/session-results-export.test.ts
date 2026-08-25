import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  getSessionResultsExportFailureMessage,
  getSessionResultsExportFallbackFilename,
  getSessionResultsExportHttpErrorMessage,
  isSessionResultsExportHtmlContentType,
  parseSessionResultsExportFilename,
  SessionResultsExportError,
  SESSION_RESULTS_EXPORT_UNAVAILABLE_MESSAGE,
} from "./session-results-export";

describe("Session Results export filename", () => {
  test("falls back to izayoi-{id}.{format} when the header is missing", () => {
    assert.equal(
      getSessionResultsExportFallbackFilename("session-1", "md"),
      "izayoi-session-1.md"
    );
    assert.equal(
      parseSessionResultsExportFilename(null, "session-1", "json"),
      "izayoi-session-1.json"
    );
  });

  test("reads quoted Content-Disposition filenames and rejects path segments", () => {
    assert.equal(
      parseSessionResultsExportFilename(
        'attachment; filename="izayoi-session-1.md"',
        "session-1",
        "md"
      ),
      "izayoi-session-1.md"
    );
    assert.equal(
      parseSessionResultsExportFilename(
        "attachment; filename=../secret.json",
        "session-1",
        "json"
      ),
      "secret.json"
    );
  });
});

describe("Session Results export error copy", () => {
  test("treats HTML content types as error pages", () => {
    assert.equal(isSessionResultsExportHtmlContentType("text/html"), true);
    assert.equal(
      isSessionResultsExportHtmlContentType("text/html; charset=utf-8"),
      true
    );
    assert.equal(isSessionResultsExportHtmlContentType("TEXT/HTML"), true);
    assert.equal(isSessionResultsExportHtmlContentType("application/json"), false);
    assert.equal(isSessionResultsExportHtmlContentType(null), false);
  });

  test("uses string detail only and maps object detail to HTTP status", () => {
    assert.equal(
      getSessionResultsExportHttpErrorMessage(500, "Session export unavailable"),
      "Session export unavailable"
    );
    assert.equal(
      getSessionResultsExportHttpErrorMessage(500, { msg: "hidden" }),
      "HTTP 500"
    );
    assert.equal(getSessionResultsExportHttpErrorMessage(502, null), "HTTP 502");
    assert.doesNotMatch(
      getSessionResultsExportHttpErrorMessage(500, { detail: "nope" }),
      /\[object Object\]/
    );
  });

  test("keeps the generic unavailable sentence for unknown failures", () => {
    assert.equal(
      getSessionResultsExportFailureMessage(new TypeError("Failed to fetch")),
      SESSION_RESULTS_EXPORT_UNAVAILABLE_MESSAGE
    );
    assert.equal(
      getSessionResultsExportFailureMessage(
        new SessionResultsExportError("HTTP 500")
      ),
      "HTTP 500"
    );
    assert.match(
      SESSION_RESULTS_EXPORT_UNAVAILABLE_MESSAGE,
      /Could not export results\. Start the local izayoi backend, then retry\./
    );
  });
});

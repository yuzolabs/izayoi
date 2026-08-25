import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  getResultsIdeaMemoFieldElementId,
  mapResultsIdeaMemoApiValidationIssues,
  normalizeResultsIdeaMemo,
  RESULTS_IDEA_MEMO_TOO_LONG_ERROR,
  validateResultsIdeaMemo,
} from "./results-idea-memo-field-validation";
import { SESSION_TEXT_FIELD_MAX_LENGTH } from "./session-text-field-max-length";

describe("Results idea memo field validation", () => {
  test("shares the 2,000-character limit and is trim-aware", () => {
    assert.equal(SESSION_TEXT_FIELD_MAX_LENGTH, 2_000);
    assert.equal(validateResultsIdeaMemo("m".repeat(2_000)), null);
    assert.equal(
      validateResultsIdeaMemo("m".repeat(2_001)),
      RESULTS_IDEA_MEMO_TOO_LONG_ERROR
    );
    assert.equal(validateResultsIdeaMemo("   \u3000  "), null);
    assert.equal(normalizeResultsIdeaMemo("   \u3000  "), "");
    assert.equal(normalizeResultsIdeaMemo("\u3000月の案\u3000"), "月の案");
    assert.equal(
      getResultsIdeaMemoFieldElementId("idea-1", "error"),
      "results-idea-memo-error-idea-1"
    );
  });

  test("maps 422 note locations to the memo field and keeps a general fallback", () => {
    assert.deepEqual(
      mapResultsIdeaMemoApiValidationIssues([
        {
          location: ["body", "note"],
          message: "Server rejected the memo.",
          type: "value_error",
        },
        {
          location: ["body", "decision"],
          message: "Invalid decision.",
          type: "value_error",
        },
      ]),
      {
        note: "Server rejected the memo.",
        general: "decision: Invalid decision.",
      }
    );

    const generalOnly = mapResultsIdeaMemoApiValidationIssues([
      {
        location: ["body", "decision"],
        message: "Invalid decision.",
        type: "value_error",
      },
    ]);
    assert.equal(generalOnly.note, null);
    assert.equal(generalOnly.general, "decision: Invalid decision.");
    assert.doesNotMatch(generalOnly.general ?? "", /\[object Object\]/);

    const noteOnly = mapResultsIdeaMemoApiValidationIssues([
      {
        location: ["note"],
        message: "Memo is too long.",
        type: "string_too_long",
      },
      {
        location: ["body", "note"],
        message: "Memo must stay plain text.",
        type: "value_error",
      },
    ]);
    assert.equal(
      noteOnly.note,
      "Memo is too long. Memo must stay plain text."
    );
    assert.equal(noteOnly.general, null);
  });
});

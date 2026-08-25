import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { Session, SessionMetrics, SessionStatus } from "@/lib/api";

import {
  deriveSessionHistoryCardPresentation,
  formatSessionHistoryCreatedAt,
  formatSessionHistoryMetrics,
  getSessionHistoryStatusPresentation,
  sortSessionHistoryNewestFirst,
} from "./session-history-presentation";

const BASE_HISTORY_SESSION: Session = {
  id: "session-1",
  theme: "Choose a reversible pilot",
  constraints: "Use the existing budget",
  status: "framing",
  phase_progress: "framing",
  agents: [],
  created_at: "2025-01-02T03:04:00Z",
  metrics: null,
};

function makeHistorySession(
  id: string,
  createdAt: string,
  status: SessionStatus = "framing"
): Session {
  return {
    ...BASE_HISTORY_SESSION,
    id,
    created_at: createdAt,
    status,
  };
}

describe("session History status and action presentation", () => {
  test("maps all six statuses to an icon, plain-English label, and next action", () => {
    const expectedMatrix: Array<
      [
        SessionStatus,
        string,
        "Open live" | "Review decisions" | "Inspect failure",
        string,
      ]
    > = [
      ["framing", "Framing", "Open live", "/session/session-1"],
      ["divergence", "Divergence", "Open live", "/session/session-1"],
      ["discussion", "Discussion", "Open live", "/session/session-1"],
      ["convergence", "Convergence", "Open live", "/session/session-1"],
      ["done", "Done", "Review decisions", "/session/session-1/results"],
      ["error", "Error", "Inspect failure", "/session/session-1/results"],
    ];

    for (const [status, label, actionLabel, actionPath] of expectedMatrix) {
      const presentation = getSessionHistoryStatusPresentation(status, "session-1");
      assert.equal(presentation.status, status);
      assert.equal(presentation.iconName, status);
      assert.equal(presentation.label, label);
      assert.equal(presentation.actionLabel, actionLabel);
      assert.equal(presentation.actionPath, actionPath);
    }
  });

  test("keeps a route-safe session ID in terminal actions", () => {
    assert.equal(
      getSessionHistoryStatusPresentation("error", "council/one").actionPath,
      "/session/council%2Fone/results"
    );
  });
});

describe("session History timestamp and metrics presentation", () => {
  test("formats English timestamps in explicit UTC and provides a machine value", () => {
    assert.deepEqual(formatSessionHistoryCreatedAt("2025-01-02T03:04:00-05:00"), {
      label: "Jan 02, 2025 at 08:04 UTC",
      dateTime: "2025-01-02T08:04:00.000Z",
    });
  });

  test("treats a timezone-less API timestamp as UTC instead of browser-local time", () => {
    assert.deepEqual(formatSessionHistoryCreatedAt("2025-01-02T03:04:00"), {
      label: "Jan 02, 2025 at 03:04 UTC",
      dateTime: "2025-01-02T03:04:00.000Z",
    });
  });

  test("accepts a leap day and the backend fractional-offset ISO format", () => {
    assert.deepEqual(
      formatSessionHistoryCreatedAt("2024-02-29T23:59:59.123456+00:00"),
      {
        label: "Feb 29, 2024 at 23:59 UTC",
        dateTime: "2024-02-29T23:59:59.123Z",
      }
    );
    assert.equal(
      formatSessionHistoryCreatedAt("2000-02-29T00:00:00Z").dateTime,
      "2000-02-29T00:00:00.000Z"
    );
  });

  test("keeps the existing millisecond display for arbitrary fractional precision", () => {
    assert.equal(
      formatSessionHistoryCreatedAt(
        "2025-01-02T03:04:05.123999999999999999Z"
      ).dateTime,
      "2025-01-02T03:04:05.123Z"
    );
    assert.equal(
      formatSessionHistoryCreatedAt("2025-01-02T03:04:05.9Z").dateTime,
      "2025-01-02T03:04:05.900Z"
    );
  });

  test("rejects malformed or out-of-range ISO fields before Date can normalize them", () => {
    const invalidTimestamps = [
      "not-a-timestamp",
      "2025-02-29T00:00:00Z",
      "1900-02-29T00:00:00Z",
      "2025-04-31T00:00:00Z",
      "2025-13-01T00:00:00Z",
      "2025-00-01T00:00:00Z",
      "2025-01-00T00:00:00Z",
      "2025-01-01T24:00:00Z",
      "2025-01-01T00:60:00Z",
      "2025-01-01T00:00:60Z",
      "2025-01-01T00:00:00+24:00",
      "2025-01-01T00:00:00-01:60",
    ];

    for (const timestamp of invalidTimestamps) {
      assert.deepEqual(
        formatSessionHistoryCreatedAt(timestamp),
        { label: "Date unavailable", dateTime: null },
        timestamp
      );
    }
  });

  test("distinguishes missing metrics from valid zero metrics", () => {
    assert.equal(formatSessionHistoryMetrics(null), "Metrics unavailable");
    assert.equal(
      formatSessionHistoryMetrics({
        total_ideas: 0,
        unique_ideas: 0,
        non_duplicate_ratio: 0,
        semantic_dispersion: 0,
        collapse_alert: false,
      }),
      "0 ideas · NDR 0.00 · dispersion 0.00"
    );
  });

  test("labels missing fields in a partial runtime metrics payload without throwing", () => {
    const partialMetrics = {
      total_ideas: 1,
      semantic_dispersion: Number.NaN,
    } as unknown as SessionMetrics;

    assert.equal(
      formatSessionHistoryMetrics(partialMetrics),
      "1 idea · NDR unavailable · dispersion unavailable"
    );
  });
});

describe("session History card derivation and latest-first ordering", () => {
  test("preserves long theme and constraints while safely deriving absent row fields", () => {
    const longTheme = `Theme ${"without-spaces".repeat(80)}`;
    const longConstraints = `Constraint ${"x".repeat(1_000)}`;
    const partialSession = {
      ...BASE_HISTORY_SESSION,
      theme: `  ${longTheme}  `,
      constraints: `  ${longConstraints}  `,
      agents: undefined,
      created_at: "invalid",
      metrics: undefined,
    } as unknown as Session;

    assert.deepEqual(deriveSessionHistoryCardPresentation(partialSession), {
      sessionId: "session-1",
      theme: longTheme,
      constraints: longConstraints,
      status: getSessionHistoryStatusPresentation("framing", "session-1"),
      createdAt: { label: "Date unavailable", dateTime: null },
      personaCountLabel: "0 personas",
      metricsLabel: "Metrics unavailable",
    });
  });

  test("sorts newest first, ties identical instants by ID, and keeps invalid dates last", () => {
    const sessions = [
      makeHistorySession("invalid-z", "invalid"),
      makeHistorySession("tie-b", "2025-03-01T10:00:00Z"),
      makeHistorySession("old", "2024-12-31T23:59:59Z"),
      makeHistorySession("tie-a", "2025-03-01T10:00:00Z"),
      makeHistorySession("newest", "2026-01-01T00:00:00Z"),
      makeHistorySession("invalid-calendar", "2025-02-29T00:00:00Z"),
      makeHistorySession("invalid-a", "also-invalid"),
    ];
    const originalOrder = sessions.map(({ id }) => id);

    assert.deepEqual(
      sortSessionHistoryNewestFirst(sessions).map(({ id }) => id),
      [
        "newest",
        "tie-a",
        "tie-b",
        "old",
        "invalid-z",
        "invalid-calendar",
        "invalid-a",
      ]
    );
    assert.deepEqual(
      sessions.map(({ id }) => id),
      originalOrder
    );
  });

  test("uses every fractional digit instead of tying backend microseconds at Date precision", () => {
    const sessions = [
      makeHistorySession(
        "a-backend-older",
        "2025-03-01T10:00:00.123456Z"
      ),
      makeHistorySession(
        "z-backend-newer",
        "2025-03-01T10:00:00.123999Z"
      ),
      makeHistorySession(
        "y-beyond-six-digits",
        "2025-03-01T10:00:00.123456000000000001Z"
      ),
      makeHistorySession("z-one-digit-newest", "2025-03-01T10:00:00.9Z"),
    ];

    assert.deepEqual(
      sortSessionHistoryNewestFirst(sessions).map(({ id }) => id),
      [
        "z-one-digit-newest",
        "z-backend-newer",
        "y-beyond-six-digits",
        "a-backend-older",
      ]
    );
  });

  test("normalizes Z, zero offset, and different offsets before ID tie-breaking", () => {
    const sessions = [
      makeHistorySession(
        "same-z",
        "2025-01-01T00:00:00.100000Z"
      ),
      makeHistorySession(
        "same-west",
        "2024-12-31T16:00:00.100000000-08:00"
      ),
      makeHistorySession(
        "same-plus-zero",
        "2025-01-01T00:00:00.1+00:00"
      ),
      makeHistorySession(
        "same-east",
        "2025-01-01T05:30:00.100+05:30"
      ),
    ];

    assert.deepEqual(
      sortSessionHistoryNewestFirst(sessions).map(({ id }) => id),
      ["same-east", "same-plus-zero", "same-west", "same-z"]
    );
  });

  test("orders arbitrary fractions correctly across the negative pre-epoch boundary", () => {
    const sessions = [
      makeHistorySession(
        "pre-epoch-nearest",
        "1969-12-31T23:59:59.999999999999999999Z"
      ),
      makeHistorySession("epoch", "1970-01-01T00:00:00Z"),
      makeHistorySession("pre-epoch-older", "1969-12-31T23:59:59.1Z"),
      makeHistorySession(
        "post-epoch-fraction",
        "1970-01-01T00:00:00.000000000000000001Z"
      ),
    ];

    assert.deepEqual(
      sortSessionHistoryNewestFirst(sessions).map(({ id }) => id),
      [
        "post-epoch-fraction",
        "epoch",
        "pre-epoch-nearest",
        "pre-epoch-older",
      ]
    );
  });
});

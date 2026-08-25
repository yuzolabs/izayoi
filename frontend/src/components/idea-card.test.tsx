import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Idea } from "@/lib/api";

import { IdeaCard } from "./idea-card";

const IDEA_WITH_SCORES: Idea = {
  id: "idea-1",
  session_id: "session-1",
  persona_type: "ARCHITECT",
  phase: "divergence",
  content: "Create a reversible neighborhood pilot.",
  cluster_id: 3,
  synthesized: null,
  scores: { novelty: 8, feasibility: 6, clarity: 7, total: 21 },
  decision: "held",
  note: "Check permitting first.",
};

describe("Results idea card keyboard interaction semantics", () => {
  test("uses native buttons for every decision and exposes the current pressed state", () => {
    const markup = renderToStaticMarkup(
      <IdeaCard
        idea={IDEA_WITH_SCORES}
        scoreAdvisoryId="score-advisory"
        onSave={() => undefined}
        onRetry={() => undefined}
      />
    );

    assert.equal((markup.match(/aria-pressed=/g) ?? []).length, 4);
    assert.equal((markup.match(/aria-pressed="true"/g) ?? []).length, 1);
    assert.match(markup, />Adopt<\/button>/);
    assert.match(markup, />Hold<\/button>/);
    assert.match(markup, />Reject<\/button>/);
    assert.match(markup, />Pending<\/button>/);
    assert.match(markup, /type="button"/);
    assert.match(markup, /Current decision: Held/);
    assert.match(markup, /aria-describedby="score-advisory"/);
  });

  test("keeps an API failure visible and provides a keyboard-native retry action", () => {
    const markup = renderToStaticMarkup(
      <IdeaCard
        idea={IDEA_WITH_SCORES}
        scoreAdvisoryId="score-advisory"
        saveState={{
          status: "error",
          attempt: { decision: "adopted", note: "Run a small pilot." },
          message: "Service unavailable",
        }}
        onSave={() => undefined}
        onRetry={() => undefined}
      />
    );

    assert.match(markup, /Save failed: Service unavailable/);
    assert.match(markup, />Retry failed save<\/button>/);
    assert.match(markup, /aria-invalid="true"/);
    assert.match(markup, />Run a small pilot\.<\/textarea>/);
  });
});

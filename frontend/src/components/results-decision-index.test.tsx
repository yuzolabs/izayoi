import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import type { ResultsDecisionCounts } from "@/lib/session-results-decision-state";

import { ResultsDecisionIndex } from "./results-decision-index";

const COUNTS: ResultsDecisionCounts = {
  all: 18,
  pending: 11,
  adopted: 4,
  held: 2,
  rejected: 1,
};

function renderIndex(overrides?: Partial<Parameters<typeof ResultsDecisionIndex>[0]>) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ResultsDecisionIndex
        liveHref="/session/s1"
        theme="Reduce single-use packaging in neighborhood shops"
        constraints="Budget under ¥300,000"
        status={{ kind: "done" }}
        counts={COUNTS}
        activeFilter="pending"
        onSelectFilter={() => undefined}
        onExportSessionResults={() => undefined}
        advisoryId="results-llm-score-advisory"
        {...overrides}
      />
    </MemoryRouter>
  );
}

describe("Results decision index", () => {
  test("counts act as filter controls with a single pressed state", () => {
    const markup = renderIndex();

    assert.equal((markup.match(/aria-pressed=/g) ?? []).length, 5);
    assert.equal((markup.match(/aria-pressed="true"/g) ?? []).length, 1);
    assert.match(markup, /aria-pressed="true"[^>]*>\s*<span[^>]*>\s*<span[^>]*><\/span>\s*<span[^>]*>Pending<\/span>/);
    assert.match(markup, /Filter ideas by decision/);
  });

  test("progress readout shows decided share, pending remainder, and harvest state", () => {
    const decidedMarkup = renderIndex();
    assert.match(decidedMarkup, /7 \/ 18 decided/);
    assert.match(decidedMarkup, /11 pending review/);

    const harvestedMarkup = renderIndex({
      counts: { all: 3, pending: 0, adopted: 2, held: 1, rejected: 0 },
      activeFilter: "all",
    });
    assert.match(harvestedMarkup, /3 \/ 3 decided/);
    assert.match(harvestedMarkup, /Every idea has a decision/);
  });

  test("exposes one visible score advisory outside the closed details fold", () => {
    const markup = renderIndex();

    // Exactly one id="results-llm-score-advisory" in the whole index — no
    // duplicate target left inside the details fold.
    assert.equal((markup.match(/id="results-llm-score-advisory"/g) ?? []).length, 1);
    assert.match(markup, /LLM scores are advisory — you make the final call\./);

    // The advisory renders before (outside) the details element, which is
    // closed by default in static markup, so aria-describedby on score
    // badges resolves to a rendered node on mobile.
    const advisoryIndex = markup.indexOf("results-llm-score-advisory");
    const detailsIndex = markup.indexOf("<details");
    assert.ok(advisoryIndex > -1, "advisory id exists");
    assert.ok(detailsIndex > advisoryIndex, "advisory precedes the details fold");
    assert.ok(!/^<details[^>]*\sopen/m.test(markup), "details starts closed");

    // The long explanation stays inside the fold, without the advisory id.
    assert.match(markup, /Judge scores agree with human ranking/);
    const detailsBody = markup.slice(detailsIndex);
    assert.ok(!detailsBody.includes("results-llm-score-advisory"));
  });

  test("offers exports from the review details fold", () => {
    const markup = renderIndex();
    const exportGroupStart = markup.indexOf('aria-label="Export results"');
    assert.ok(exportGroupStart > -1, "export group exists");
    const exportGroupMarkup = markup.slice(exportGroupStart);

    assert.equal(
      (exportGroupMarkup.match(/type="button"/g) ?? []).length,
      2
    );
    assert.match(exportGroupMarkup, />\s*Markdown<\/button>/);
    assert.match(exportGroupMarkup, />\s*JSON<\/button>/);
    assert.doesNotMatch(exportGroupMarkup, /href="\/api\/sessions\//);
    assert.doesNotMatch(exportGroupMarkup, /\sdownload[=\s>]/);
  });

  test("status chip distinguishes running, completed, and failed sessions", () => {
    assert.match(renderIndex({ status: { kind: "running" } }), /Still running/);
    assert.match(renderIndex(), /Completed/);
    assert.match(
      renderIndex({ status: { kind: "failed", empty: false } }),
      /Failed — partial results/
    );
    assert.match(renderIndex({ status: { kind: "failed", empty: true } }), /Failed</);
  });
});

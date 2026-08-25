import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { SessionResultsFailureAlert } from "./session-results-failure-alert";

function renderFailureAlert(empty: boolean, reason: string): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SessionResultsFailureAlert
        sessionId="session-1"
        reason={reason}
        empty={empty}
      />
    </MemoryRouter>
  );
}

describe("Results terminal session failure alert", () => {
  test("makes an empty failure primary and offers both recovery paths", () => {
    const markup = renderFailureAlert(true, "Provider authentication failed");

    assert.match(markup, /role="alert"/);
    assert.match(markup, /aria-live="assertive"/);
    assert.match(markup, /Session failed before any ideas were saved/);
    assert.match(
      markup,
      /<div class="mb-1 font-medium leading-none tracking-tight">Session failed before any ideas were saved<\/div>/
    );
    assert.doesNotMatch(markup, /<h[1-6][^>]*>Session failed before any ideas were saved/);
    assert.match(markup, /Reason:<\/span> Provider authentication failed/);
    assert.match(markup, /href="\/session\/session-1"/);
    assert.match(markup, />Return to Live<\/a>/);
    assert.match(markup, /href="\/"/);
    assert.match(markup, />Start a new session<\/a>/);
    assert.doesNotMatch(markup, /No ideas are available yet/);
  });

  test("keeps a partial failure visible while directing users to the workspace", () => {
    const markup = renderFailureAlert(false, "Convergence provider timed out");

    assert.match(markup, /role="alert"/);
    assert.match(markup, /Session failed — partial results preserved/);
    assert.match(markup, /Ideas saved before the failure remain available below/);
    assert.match(markup, /continue reviewing them and recording decisions/);
  });

  test("renders a supplied reason as text rather than executable HTML", () => {
    const markup = renderFailureAlert(false, '<img src=x onerror="alert(1)">');

    assert.doesNotMatch(markup, /<img/);
    assert.match(markup, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  });
});

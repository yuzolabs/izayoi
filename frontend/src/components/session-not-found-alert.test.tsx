import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { SessionNotFoundState } from "./session-not-found-alert";

function renderSessionNotFoundState(heading: string): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SessionNotFoundState heading={heading} />
    </MemoryRouter>
  );
}

describe("Session not found alert", () => {
  test("keeps Session not found out of the heading outline and offers recovery links", () => {
    const markup = renderSessionNotFoundState("Session");

    assert.match(markup, /<h1[^>]*>Session<\/h1>/);
    assert.match(markup, /role="alert"/);
    assert.match(markup, /aria-live="assertive"/);
    assert.match(
      markup,
      /<div class="mb-1 font-medium leading-none tracking-tight">Session not found<\/div>/
    );
    assert.doesNotMatch(markup, /<h[1-6][^>]*>Session not found/);
    assert.match(markup, /This session does not exist or is no longer available/);
    assert.match(markup, /href="\/history"/);
    assert.match(markup, />History<\/a>/);
    assert.match(markup, /href="\/"/);
    assert.match(markup, />New session<\/a>/);
    assert.match(markup, /session-not-found-alert/);
  });
});

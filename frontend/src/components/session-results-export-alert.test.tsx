import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SESSION_RESULTS_EXPORT_UNAVAILABLE_MESSAGE } from "@/lib/session-results-export";

import { SessionResultsExportAlert } from "./session-results-export-alert";

function renderExportAlert(message: string): string {
  return renderToStaticMarkup(
    <SessionResultsExportAlert message={message} onRetry={() => undefined} />
  );
}

describe("Results export failure alert", () => {
  test("uses the existing destructive alert with an explicit Retry button", () => {
    const markup = renderExportAlert(SESSION_RESULTS_EXPORT_UNAVAILABLE_MESSAGE);

    assert.match(markup, /role="alert"/);
    assert.match(markup, /aria-live="assertive"/);
    assert.match(markup, /data-session-results-export-alert=""/);
    assert.match(markup, /session-results-export-alert/);
    assert.match(markup, /Could not export results/);
    assert.match(
      markup,
      /Start the local izayoi backend, then retry\./
    );
    assert.match(markup, /type="button"[^>]*>[\s\S]*Retry<\/button>/);
    assert.doesNotMatch(markup, /<h[1-6]/);
    assert.doesNotMatch(markup, /\[object Object\]/);
  });

  test("renders a supplied HTTP status line as text rather than HTML", () => {
    const markup = renderExportAlert('HTTP 500 <img src=x onerror="alert(1)">');

    assert.match(markup, /HTTP 500/);
    assert.doesNotMatch(markup, /<img/);
    assert.match(markup, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  });
});

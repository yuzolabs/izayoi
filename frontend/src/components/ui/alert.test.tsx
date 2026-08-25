import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { registerHappyDomTestEnvironment } from "@/test-support/happy-dom-test-environment";

import { Alert, AlertDescription, AlertTitle } from "./alert";

let cleanupHappyDomEnvironment: (() => Promise<void>) | undefined;

function renderAlertDom(markup: string): Document {
  const alertDocument = document.implementation.createHTMLDocument();
  alertDocument.body.innerHTML = markup;
  return alertDocument;
}

before(() => {
  cleanupHappyDomEnvironment = registerHappyDomTestEnvironment({
    url: "http://localhost/",
  }).cleanup;
});

after(async () => {
  await cleanupHappyDomEnvironment?.();
});

describe("Alert title document semantics", () => {
  test("renders generic alert title text as a div while forwarding div props", () => {
    const titleRef = createRef<HTMLDivElement>();
    const document = renderAlertDom(
      renderToStaticMarkup(
        <Alert>
          <AlertTitle ref={titleRef} data-alert-title="generic">
            Connection failed
          </AlertTitle>
          <AlertDescription>Try again later.</AlertDescription>
        </Alert>
      )
    );

    const alert = document.querySelector('[role="alert"]');
    const title = document.querySelector('[data-alert-title="generic"]');
    assert.ok(alert);
    assert.ok(title);
    assert.equal(title.tagName, "DIV");
    assert.equal(title.className, "mb-1 font-medium leading-none tracking-tight");
    assert.equal(document.querySelector("h1, h2, h3, h4, h5, h6"), null);
    assert.equal(alert.textContent, "Connection failedTry again later.");
  });

  test("lets the parent expose polite status semantics without moving text out of the live region", () => {
    const document = renderAlertDom(
      renderToStaticMarkup(
        <Alert role="status" aria-live="polite">
          <AlertTitle>Session complete</AlertTitle>
          <AlertDescription>Results are ready.</AlertDescription>
        </Alert>
      )
    );

    const status = document.querySelector('[role="status"]');
    assert.ok(status);
    assert.equal(status.getAttribute("aria-live"), "polite");
    assert.equal(status.textContent, "Session completeResults are ready.");
    assert.equal(status.querySelector("h1, h2, h3, h4, h5, h6"), null);
  });
});

import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";

import { getByRole } from "@testing-library/dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { registerHappyDomTestEnvironment } from "@/test-support/happy-dom-test-environment";

import { Slider } from "./slider";

let cleanupHappyDomEnvironment: (() => Promise<void>) | undefined;

before(() => {
  cleanupHappyDomEnvironment = registerHappyDomTestEnvironment({
    reactActEnvironment: true,
    url: "http://localhost/",
  }).cleanup;
});

after(async () => {
  await cleanupHappyDomEnvironment?.();
});

describe("Single-thumb slider accessibility props", () => {
  test("forwards accessible naming, description, and value text to the thumb only", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <>
            <p id="slider-usage-description">Controls the amount used.</p>
            <Slider
              min={1}
              max={10}
              defaultValue={[5]}
              aria-label="Usage amount"
              aria-describedby="slider-usage-description"
              aria-description="Choose one amount."
              aria-valuetext="Five units"
            />
          </>
        );
      });

      const sliderThumb = getByRole(container, "slider", { name: "Usage amount" });
      assert.equal(sliderThumb.getAttribute("aria-label"), "Usage amount");
      assert.equal(sliderThumb.getAttribute("aria-describedby"), "slider-usage-description");
      assert.equal(sliderThumb.getAttribute("aria-description"), "Choose one amount.");
      assert.equal(sliderThumb.getAttribute("aria-valuetext"), "Five units");

      const sliderRoot = sliderThumb.parentElement;
      assert.ok(sliderRoot);
      assert.equal(sliderRoot.getAttribute("role"), null);
      assert.equal(sliderRoot.getAttribute("aria-label"), null);
      assert.equal(sliderRoot.getAttribute("aria-describedby"), null);
      assert.equal(sliderRoot.getAttribute("aria-description"), null);
      assert.equal(sliderRoot.getAttribute("aria-valuetext"), null);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("Slider thumb target size", () => {
  test("thumb carries a 24x24 hit area with the 16px visual kept in ::before", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<Slider min={1} max={10} defaultValue={[5]} aria-label="Usage amount" />);
      });

      const sliderThumb = getByRole(container, "slider", { name: "Usage amount" });

      // WCAG 2.5.8 minimum target size: the interactive thumb element itself
      // must be at least 24x24 CSS px, not a 16px dot relying on spacing.
      for (const targetClass of ["h-6", "w-6"]) {
        assert.ok(
          sliderThumb.classList.contains(targetClass),
          `thumb must keep the 24px ${targetClass} hit-area class`
        );
      }

      // The visible knob stays 16px via a centered pseudo-element, so the
      // enlarged hit area never changes the control's visual weight.
      for (const visualClass of ["before:h-4", "before:w-4", "before:rounded-full"]) {
        assert.ok(
          sliderThumb.classList.contains(visualClass),
          `thumb must keep the 16px ${visualClass} visual-knob class`
        );
      }

      // The focus ring must cover the whole hit target, and pointer/touch
      // affordances must not regress while disabled.
      assert.ok(sliderThumb.classList.contains("focus-visible:ring-2"));
      assert.ok(sliderThumb.classList.contains("disabled:pointer-events-none"));
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

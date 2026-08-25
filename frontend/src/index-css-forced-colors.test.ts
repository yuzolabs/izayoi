import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

/**
 * CSS contract for forced-colors (Windows High Contrast mode).
 *
 * When the OS forces its palette, author colors flatten to system colors and
 * box-shadows disappear. Filled actions — notably the selected Results
 * decision key (variant="default" + bg-success/…, which carries no
 * border-width utility) — must still draw an explicit system-color edge,
 * ring-based focus must be replaced by a system outline, and the whole
 * contract must stay inert during normal rendering. See the block comment
 * above `@media (forced-colors: active)` in index.css.
 */
function readIndexCss(): string {
  return readFileSync(new URL("./index.css", import.meta.url), "utf8");
}

/** Extracts the body of the last `@media (forced-colors: active)` block. */
function forcedColorsBlock(css: string): string {
  const opens = [...css.matchAll(/@media\s*\(forced-colors:\s*active\)\s*\{/g)];
  assert.ok(opens.length > 0, "index.css declares a forced-colors media block");
  const open = opens[opens.length - 1];
  let depth = 1;
  const start = open.index! + open[0].length;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i);
    }
  }
  assert.fail("forced-colors media block is unbalanced");
}

/** Removes every brace-balanced @media block, keeping what renders unconditionally. */
function stripMediaBlocks(css: string): string {
  let out = css;
  for (;;) {
    const at = out.search(/@media[^{]*\{/);
    if (at === -1) return out;
    const openBrace = out.indexOf("{", at);
    let depth = 1;
    let end = -1;
    for (let i = openBrace + 1; i < out.length; i++) {
      if (out[i] === "{") depth++;
      if (out[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) return out;
    out = out.slice(0, at) + out.slice(end + 1);
  }
}

describe("index.css forced-colors contract (source verification)", () => {
  test("forced-colors block loads after Tailwind utilities so its rules win the cascade", () => {
    const css = readIndexCss();
    const utilitiesDirective = css.indexOf("@tailwind utilities");
    const block = css.indexOf("@media (forced-colors: active)");
    assert.ok(utilitiesDirective !== -1, "@tailwind utilities directive exists");
    assert.ok(block > utilitiesDirective, "forced-colors block follows the utilities directive");
  });

  test("every interactive control keeps a 1px ButtonText edge", () => {
    const block = forcedColorsBlock(readIndexCss());
    const base = block.match(/button,\s*\n?\s*a\[href\],\s*\n?\s*\[role="button"\]\s*\{([^}]*)\}/);
    assert.ok(base, "base selector covers button, a[href], and [role=button]");
    assert.match(
      base[1],
      /border:\s*1px solid ButtonText/,
      "interactive controls declare a 1px ButtonText border"
    );
  });

  test("solid-fill actions (bg-primary/secondary/success/caution/destructive) get a 2px edge", () => {
    const block = forcedColorsBlock(readIndexCss());
    for (const fill of ["bg-primary", "bg-secondary", "bg-success", "bg-caution", "bg-destructive"]) {
      assert.ok(
        block.includes(`.${fill}`),
        `filled-action rule covers ${fill}`
      );
    }
    assert.match(
      block,
      /border:\s*2px solid ButtonText/,
      "filled actions declare a 2px ButtonText border"
    );
  });

  test("keyboard focus returns as a system Highlight outline", () => {
    const block = forcedColorsBlock(readIndexCss());
    assert.match(block, /:focus-visible\s*\{/, "a :focus-visible rule exists in the block");
    assert.match(
      block,
      /outline:\s*2px solid Highlight/,
      "focus-visible outline is 2px solid Highlight"
    );
    assert.match(
      block,
      /outline-offset:\s*2px/,
      "focus-visible outline keeps a 2px offset from the control edge"
    );
  });

  test("forced-color-adjust: none is never used — the system palette wins", () => {
    const css = readIndexCss();
    assert.ok(
      !/forced-color-adjust\s*:\s*none/.test(css),
      "index.css must not opt any element out of the forced colors palette"
    );
  });

  test("all forced-colors declarations live inside the media query (normal rendering untouched)", () => {
    const css = readIndexCss();
    // Strip every @media block and all comments, then no forced-colors-
    // specific declaration may survive outside one (ButtonText/Highlight
    // only appear there).
    const withoutMediaBlocks = stripMediaBlocks(css).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(
      !withoutMediaBlocks.includes("ButtonText"),
      "ButtonText edges are scoped to media queries"
    );
    assert.ok(
      !withoutMediaBlocks.includes("2px solid Highlight"),
      "Highlight focus outline is scoped to media queries"
    );
  });
});

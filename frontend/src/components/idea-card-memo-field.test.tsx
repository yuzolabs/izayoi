import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";

import { fireEvent } from "@testing-library/dom";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { Idea } from "@/lib/api";
import {
  getResultsIdeaMemoFieldElementId,
  RESULTS_IDEA_MEMO_TOO_LONG_ERROR,
} from "@/lib/results-idea-memo-field-validation";
import type { ResultsIdeaDecisionAttempt } from "@/lib/session-results-decision-state";
import { SESSION_TEXT_FIELD_MAX_LENGTH } from "@/lib/session-text-field-max-length";
import { registerHappyDomTestEnvironment } from "@/test-support/happy-dom-test-environment";

import { IdeaCard } from "./idea-card";

const IDEA: Idea = {
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

interface RenderedIdeaCard {
  container: HTMLDivElement;
  root: Root;
  saves: ResultsIdeaDecisionAttempt[];
  retries: number;
  unmount: () => Promise<void>;
}

function getMemoField(container: ParentNode): HTMLTextAreaElement {
  const field = container.querySelector<HTMLTextAreaElement>(
    `#${getResultsIdeaMemoFieldElementId(IDEA.id, "field")}`
  );
  assert.ok(field, "Expected Results idea memo textarea");
  return field;
}

function getMemoError(container: ParentNode): HTMLElement | null {
  return container.querySelector(
    `#${getResultsIdeaMemoFieldElementId(IDEA.id, "error")}`
  );
}

async function renderIdeaCard(
  idea: Idea = IDEA,
  saveState?: Parameters<typeof IdeaCard>[0]["saveState"]
): Promise<RenderedIdeaCard> {
  const saves: ResultsIdeaDecisionAttempt[] = [];
  const rendered: RenderedIdeaCard = {
    container: document.createElement("div"),
    root: null as unknown as Root,
    saves,
    retries: 0,
    unmount: async () => {
      await act(async () => rendered.root.unmount());
      rendered.container.remove();
    },
  };
  document.body.append(rendered.container);
  rendered.root = createRoot(rendered.container);
  await act(async () => {
    rendered.root.render(
      <StrictMode>
        <IdeaCard
          idea={idea}
          saveState={saveState}
          scoreAdvisoryId="score-advisory"
          onSave={(attempt) => {
            saves.push(attempt);
          }}
          onRetry={() => {
            rendered.retries += 1;
          }}
        />
      </StrictMode>
    );
  });
  return rendered;
}

describe("Results idea memo field contract", () => {
  let cleanupHappyDomEnvironment: (() => Promise<void>) | undefined;

  before(() => {
    cleanupHappyDomEnvironment = registerHappyDomTestEnvironment({
      height: 844,
      reactActEnvironment: true,
      url: "http://localhost/session/session-1/results",
      width: 390,
    }).cleanup;
  });

  after(async () => {
    await cleanupHappyDomEnvironment?.();
  });

  test("exposes stable hint, counter, and error ids with the shared max length", async () => {
    const rendered = await renderIdeaCard();
    try {
      const field = getMemoField(rendered.container);
      assert.equal(field.maxLength, SESSION_TEXT_FIELD_MAX_LENGTH);
      assert.equal(field.getAttribute("aria-invalid"), "false");
      const describedBy = field.getAttribute("aria-describedby") ?? "";
      assert.match(
        describedBy,
        new RegExp(getResultsIdeaMemoFieldElementId(IDEA.id, "hint"))
      );
      assert.match(
        describedBy,
        new RegExp(getResultsIdeaMemoFieldElementId(IDEA.id, "counter"))
      );
      assert.doesNotMatch(
        describedBy,
        new RegExp(getResultsIdeaMemoFieldElementId(IDEA.id, "error"))
      );
      assert.equal(field.getAttribute("aria-errormessage"), null);
      assert.ok(
        rendered.container.querySelector(
          `#${getResultsIdeaMemoFieldElementId(IDEA.id, "hint")}`
        )
      );
      assert.equal(
        rendered.container
          .querySelector(`#${getResultsIdeaMemoFieldElementId(IDEA.id, "counter")}`)
          ?.textContent?.trim(),
        `${IDEA.note.length} / ${SESSION_TEXT_FIELD_MAX_LENGTH}`
      );
      assert.equal(getMemoError(rendered.container), null);
    } finally {
      await rendered.unmount();
    }
  });

  test("accepts 2000 characters and rejects programmatic 2001 without saving", async () => {
    const rendered = await renderIdeaCard({ ...IDEA, note: "" });
    try {
      const field = getMemoField(rendered.container);
      await act(async () => {
        fireEvent.input(field, { target: { value: "m".repeat(2_000) } });
      });
      assert.equal(getMemoError(rendered.container), null);
      assert.equal(field.getAttribute("aria-invalid"), "false");

      const saveMemo = [...rendered.container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Save memo"
      );
      assert.ok(saveMemo);
      assert.equal(saveMemo.disabled, false);
      await act(async () => saveMemo.click());
      assert.deepEqual(rendered.saves, [
        { decision: "held", note: "m".repeat(2_000) },
      ]);

      await act(async () => {
        fireEvent.input(field, { target: { value: "m".repeat(2_001) } });
      });
      assert.equal(field.value.length, 2_001);
      assert.equal(
        getMemoError(rendered.container)?.textContent?.trim(),
        RESULTS_IDEA_MEMO_TOO_LONG_ERROR
      );
      assert.equal(field.getAttribute("aria-invalid"), "true");
      assert.equal(
        field.getAttribute("aria-errormessage"),
        getResultsIdeaMemoFieldElementId(IDEA.id, "error")
      );
      assert.match(
        field.getAttribute("aria-describedby") ?? "",
        new RegExp(getResultsIdeaMemoFieldElementId(IDEA.id, "error"))
      );
      assert.equal(saveMemo.disabled, true);
      await act(async () => {
        [...rendered.container.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "Adopt")
          ?.click();
      });
      assert.equal(rendered.saves.length, 1);
    } finally {
      await rendered.unmount();
    }
  });

  test("does not PATCH a 100001-character programmatic memo and keeps overflow CSS", async () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    const memoRule =
      css.match(/\.results-idea-memo-field\s*\{([^}]*)\}/)?.[1] ?? "";
    assert.match(memoRule, /max-height:\s*9rem/);
    assert.match(memoRule, /max-width:\s*100%/);
    assert.match(memoRule, /overflow-y:\s*auto/);
    assert.match(memoRule, /overflow-wrap:\s*anywhere/);

    for (const width of [390, 320]) {
      const rendered = await renderIdeaCard({ ...IDEA, note: "" });
      try {
        rendered.container.style.width = `${width}px`;
        const field = getMemoField(rendered.container);
        await act(async () => {
          fireEvent.input(field, { target: { value: "n".repeat(100_001) } });
        });
        assert.equal(field.value.length, 100_001);
        assert.ok(field.classList.contains("results-idea-memo-field"));
        assert.equal(
          getMemoError(rendered.container)?.textContent?.trim(),
          RESULTS_IDEA_MEMO_TOO_LONG_ERROR
        );
        await act(async () => {
          [...rendered.container.querySelectorAll("button")]
            .find((button) => button.textContent?.trim() === "Save memo")
            ?.click();
          [...rendered.container.querySelectorAll("button")]
            .find((button) => button.textContent?.trim() === "Adopt")
            ?.click();
        });
        assert.deepEqual(rendered.saves, []);
        assert.ok(
          rendered.container.scrollWidth <= width ||
            field.classList.contains("results-idea-memo-field"),
          `memo field must not stretch the ${width}px card`
        );
      } finally {
        await rendered.unmount();
      }
    }
  });

  test("trims Unicode whitespace and treats whitespace-only memos as a clear", async () => {
    const rendered = await renderIdeaCard();
    try {
      const field = getMemoField(rendered.container);
      await act(async () => {
        fireEvent.input(field, { target: { value: "\u3000月の案\u3000" } });
      });
      const saveMemo = [...rendered.container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Save memo"
      );
      assert.ok(saveMemo);
      await act(async () => saveMemo.click());
      assert.deepEqual(rendered.saves, [{ decision: "held", note: "月の案" }]);

      await act(async () => {
        fireEvent.input(field, { target: { value: "  \u3000  " } });
      });
      await act(async () => saveMemo.click());
      assert.deepEqual(rendered.saves[1], { decision: "held", note: "" });
    } finally {
      await rendered.unmount();
    }
  });

  test("maps a server note 422 onto the memo error and clears it on edit", async () => {
    const rendered = await renderIdeaCard(IDEA, {
      status: "error",
      attempt: { decision: "held", note: "Pilot next week" },
      message: "Server rejected the memo.",
      memoError: "Server rejected the memo.",
    });
    try {
      const field = getMemoField(rendered.container);
      assert.equal(
        getMemoError(rendered.container)?.textContent?.trim(),
        "Server rejected the memo."
      );
      assert.doesNotMatch(rendered.container.textContent ?? "", /\[object Object\]/);
      assert.equal(field.getAttribute("aria-invalid"), "true");
      assert.equal(
        field.getAttribute("aria-errormessage"),
        getResultsIdeaMemoFieldElementId(IDEA.id, "error")
      );
      assert.doesNotMatch(
        rendered.container.textContent ?? "",
        /Save failed: Server rejected the memo\./
      );

      await act(async () => {
        fireEvent.input(field, { target: { value: "Corrected memo" } });
      });
      assert.equal(getMemoError(rendered.container), null);
      assert.ok(
        [...rendered.container.querySelectorAll("button")].some(
          (button) => button.textContent?.trim() === "Retry failed save"
        )
      );
    } finally {
      await rendered.unmount();
    }
  });
});

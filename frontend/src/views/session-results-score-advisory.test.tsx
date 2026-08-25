import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";

import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { api, type Idea, type Session } from "@/lib/api";
import {
  assertHappyDomGlobalEnvironmentRestored,
  registerHappyDomTestEnvironment,
} from "@/test-support/happy-dom-test-environment";

import { SessionResults } from "./session-results";

/** id of the always-visible LLM score advisory note (see session-results.tsx). */
const SCORE_ADVISORY_SELECTOR = "#results-llm-score-advisory";

const SCORED_RESULTS_SESSION: Session = {
  id: "session-1",
  theme: "Choose a neighborhood pilot",
  constraints: "Keep the first trial reversible",
  status: "done",
  phase_progress: "done",
  agents: [],
  created_at: "2026-08-24T00:00:00Z",
  metrics: null,
};

const originalApiMethods = {
  getSession: api.getSession,
  listIdeas: api.listIdeas,
  listMessages: api.listMessages,
  updateDecision: api.updateDecision,
};

function makeScoredResultsIdea(id: string): Idea {
  return {
    id,
    session_id: SCORED_RESULTS_SESSION.id,
    persona_type: "ARCHITECT",
    phase: "divergence",
    content: `Idea ${id}`,
    cluster_id: 1,
    synthesized: "Cluster 1 synthesis",
    scores: { novelty: 8, feasibility: 6, clarity: 7, total: 21 },
    decision: "pending",
    note: "",
  };
}

describe("Session Results LLM score advisory relation", () => {
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
    api.getSession = originalApiMethods.getSession;
    api.listIdeas = originalApiMethods.listIdeas;
    api.listMessages = originalApiMethods.listMessages;
    api.updateDecision = originalApiMethods.updateDecision;
    await cleanupHappyDomEnvironment?.();
  });

  test("score badges point at one advisory that renders outside the closed details fold", async () => {
    api.getSession = async () => SCORED_RESULTS_SESSION;
    api.listIdeas = async () => ({ ideas: [makeScoredResultsIdea("first")] });
    api.listMessages = async () => ({ messages: [] });
    api.updateDecision = async (ideaId, decision, note) => ({
      ...makeScoredResultsIdea(ideaId),
      decision,
      note: note ?? "",
    });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <MemoryRouter initialEntries={["/session/session-1/results"]}>
              <Routes>
                <Route path="/session/:id/results" element={<SessionResults />} />
              </Routes>
            </MemoryRouter>
          </StrictMode>
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      for (let frame = 0; frame < 3; frame += 1) {
        await act(
          () =>
            new Promise<void>((resolve) => {
              window.requestAnimationFrame(() => resolve());
            })
        );
      }

      // One advisory id in the whole document — the sole describedby target.
      const advisoryElements = document.querySelectorAll(SCORE_ADVISORY_SELECTOR);
      assert.equal(advisoryElements.length, 1);
      const advisory = advisoryElements[0];
      assert.match(
        advisory.textContent ?? "",
        /LLM scores are advisory — you make the final call\./
      );

      // Every LLM score group resolves its aria-describedby to that element.
      const scoreGroups = [
        ...document.querySelectorAll<HTMLElement>('[role="group"][aria-label="LLM scores"]'),
      ];
      assert.ok(scoreGroups.length > 0, "expected at least one scored idea");
      for (const scoreGroup of scoreGroups) {
        assert.equal(scoreGroup.getAttribute("aria-describedby"), "results-llm-score-advisory");
        assert.ok(scoreGroup.closest(`[aria-describedby="results-llm-score-advisory"]`));
      }
      assert.equal(
        document.querySelector('[aria-describedby="results-llm-score-advisory"]'),
        scoreGroups[0]
      );

      // The advisory must never sit inside the review details fold — even
      // closed, it stays a rendered (findable) describedby target.
      assert.equal(advisory.closest("details"), null);

      // The fold itself mounts closed and keeps only the long explanation,
      // constraints, and exports — no duplicate advisory id inside.
      const reviewDetails = document.querySelector("aside[aria-label='Decision index'] details");
      assert.ok(reviewDetails, "expected the review details fold");
      assert.equal(reviewDetails.hasAttribute("open"), false);
      assert.equal(reviewDetails.contains(advisory), false);
      assert.match(reviewDetails.textContent ?? "", /Judge scores agree with human ranking/);
      assert.ok(reviewDetails.textContent?.includes("Markdown"));
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

test("score advisory teardown leaves the Happy DOM sentinel baseline", () => {
  assertHappyDomGlobalEnvironmentRestored();
});

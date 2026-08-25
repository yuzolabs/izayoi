import { strict as assert } from "node:assert";
import { afterEach, describe, test } from "node:test";

import type { AgentConfig } from "./api";
import {
  clearCreateSessionDraft,
  CREATE_SESSION_DRAFT_DEFAULTS,
  readCreateSessionDraft,
  writeCreateSessionDraft,
} from "./create-session-draft";

const SAMPLE_CREATE_SESSION_DRAFT_CAST: AgentConfig[] = [
  {
    persona_type: "INTJ",
    provider: "mock",
    model: "mock-strong",
    role: "participant",
  },
  {
    persona_type: "ENTP",
    provider: "openai",
    model: "gpt-4o",
    role: "devils_advocate",
  },
];

function sampleCreateSessionDraft() {
  return {
    theme: "Neighborhood repair café growth",
    constraints: "No paid ads",
    cast: SAMPLE_CREATE_SESSION_DRAFT_CAST.map((agent) => ({ ...agent })),
    balanceCount: 6,
    ideasPerAgent: 7,
    discussionRounds: 1,
    enableJudge: false,
    facilitator: { provider: "openai", model: "gpt-4o" },
  };
}

afterEach(() => {
  clearCreateSessionDraft();
});

describe("Create session in-memory draft store", () => {
  test("starts empty, then round-trips a cloned draft without sessionStorage", () => {
    const storageWrites: unknown[] = [];
    const previousSessionStorage = Object.getOwnPropertyDescriptor(
      globalThis,
      "sessionStorage"
    );
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        get length() {
          return storageWrites.length;
        },
        setItem(...args: unknown[]) {
          storageWrites.push(args);
        },
        getItem() {
          return null;
        },
        removeItem() {},
        clear() {},
        key() {
          return null;
        },
      },
    });

    try {
      assert.equal(readCreateSessionDraft(), null);
      assert.equal(CREATE_SESSION_DRAFT_DEFAULTS.enableJudge, true);
      assert.equal(CREATE_SESSION_DRAFT_DEFAULTS.ideasPerAgent, 3);

      const written = sampleCreateSessionDraft();
      writeCreateSessionDraft(written);
      written.theme = "mutated writer";
      written.cast[0].model = "mutated-writer-model";
      written.facilitator.model = "mutated-writer-facilitator";

      const readOnce = readCreateSessionDraft();
      assert.deepEqual(readOnce, sampleCreateSessionDraft());
      assert.notEqual(readOnce, written);
      assert.ok(readOnce);
      readOnce.theme = "mutated reader";
      readOnce.cast[1].role = "participant";
      assert.deepEqual(readCreateSessionDraft(), sampleCreateSessionDraft());
      assert.equal(storageWrites.length, 0);

      clearCreateSessionDraft();
      assert.equal(readCreateSessionDraft(), null);
      assert.equal(storageWrites.length, 0);
    } finally {
      if (previousSessionStorage === undefined) {
        Reflect.deleteProperty(globalThis, "sessionStorage");
      } else {
        Object.defineProperty(globalThis, "sessionStorage", previousSessionStorage);
      }
    }
  });

  test("omits submitting, loadError, providers, and personas from the stored snapshot", () => {
    writeCreateSessionDraft(sampleCreateSessionDraft());
    const draft = readCreateSessionDraft();
    assert.ok(draft);
    assert.deepEqual(Object.keys(draft).sort(), [
      "balanceCount",
      "cast",
      "constraints",
      "discussionRounds",
      "enableJudge",
      "facilitator",
      "ideasPerAgent",
      "theme",
    ]);
  });
});

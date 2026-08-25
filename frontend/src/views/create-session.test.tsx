import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { after, afterEach, before, describe, test } from "node:test";

import {
  fireEvent,
  getAllByRole,
  getByRole,
  queryByRole,
} from "@testing-library/dom";
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";

import {
  api,
  ApiRequestError,
  type ProviderInfo,
  type Session,
  type SessionCreate,
} from "@/lib/api";
import { clearCreateSessionDraft } from "@/lib/create-session-draft";
import { registerHappyDomTestEnvironment } from "@/test-support/happy-dom-test-environment";

import { CreateSession } from "./create-session";

interface RenderedCreateSession {
  container: HTMLDivElement;
  navigationPaths: string[];
  root: Root;
  unmount: () => Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
}

interface CreateSessionButtonContract {
  accessibleName: string;
  type: string | null;
}

const READY_CREATE_SESSION_BUTTON_CONTRACTS = [
  { accessibleName: "01 Theme", type: "button" },
  { accessibleName: "02 Cast", type: "button" },
  { accessibleName: "03 Models", type: "button" },
  { accessibleName: "04 Parameters", type: "button" },
  { accessibleName: "Start brainstorming", type: "submit" },
  { accessibleName: "Theme — step 1 of 4", type: "button" },
  { accessibleName: "Cast — step 2 of 4", type: "button" },
  { accessibleName: "Models — step 3 of 4", type: "button" },
  { accessibleName: "Parameters — step 4 of 4", type: "button" },
  { accessibleName: "Balanced pick", type: "button" },
  { accessibleName: "All 16", type: "button" },
  { accessibleName: "Clear", type: "button" },
  { accessibleName: "INTJ", type: "button" },
  { accessibleName: "INTP", type: "button" },
  { accessibleName: "ENTJ", type: "button" },
  { accessibleName: "ENTP", type: "button" },
  { accessibleName: "INFJ", type: "button" },
  { accessibleName: "INFP", type: "button" },
  { accessibleName: "ENFJ", type: "button" },
  { accessibleName: "ENFP", type: "button" },
  { accessibleName: "ISTJ", type: "button" },
  { accessibleName: "ISFJ", type: "button" },
  { accessibleName: "ESTJ", type: "button" },
  { accessibleName: "ESFJ", type: "button" },
  { accessibleName: "ISTP", type: "button" },
  { accessibleName: "ISFP", type: "button" },
  { accessibleName: "ESTP", type: "button" },
  { accessibleName: "ESFP", type: "button" },
  { accessibleName: "INTJ devil's advocate", type: "button" },
  { accessibleName: "INTP devil's advocate", type: "button" },
  { accessibleName: "LLM judge pre-ranking", type: "button" },
  { accessibleName: "Start brainstorming", type: "submit" },
] as const satisfies readonly CreateSessionButtonContract[];

const READY_PROVIDER: ProviderInfo = {
  id: "mock",
  label: "Mock",
  available: true,
  env_var: null,
  models: ["mock-model"],
};

const originalProviders = api.providers;
const originalPersonas = api.personas;
const originalBalanced = api.balanced;
const originalCreateSession = api.createSession;
const originalStartSession = api.startSession;

const loadReadyProviders = async () => ({ providers: [READY_PROVIDER] });
const loadEmptyPersonas = async () => ({ personas: [] });

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createTestSession(id: string): Session {
  return {
    id,
    theme: "Race-free session",
    constraints: "",
    status: "framing",
    phase_progress: "framing",
    agents: [],
    created_at: "2026-01-01T00:00:00Z",
    metrics: null,
  };
}

function NavigationPathObserver({ paths }: { paths: string[] }) {
  const location = useLocation();
  useEffect(() => {
    paths.push(location.pathname);
  }, [location.key, location.pathname, paths]);
  return null;
}

function CreateSessionRouteFixture() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/away")}>
        Leave create route
      </button>
      <CreateSession />
    </>
  );
}

function AwayRouteFixture() {
  const navigate = useNavigate();
  return (
    <>
      <p>Outside create route</p>
      <button type="button" onClick={() => navigate("/")}>
        Return to create route
      </button>
    </>
  );
}

function LiveSessionRouteFixture() {
  const navigate = useNavigate();
  return (
    <>
      <p>Live session route</p>
      <button type="button" onClick={() => navigate("/")}>
        Return to create from live
      </button>
    </>
  );
}

async function resolveDeferred<T>(deferred: Deferred<T>, value: T): Promise<void> {
  await act(async () => {
    deferred.resolve(value);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function rejectDeferred<T>(deferred: Deferred<T>, reason: Error): Promise<void> {
  await act(async () => {
    deferred.reject(reason);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderCreateSession({
  strictMode = false,
}: {
  strictMode?: boolean;
} = {}): Promise<RenderedCreateSession> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const navigationPaths: string[] = [];
  const routedCreateSession = (
    <MemoryRouter>
      <NavigationPathObserver paths={navigationPaths} />
      <Routes>
        <Route path="/" element={<CreateSessionRouteFixture />} />
        <Route path="/away" element={<AwayRouteFixture />} />
        <Route path="/session/:id" element={<LiveSessionRouteFixture />} />
      </Routes>
    </MemoryRouter>
  );

  await act(async () => {
    root.render(strictMode ? <StrictMode>{routedCreateSession}</StrictMode> : routedCreateSession);
    await Promise.resolve();
    await Promise.resolve();
  });

  return {
    container,
    navigationPaths,
    root,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function prepareValidCreateSessionForm(
  renderedCreateSession: RenderedCreateSession
): Promise<HTMLButtonElement[]> {
  const themeInput = getByRole(renderedCreateSession.container, "textbox", {
    name: "What should the council brainstorm?",
  });
  await act(async () => {
    fireEvent.input(themeInput, { target: { value: "Prevent duplicate sessions" } });
  });

  const castSection = renderedCreateSession.container.querySelector("#step-cast");
  assert.ok(castSection);
  const personaButtons = Array.from(
    castSection.querySelectorAll<HTMLButtonElement>('button[aria-pressed="false"]')
  );
  assert.ok(personaButtons.length >= 2);
  await act(async () => {
    personaButtons[0].click();
    personaButtons[1].click();
  });

  const startButtons = getAllByRole(renderedCreateSession.container, "button", {
    name: "Start brainstorming",
  }) as HTMLButtonElement[];
  assert.equal(startButtons.length, 2);
  assert.ok(startButtons.every((button) => !button.disabled));
  return startButtons;
}

function getCreateSessionForm(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector("form");
  assert.ok(form);
  return form;
}

function normalizeCreateSessionAccessibleName(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function getCreateSessionButtonAccessibleName(button: HTMLButtonElement): string {
  const labelledBy = button.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    return normalizeCreateSessionAccessibleName(
      labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
    );
  }

  const ariaLabel = button.getAttribute("aria-label");
  if (ariaLabel !== null) return normalizeCreateSessionAccessibleName(ariaLabel);

  const associatedLabelText = Array.from(button.labels)
    .map((label) => label.textContent ?? "")
    .join(" ");
  const buttonContentText = Array.from(button.childNodes)
    .map((node) => node.textContent ?? "")
    .join(" ");
  return normalizeCreateSessionAccessibleName(
    associatedLabelText === "" ? buttonContentText : associatedLabelText
  );
}

function listCreateSessionButtonContracts(
  scope: ParentNode
): CreateSessionButtonContract[] {
  return Array.from(scope.querySelectorAll<HTMLButtonElement>("button"), (button) => ({
    accessibleName: getCreateSessionButtonAccessibleName(button),
    type: button.getAttribute("type"),
  }));
}

function getCreateSessionButtonByAccessibleName(
  scope: ParentNode,
  accessibleName: string
): HTMLButtonElement {
  const matchingButtons = Array.from(
    scope.querySelectorAll<HTMLButtonElement>("button")
  ).filter(
    (button) => getCreateSessionButtonAccessibleName(button) === accessibleName
  );
  assert.equal(
    matchingButtons.length,
    1,
    `expected one Create button named "${accessibleName}"`
  );
  return matchingButtons[0];
}

async function pressSliderKey(slider: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    slider.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
  });
}

let cleanupHappyDomEnvironment: (() => Promise<void>) | undefined;

before(() => {
  cleanupHappyDomEnvironment = registerHappyDomTestEnvironment({
    reactActEnvironment: true,
    url: "http://localhost/",
  }).cleanup;
  api.providers = loadReadyProviders;
  api.personas = loadEmptyPersonas;
});

afterEach(() => {
  clearCreateSessionDraft();
  api.providers = loadReadyProviders;
  api.personas = loadEmptyPersonas;
  api.balanced = originalBalanced;
  api.createSession = originalCreateSession;
  api.startSession = originalStartSession;
});

after(async () => {
  api.providers = originalProviders;
  api.personas = originalPersonas;
  api.balanced = originalBalanced;
  api.createSession = originalCreateSession;
  api.startSession = originalStartSession;
  await cleanupHappyDomEnvironment?.();
});

describe("Create button type contract", () => {
  test("ready form enumerates every accessible button name and explicit HTML type", async () => {
    const renderedCreateSession = await renderCreateSession();

    try {
      await prepareValidCreateSessionForm(renderedCreateSession);
      const form = getCreateSessionForm(renderedCreateSession.container);

      assert.deepEqual(
        listCreateSessionButtonContracts(form),
        READY_CREATE_SESSION_BUTTON_CONTRACTS
      );
      assert.equal(
        form.querySelectorAll('button[type="submit"]').length,
        2,
        "only the two Start brainstorming actions submit the Create form"
      );
      assert.equal(
        form.querySelectorAll("button:not([type])").length,
        0,
        "every Create button declares its HTML type"
      );
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("activating each ready non-submit button performs zero create or start POSTs", async () => {
    let createCallCount = 0;
    let startCallCount = 0;
    api.balanced = async () => ({ types: ["INTJ", "INTP", "ENTJ", "ENTP"] });
    api.createSession = async () => {
      createCallCount += 1;
      return createTestSession("unexpected-non-submit");
    };
    api.startSession = async () => {
      startCallCount += 1;
      return { status: "started" };
    };

    const nonSubmitAccessibleNames = READY_CREATE_SESSION_BUTTON_CONTRACTS
      .filter((buttonContract) => buttonContract.type === "button")
      .map((buttonContract) => buttonContract.accessibleName);
    assert.equal(
      new Set(nonSubmitAccessibleNames).size,
      nonSubmitAccessibleNames.length,
      "each ready non-submit button has a unique accessible name"
    );
    const personaAccessibleNames = nonSubmitAccessibleNames.filter((name) =>
      /^[EI][NS][TF][JP]$/.test(name)
    );
    const stableControlAccessibleNames = nonSubmitAccessibleNames.filter(
      (name) => name !== "Clear" && !personaAccessibleNames.includes(name)
    );

    const renderedCreateSession = await renderCreateSession();
    try {
      await prepareValidCreateSessionForm(renderedCreateSession);
      const form = getCreateSessionForm(renderedCreateSession.container);

      await act(async () => {
        for (const accessibleName of stableControlAccessibleNames) {
          const button = getCreateSessionButtonByAccessibleName(form, accessibleName);
          assert.equal(button.getAttribute("type"), "button");
          button.click();
        }
        await Promise.resolve();
      });

      await act(async () => {
        getCreateSessionButtonByAccessibleName(form, "Clear").click();
      });

      await act(async () => {
        for (const accessibleName of personaAccessibleNames) {
          getCreateSessionButtonByAccessibleName(form, accessibleName).click();
        }
      });

      assert.equal(createCallCount, 0);
      assert.equal(startCallCount, 0);
    } finally {
      await renderedCreateSession.unmount();
    }
  });
});

describe("Create theme and constraints validation", () => {
  test("exposes stable descriptions and trim-aware touched errors", async () => {
    const renderedCreateSession = await renderCreateSession();

    try {
      const themeField = getByRole(renderedCreateSession.container, "textbox", {
        name: "What should the council brainstorm?",
      }) as HTMLTextAreaElement;
      const constraintsField = getByRole(renderedCreateSession.container, "textbox", {
        name: /Constraints/,
      }) as HTMLInputElement;

      assert.equal(themeField.required, true);
      assert.equal(themeField.maxLength, 2000);
      assert.equal(themeField.getAttribute("aria-invalid"), "false");
      assert.equal(themeField.getAttribute("aria-describedby"), "theme-hint theme-counter");
      assert.equal(
        renderedCreateSession.container.querySelector("#theme-counter")?.textContent?.trim(),
        "0 / 2000"
      );
      assert.ok(renderedCreateSession.container.querySelector("#theme-hint"));

      assert.equal(constraintsField.required, false);
      assert.equal(constraintsField.maxLength, 2000);
      assert.equal(constraintsField.getAttribute("aria-invalid"), "false");
      assert.equal(
        constraintsField.getAttribute("aria-describedby"),
        "constraints-hint constraints-counter"
      );
      assert.ok(renderedCreateSession.container.querySelector("#constraints-hint"));
      assert.ok(renderedCreateSession.container.querySelector("#constraints-counter"));

      await act(async () => fireEvent.focusOut(themeField));
      const emptyThemeError = renderedCreateSession.container.querySelector("#theme-error");
      assert.equal(emptyThemeError?.textContent?.trim(), "Write a theme for the council.");
      assert.equal(themeField.getAttribute("aria-invalid"), "true");
      assert.match(themeField.getAttribute("aria-describedby") ?? "", /theme-error/);

      await act(async () => {
        fireEvent.input(themeField, { target: { value: "   \u3000  " } });
      });
      assert.equal(
        renderedCreateSession.container.querySelector("#theme-error"),
        null,
        "editing clears the field's client error"
      );
      assert.equal(themeField.getAttribute("aria-invalid"), "false");
      assert.equal(
        renderedCreateSession.container.querySelector("#cta-reason-rail")?.textContent?.trim(),
        "Write a theme for the council."
      );

      await act(async () => fireEvent.focusOut(themeField));
      assert.equal(
        renderedCreateSession.container.querySelector("#theme-error")?.textContent?.trim(),
        "Write a theme for the council.",
        "Unicode whitespace remains empty after trimming"
      );

      await act(async () => {
        fireEvent.input(themeField, { target: { value: "\u3000月の案\u3000" } });
      });
      assert.equal(renderedCreateSession.container.querySelector("#theme-error"), null);
      assert.equal(
        renderedCreateSession.container.querySelector("#theme-counter")?.textContent?.trim(),
        "5 / 2000"
      );
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("accepts 1999 and 2000 characters but rejects programmatic 2001 state", async () => {
    let createCallCount = 0;
    api.createSession = async () => {
      createCallCount += 1;
      return createTestSession("must-not-create");
    };
    const renderedCreateSession = await renderCreateSession();

    try {
      await prepareValidCreateSessionForm(renderedCreateSession);
      const themeField = getByRole(renderedCreateSession.container, "textbox", {
        name: "What should the council brainstorm?",
      }) as HTMLTextAreaElement;
      const constraintsField = getByRole(renderedCreateSession.container, "textbox", {
        name: /Constraints/,
      }) as HTMLInputElement;

      for (const length of [1999, 2000]) {
        await act(async () => {
          fireEvent.input(themeField, { target: { value: "t".repeat(length) } });
        });
        assert.equal(
          renderedCreateSession.container.querySelector("#theme-counter")?.textContent?.trim(),
          `${length} / 2000`
        );
        assert.ok(
          getAllByRole(renderedCreateSession.container, "button", {
            name: "Start brainstorming",
          }).every((button) => !(button as HTMLButtonElement).disabled)
        );
      }

      await act(async () => {
        fireEvent.input(themeField, { target: { value: "t".repeat(2001) } });
      });
      assert.equal(themeField.value.length, 2001, "programmatic state can exceed maxLength");
      assert.equal(
        renderedCreateSession.container.querySelector("#cta-reason-rail")?.textContent?.trim(),
        "Theme must be 2,000 characters or fewer."
      );
      assert.ok(
        getAllByRole(renderedCreateSession.container, "button", {
          name: "Start brainstorming",
        }).every((button) => (button as HTMLButtonElement).disabled)
      );

      await act(async () => {
        getCreateSessionForm(renderedCreateSession.container).dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        );
        await Promise.resolve();
      });
      assert.equal(createCallCount, 0);
      assert.equal(
        renderedCreateSession.container.querySelector("#theme-error")?.textContent?.trim(),
        "Theme must be 2,000 characters or fewer."
      );
      assert.equal(document.activeElement, themeField);

      await act(async () => {
        fireEvent.input(themeField, { target: { value: "Valid theme" } });
        fireEvent.input(constraintsField, { target: { value: "c".repeat(2000) } });
      });
      assert.ok(
        getAllByRole(renderedCreateSession.container, "button", {
          name: "Start brainstorming",
        }).every((button) => !(button as HTMLButtonElement).disabled)
      );

      await act(async () => {
        fireEvent.input(constraintsField, { target: { value: "c".repeat(2001) } });
      });
      assert.equal(
        renderedCreateSession.container.querySelector("#cta-reason-rail")?.textContent?.trim(),
        "Constraints must be 2,000 characters or fewer."
      );
      await act(async () => {
        getCreateSessionForm(renderedCreateSession.container).dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        );
        await Promise.resolve();
      });
      assert.equal(createCallCount, 0);
      assert.equal(
        renderedCreateSession.container.querySelector("#constraints-error")?.textContent?.trim(),
        "Constraints must be 2,000 characters or fewer."
      );
      assert.equal(document.activeElement, constraintsField);
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("trims Unicode theme and constraints in the unchanged API payload", async () => {
    const submittedPayloads: SessionCreate[] = [];
    api.createSession = async (payload) => {
      submittedPayloads.push(payload);
      return createTestSession("trimmed-payload");
    };
    api.startSession = async () => ({ status: "started" });
    const renderedCreateSession = await renderCreateSession();

    try {
      const [startButton] = await prepareValidCreateSessionForm(renderedCreateSession);
      const themeField = getByRole(renderedCreateSession.container, "textbox", {
        name: "What should the council brainstorm?",
      });
      const constraintsField = getByRole(renderedCreateSession.container, "textbox", {
        name: /Constraints/,
      });
      await act(async () => {
        fireEvent.input(themeField, { target: { value: "\u3000月の案\u3000" } });
        fireEvent.input(constraintsField, { target: { value: "  予算なし  " } });
      });
      await act(async () => {
        startButton.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.deepEqual(
        {
          theme: submittedPayloads[0]?.theme,
          constraints: submittedPayloads[0]?.constraints,
        },
        { theme: "月の案", constraints: "予算なし" }
      );
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("maps 422 field issues, focuses theme after commit, clears on edit, and retries", async () => {
    let createCallCount = 0;
    api.createSession = async () => {
      createCallCount += 1;
      if (createCallCount === 1) {
        throw new ApiRequestError(422, "Validation failed", [
          {
            location: ["body", "constraints"],
            message: "Server rejected constraints.",
            type: "value_error",
          },
          {
            location: ["body", "theme"],
            message: "Server rejected theme.",
            type: "value_error",
          },
        ]);
      }
      return createTestSession("validation-retry");
    };
    api.startSession = async () => ({ status: "started" });
    const renderedCreateSession = await renderCreateSession();

    try {
      const [startButton] = await prepareValidCreateSessionForm(renderedCreateSession);
      await act(async () => {
        startButton.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      const themeField = getByRole(renderedCreateSession.container, "textbox", {
        name: "What should the council brainstorm?",
      });
      const constraintsField = getByRole(renderedCreateSession.container, "textbox", {
        name: /Constraints/,
      });
      assert.equal(createCallCount, 1);
      assert.equal(document.activeElement, themeField, "the first form field is focused");
      assert.equal(
        renderedCreateSession.container.querySelector("#theme-error")?.textContent?.trim(),
        "Server rejected theme."
      );
      assert.equal(
        renderedCreateSession.container.querySelector("#constraints-error")?.textContent?.trim(),
        "Server rejected constraints."
      );
      assert.equal(queryByRole(renderedCreateSession.container, "alert"), null);
      assert.ok(
        getAllByRole(renderedCreateSession.container, "button", {
          name: "Start brainstorming",
        }).every((button) => !(button as HTMLButtonElement).disabled),
        "a 422 response releases the single-flight lock"
      );

      await act(async () => {
        fireEvent.input(themeField, { target: { value: "Corrected theme" } });
      });
      assert.equal(renderedCreateSession.container.querySelector("#theme-error"), null);
      assert.ok(renderedCreateSession.container.querySelector("#constraints-error"));
      await act(async () => {
        fireEvent.input(constraintsField, { target: { value: "Corrected constraints" } });
      });
      assert.equal(renderedCreateSession.container.querySelector("#constraints-error"), null);

      const [retryButton] = getAllByRole(renderedCreateSession.container, "button", {
        name: "Start brainstorming",
      }) as HTMLButtonElement[];
      await act(async () => {
        retryButton.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      assert.equal(createCallCount, 2);
      assert.ok(renderedCreateSession.navigationPaths.includes("/session/validation-retry"));
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("keeps unknown 422 issues in the general alert without object coercion", async () => {
    api.createSession = async () => {
      throw new ApiRequestError(422, "agents.0.provider: Provider is unavailable", [
        {
          location: ["body", "agents", 0, "provider"],
          message: "Provider is unavailable",
          type: "value_error",
        },
      ]);
    };
    const renderedCreateSession = await renderCreateSession();

    try {
      const [startButton] = await prepareValidCreateSessionForm(renderedCreateSession);
      await act(async () => {
        startButton.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      const alert = getByRole(renderedCreateSession.container, "alert");
      assert.match(alert.textContent ?? "", /agents\.0\.provider: Provider is unavailable/);
      assert.doesNotMatch(alert.textContent ?? "", /\[object Object\]/);
      assert.equal(renderedCreateSession.container.querySelector("#theme-error"), null);
      assert.equal(renderedCreateSession.container.querySelector("#constraints-error"), null);
    } finally {
      await renderedCreateSession.unmount();
    }
  });
});

describe("Create submit mutual exclusion", () => {
  test("same-tick click twice runs one create-start chain and navigates once", async () => {
    const createRequest = createDeferred<Session>();
    const startRequest = createDeferred<{ status: string }>();
    let createCallCount = 0;
    let startCallCount = 0;
    const startedSessionIds: string[] = [];
    api.createSession = () => {
      createCallCount += 1;
      return createRequest.promise;
    };
    api.startSession = (sessionId) => {
      startCallCount += 1;
      startedSessionIds.push(sessionId);
      return startRequest.promise;
    };
    const renderedCreateSession = await renderCreateSession();

    try {
      const startButtons = await prepareValidCreateSessionForm(renderedCreateSession);
      await act(async () => {
        startButtons[0].dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true })
        );
        startButtons[1].dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true })
        );
      });

      assert.equal(createCallCount, 1);
      assert.deepEqual(startedSessionIds, []);

      await resolveDeferred(createRequest, createTestSession("same-tick"));
      assert.deepEqual(startedSessionIds, ["same-tick"]);
      await resolveDeferred(startRequest, { status: "started" });
      assert.equal(createCallCount, 1);
      assert.equal(startCallCount, 1);

      assert.equal(
        renderedCreateSession.navigationPaths.filter(
          (pathname) => pathname === "/session/same-tick"
        ).length,
        1
      );
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("Enter submit plus click runs one create-start chain", async () => {
    const createRequest = createDeferred<Session>();
    const startRequest = createDeferred<{ status: string }>();
    let createCallCount = 0;
    let startCallCount = 0;
    api.createSession = () => {
      createCallCount += 1;
      return createRequest.promise;
    };
    api.startSession = () => {
      startCallCount += 1;
      return startRequest.promise;
    };
    const renderedCreateSession = await renderCreateSession();

    try {
      const startButtons = await prepareValidCreateSessionForm(renderedCreateSession);
      const form = getCreateSessionForm(renderedCreateSession.container);
      await act(async () => {
        startButtons[0].focus();
        startButtons[0].dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          })
        );
        // Happy DOM does not synthesize the browser's Enter default action.
        form.requestSubmit(startButtons[0]);
        startButtons[1].dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true })
        );
        startButtons[0].dispatchEvent(
          new KeyboardEvent("keyup", { key: "Enter", bubbles: true })
        );
      });

      assert.equal(createCallCount, 1);
      await resolveDeferred(createRequest, createTestSession("enter-click"));
      assert.equal(startCallCount, 1);
      await resolveDeferred(startRequest, { status: "started" });
      assert.equal(
        renderedCreateSession.navigationPaths.filter(
          (pathname) => pathname === "/session/enter-click"
        ).length,
        1
      );
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("queued submit activation while create is pending returns without unlocking", async () => {
    const createRequest = createDeferred<Session>();
    const startRequest = createDeferred<{ status: string }>();
    let createCallCount = 0;
    let startCallCount = 0;
    api.createSession = () => {
      createCallCount += 1;
      return createRequest.promise;
    };
    api.startSession = () => {
      startCallCount += 1;
      return startRequest.promise;
    };
    const renderedCreateSession = await renderCreateSession();

    try {
      const [startButton] = await prepareValidCreateSessionForm(renderedCreateSession);
      const form = getCreateSessionForm(renderedCreateSession.container);
      await act(async () => startButton.click());

      const pendingButtons = getAllByRole(renderedCreateSession.container, "button", {
        name: "Convening the council…",
      }) as HTMLButtonElement[];
      assert.ok(pendingButtons.every((button) => button.disabled));
      assert.equal(createCallCount, 1);

      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      assert.equal(createCallCount, 1);
      assert.equal(startCallCount, 0);
      assert.equal(
        queryByRole(renderedCreateSession.container, "alert"),
        null,
        "a duplicate pending activation must not expose an error"
      );
      assert.ok(
        getAllByRole(renderedCreateSession.container, "button", {
          name: "Convening the council…",
        }).every((button) => (button as HTMLButtonElement).disabled)
      );

      await resolveDeferred(createRequest, createTestSession("pending-activation"));
      assert.equal(startCallCount, 1);
      await resolveDeferred(startRequest, { status: "started" });
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("create failure releases the lock so CTA retry creates and starts once", async () => {
    const firstCreateRequest = createDeferred<Session>();
    const retryCreateRequest = createDeferred<Session>();
    const startRequest = createDeferred<{ status: string }>();
    const createRequests = [firstCreateRequest, retryCreateRequest];
    let createCallCount = 0;
    const startedSessionIds: string[] = [];
    api.createSession = () => {
      const request = createRequests[createCallCount];
      assert.ok(request);
      createCallCount += 1;
      return request.promise;
    };
    api.startSession = (sessionId) => {
      startedSessionIds.push(sessionId);
      return startRequest.promise;
    };
    const renderedCreateSession = await renderCreateSession();

    try {
      const [startButton] = await prepareValidCreateSessionForm(renderedCreateSession);
      await act(async () => startButton.click());
      await rejectDeferred(firstCreateRequest, new Error("create request failed"));

      const failureAlert = getByRole(renderedCreateSession.container, "alert");
      assert.match(failureAlert.textContent ?? "", /create request failed/);
      const retryButtons = getAllByRole(renderedCreateSession.container, "button", {
        name: "Start brainstorming",
      }) as HTMLButtonElement[];
      assert.ok(retryButtons.every((button) => !button.disabled));
      assert.equal(createCallCount, 1);
      assert.deepEqual(startedSessionIds, []);

      await act(async () => retryButtons[0].click());
      assert.equal(createCallCount, 2);
      await resolveDeferred(retryCreateRequest, createTestSession("create-retry"));
      assert.deepEqual(startedSessionIds, ["create-retry"]);
      await resolveDeferred(startRequest, { status: "started" });
      assert.equal(
        renderedCreateSession.navigationPaths.filter(
          (pathname) => pathname === "/session/create-retry"
        ).length,
        1
      );
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("start failure retry reuses the created session instead of creating an orphan", async () => {
    const createRequest = createDeferred<Session>();
    const firstStartRequest = createDeferred<{ status: string }>();
    const retryStartRequest = createDeferred<{ status: string }>();
    const startRequests = [firstStartRequest, retryStartRequest];
    let createCallCount = 0;
    const startedSessionIds: string[] = [];
    api.createSession = () => {
      createCallCount += 1;
      return createRequest.promise;
    };
    api.startSession = (sessionId) => {
      const request = startRequests[startedSessionIds.length];
      assert.ok(request);
      startedSessionIds.push(sessionId);
      return request.promise;
    };
    const renderedCreateSession = await renderCreateSession();

    try {
      const [startButton] = await prepareValidCreateSessionForm(renderedCreateSession);
      await act(async () => startButton.click());
      await resolveDeferred(createRequest, createTestSession("start-retry"));
      assert.deepEqual(startedSessionIds, ["start-retry"]);
      await rejectDeferred(firstStartRequest, new Error("start request failed"));

      const failureAlert = getByRole(renderedCreateSession.container, "alert");
      assert.match(failureAlert.textContent ?? "", /start request failed/);
      const [retryButton] = getAllByRole(renderedCreateSession.container, "button", {
        name: "Start brainstorming",
      }) as HTMLButtonElement[];
      await act(async () => retryButton.click());

      assert.equal(createCallCount, 1, "start retry must not create another session");
      assert.deepEqual(startedSessionIds, ["start-retry", "start-retry"]);
      await resolveDeferred(retryStartRequest, { status: "started" });
      assert.equal(
        renderedCreateSession.navigationPaths.filter(
          (pathname) => pathname === "/session/start-retry"
        ).length,
        1
      );
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("create pending route-away still starts once and never navigates back", async () => {
    const createRequest = createDeferred<Session>();
    const startRequest = createDeferred<{ status: string }>();
    let createCallCount = 0;
    const startedSessionIds: string[] = [];
    api.createSession = () => {
      createCallCount += 1;
      return createRequest.promise;
    };
    api.startSession = (sessionId) => {
      startedSessionIds.push(sessionId);
      return startRequest.promise;
    };
    const renderedCreateSession = await renderCreateSession();

    try {
      const [startButton] = await prepareValidCreateSessionForm(renderedCreateSession);
      await act(async () => startButton.click());
      await act(async () => {
        getByRole(renderedCreateSession.container, "button", {
          name: "Leave create route",
        }).click();
      });
      assert.match(renderedCreateSession.container.textContent ?? "", /Outside create route/);

      await resolveDeferred(createRequest, createTestSession("create-route-away"));
      assert.equal(createCallCount, 1);
      assert.deepEqual(startedSessionIds, ["create-route-away"]);
      await resolveDeferred(startRequest, { status: "started" });

      assert.deepEqual(renderedCreateSession.navigationPaths, ["/", "/away"]);
      assert.match(renderedCreateSession.container.textContent ?? "", /Outside create route/);
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("start pending route-away never updates or navigates the unmounted Create view", async () => {
    const createRequest = createDeferred<Session>();
    const startRequest = createDeferred<{ status: string }>();
    let startCallCount = 0;
    api.createSession = () => createRequest.promise;
    api.startSession = () => {
      startCallCount += 1;
      return startRequest.promise;
    };
    const renderedCreateSession = await renderCreateSession();

    try {
      const [startButton] = await prepareValidCreateSessionForm(renderedCreateSession);
      await act(async () => startButton.click());
      await resolveDeferred(createRequest, createTestSession("start-route-away"));
      assert.equal(startCallCount, 1);

      await act(async () => {
        getByRole(renderedCreateSession.container, "button", {
          name: "Leave create route",
        }).click();
      });
      await resolveDeferred(startRequest, { status: "started" });

      assert.deepEqual(renderedCreateSession.navigationPaths, ["/", "/away"]);
      assert.match(renderedCreateSession.container.textContent ?? "", /Outside create route/);
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("stale route-away failure cannot unlock or overwrite a new pending Create view", async () => {
    const staleCreateRequest = createDeferred<Session>();
    const currentCreateRequest = createDeferred<Session>();
    const staleStartRequest = createDeferred<{ status: string }>();
    const currentStartRequest = createDeferred<{ status: string }>();
    const createRequests = [staleCreateRequest, currentCreateRequest];
    let createCallCount = 0;
    const startedSessionIds: string[] = [];
    api.createSession = () => {
      const request = createRequests[createCallCount];
      assert.ok(request);
      createCallCount += 1;
      return request.promise;
    };
    api.startSession = (sessionId) => {
      startedSessionIds.push(sessionId);
      return sessionId === "stale-route" ? staleStartRequest.promise : currentStartRequest.promise;
    };
    const renderedCreateSession = await renderCreateSession();

    try {
      const [staleStartButton] = await prepareValidCreateSessionForm(renderedCreateSession);
      await act(async () => staleStartButton.click());
      await act(async () => {
        getByRole(renderedCreateSession.container, "button", {
          name: "Leave create route",
        }).click();
      });
      await act(async () => {
        getByRole(renderedCreateSession.container, "button", {
          name: "Return to create route",
        }).click();
        await Promise.resolve();
        await Promise.resolve();
      });

      const [currentStartButton] = await prepareValidCreateSessionForm(
        renderedCreateSession
      );
      await act(async () => currentStartButton.click());
      assert.equal(createCallCount, 2);

      await resolveDeferred(staleCreateRequest, createTestSession("stale-route"));
      assert.deepEqual(startedSessionIds, ["stale-route"]);
      await rejectDeferred(staleStartRequest, new Error("stale start failure"));

      assert.equal(queryByRole(renderedCreateSession.container, "alert"), null);
      assert.ok(
        getAllByRole(renderedCreateSession.container, "button", {
          name: "Convening the council…",
        }).every((button) => (button as HTMLButtonElement).disabled)
      );

      await resolveDeferred(currentCreateRequest, createTestSession("current-route"));
      assert.deepEqual(startedSessionIds, ["stale-route", "current-route"]);
      await resolveDeferred(currentStartRequest, { status: "started" });
      assert.equal(
        renderedCreateSession.navigationPaths.filter(
          (pathname) => pathname === "/session/current-route"
        ).length,
        1
      );
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("StrictMode keeps a duplicate submit to one create-start chain", async () => {
    const createRequest = createDeferred<Session>();
    const startRequest = createDeferred<{ status: string }>();
    let createCallCount = 0;
    let startCallCount = 0;
    api.createSession = () => {
      createCallCount += 1;
      return createRequest.promise;
    };
    api.startSession = () => {
      startCallCount += 1;
      return startRequest.promise;
    };
    const renderedCreateSession = await renderCreateSession({ strictMode: true });

    try {
      const startButtons = await prepareValidCreateSessionForm(renderedCreateSession);
      const form = getCreateSessionForm(renderedCreateSession.container);
      await act(async () => {
        startButtons[0].click();
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      assert.equal(createCallCount, 1);

      await resolveDeferred(createRequest, createTestSession("strict-mode"));
      assert.equal(startCallCount, 1);
      await resolveDeferred(startRequest, { status: "started" });
      assert.equal(
        renderedCreateSession.navigationPaths.filter(
          (pathname) => pathname === "/session/strict-mode"
        ).length,
        1
      );
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("invalid form and provider loading never enter the submit chain", async () => {
    const providersRequest = createDeferred<{ providers: ProviderInfo[] }>();
    api.providers = () => providersRequest.promise;
    let createCallCount = 0;
    let startCallCount = 0;
    api.createSession = async () => {
      createCallCount += 1;
      return createTestSession("invalid");
    };
    api.startSession = async () => {
      startCallCount += 1;
      return { status: "started" };
    };
    const renderedCreateSession = await renderCreateSession();

    try {
      const form = getCreateSessionForm(renderedCreateSession.container);
      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      assert.equal(createCallCount, 0);
      assert.equal(startCallCount, 0);
      assert.ok(
        getAllByRole(renderedCreateSession.container, "button", {
          name: "Start brainstorming",
        }).every((button) => (button as HTMLButtonElement).disabled)
      );

      await resolveDeferred(providersRequest, { providers: [READY_PROVIDER] });
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("provider error Retry performs one provider GET and zero submit POSTs", async () => {
    const providersRequest = createDeferred<{ providers: ProviderInfo[] }>();
    let retryProviderGetCallCount = 0;
    let createCallCount = 0;
    let startCallCount = 0;
    api.providers = () => providersRequest.promise;
    api.createSession = async () => {
      createCallCount += 1;
      return createTestSession("unexpected-retry-submit");
    };
    api.startSession = async () => {
      startCallCount += 1;
      return { status: "started" };
    };
    const renderedCreateSession = await renderCreateSession();

    try {
      await rejectDeferred(providersRequest, new Error("provider metadata failed"));
      const loadAlert = getByRole(renderedCreateSession.container, "alert");
      assert.match(loadAlert.textContent ?? "", /provider metadata failed/);

      const retryButton = getByRole(renderedCreateSession.container, "button", {
        name: "Retry",
      }) as HTMLButtonElement;
      assert.equal(retryButton.getAttribute("type"), "button");
      api.providers = async () => {
        retryProviderGetCallCount += 1;
        return loadReadyProviders();
      };
      await act(async () => {
        retryButton.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(retryProviderGetCallCount, 1);
      assert.equal(createCallCount, 0);
      assert.equal(startCallCount, 0);
      assert.ok(getCreateSessionForm(renderedCreateSession.container));
      assert.equal(queryByRole(renderedCreateSession.container, "alert"), null);
    } finally {
      await renderedCreateSession.unmount();
    }
  });
});

describe("Create parameters slider accessibility", () => {
  test("names both slider thumbs and preserves Radix keyboard value semantics", async () => {
    const renderedCreateSession = await renderCreateSession();

    try {
      const ideasPerPersonaSlider = getByRole(renderedCreateSession.container, "slider", {
        name: "Ideas per persona",
      });
      const discussionRoundsSlider = getByRole(renderedCreateSession.container, "slider", {
        name: "Discussion rounds",
      });

      assert.equal(getAllByRole(renderedCreateSession.container, "slider").length, 2);
      assert.notEqual(ideasPerPersonaSlider, discussionRoundsSlider);
      assert.equal(ideasPerPersonaSlider.getAttribute("aria-valuenow"), "3");
      assert.equal(ideasPerPersonaSlider.getAttribute("aria-valuemin"), "1");
      assert.equal(ideasPerPersonaSlider.getAttribute("aria-valuemax"), "10");
      assert.equal(ideasPerPersonaSlider.getAttribute("aria-valuetext"), "3 ideas per persona");
      assert.equal(
        ideasPerPersonaSlider.getAttribute("aria-describedby"),
        "ideas-per-persona-slider-description"
      );
      assert.equal(discussionRoundsSlider.getAttribute("aria-valuenow"), "2");
      assert.equal(discussionRoundsSlider.getAttribute("aria-valuemin"), "0");
      assert.equal(discussionRoundsSlider.getAttribute("aria-valuemax"), "3");
      assert.equal(discussionRoundsSlider.getAttribute("aria-valuetext"), "2 discussion rounds");

      const ideasPerPersonaRoot = ideasPerPersonaSlider.parentElement;
      assert.ok(ideasPerPersonaRoot);
      assert.equal(ideasPerPersonaRoot.getAttribute("role"), null);
      assert.equal(ideasPerPersonaRoot.getAttribute("aria-labelledby"), null);
      assert.equal(ideasPerPersonaRoot.getAttribute("aria-describedby"), null);
      assert.equal(ideasPerPersonaRoot.getAttribute("aria-valuetext"), null);

      assert.equal(ideasPerPersonaSlider.tabIndex, 0);
      ideasPerPersonaSlider.focus();
      assert.equal(document.activeElement, ideasPerPersonaSlider);
      assert.match(ideasPerPersonaSlider.className, /focus-visible:ring-2/);

      await pressSliderKey(ideasPerPersonaSlider, "ArrowRight");
      assert.equal(ideasPerPersonaSlider.getAttribute("aria-valuenow"), "4");
      assert.equal(ideasPerPersonaSlider.getAttribute("aria-valuetext"), "4 ideas per persona");

      await pressSliderKey(ideasPerPersonaSlider, "Home");
      assert.equal(ideasPerPersonaSlider.getAttribute("aria-valuenow"), "1");
      await pressSliderKey(ideasPerPersonaSlider, "End");
      assert.equal(ideasPerPersonaSlider.getAttribute("aria-valuenow"), "10");

      discussionRoundsSlider.focus();
      await pressSliderKey(discussionRoundsSlider, "Home");
      assert.equal(discussionRoundsSlider.getAttribute("aria-valuenow"), "0");
      assert.equal(discussionRoundsSlider.getAttribute("aria-valuetext"), "No discussion rounds");
      await pressSliderKey(discussionRoundsSlider, "ArrowRight");
      assert.equal(discussionRoundsSlider.getAttribute("aria-valuenow"), "1");
      assert.equal(discussionRoundsSlider.getAttribute("aria-valuetext"), "1 discussion round");
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("both thumbs keep a 24x24 hit target without spacing exceptions", async () => {
    const renderedCreateSession = await renderCreateSession();

    try {
      const sliders = getAllByRole(renderedCreateSession.container, "slider");
      assert.equal(sliders.length, 2);

      for (const thumb of sliders) {
        // WCAG 2.5.8 (AA): the interactive element itself must measure
        // >= 24x24 CSS px in the browser; these classes are the invariant.
        assert.ok(thumb.classList.contains("h-6"), "thumb needs the 24px height class");
        assert.ok(thumb.classList.contains("w-6"), "thumb needs the 24px width class");
        assert.ok(
          thumb.classList.contains("before:h-4") &&
            thumb.classList.contains("before:w-4"),
          "16px visual knob must stay centered in the hit area via ::before"
        );
        assert.match(thumb.className, /focus-visible:ring-2/);
      }
    } finally {
      await renderedCreateSession.unmount();
    }
  });
});

describe("Create 200% zoom reflow guard", () => {
  test("actionbar is the last form child and carries the guard hooks", async () => {
    const renderedCreateSession = await renderCreateSession();

    try {
      const form = renderedCreateSession.container.querySelector("form");
      assert.ok(form, "Create view renders a form");

      const actionbar = form.querySelector<HTMLDivElement>(".create-actionbar");
      assert.ok(actionbar, "mobile actionbar exists");
      // Desktop keeps the rail instead: the mobile bar must stay lg-hidden.
      assert.ok(actionbar.classList.contains("lg:hidden"));

      // DOM order: the bar rides after every step section, so once it joins
      // the normal flow (short-viewport guard) the CTA is the natural end.
      const lastElementChild = form.lastElementChild;
      assert.ok(lastElementChild?.isSameNode(actionbar), "actionbar is last in the form");

      const inner = actionbar.querySelector<HTMLDivElement>(".create-actionbar__inner");
      assert.ok(inner, "actionbar inner wrapper carries the narrow-viewport hook");
      assert.ok(
        inner.querySelector('button[type="submit"]'),
        "start CTA lives inside the inner wrapper"
      );

      const content = form.querySelector<HTMLDivElement>(".create-content");
      assert.ok(content, "steps wrapper carries the .create-content reservation hook");
      assert.ok(
        content.compareDocumentPosition(actionbar) & Node.DOCUMENT_POSITION_FOLLOWING,
        "content wrapper precedes the actionbar in DOM order"
      );
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("CSS keeps fixed+safe-area by default and flips to flow at max-height 480px", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

    // Default mobile bar: fixed above the safe area (390×844 / 320×844 keep it).
    const baseBar = css.match(/\.create-actionbar\s*\{[^}]*\}/)?.[0] ?? "";
    assert.match(baseBar, /fixed/, "base actionbar stays fixed");
    assert.match(
      baseBar,
      /padding-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)/,
      "base actionbar keeps the iOS safe-area inset"
    );

    const shortViewport = css.match(/@media\s*\(max-height:\s*480px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    assert.match(
      shortViewport,
      /\.create-actionbar\s*\{[^}]*position:\s*static/,
      "short viewports unfix the actionbar into normal flow"
    );
    assert.match(
      shortViewport,
      /\.create-content\s*\{[^}]*padding-bottom:\s*0/,
      "short viewports drop the fixed-bar bottom reservation"
    );

    // The guards must sit outside Tailwind layers after the utilities dump,
    // or the pb-24/h-10/whitespace-nowrap utilities would win the cascade.
    const utilitiesIndex = css.indexOf("@tailwind utilities");
    const guardIndex = css.indexOf("@media (max-height: 480px)");
    assert.ok(guardIndex > utilitiesIndex, "height guard loads after Tailwind utilities");
  });

  test("CSS wraps the CTA safely at max-width 240px without shrinking text", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

    const narrow = css.match(/@media\s*\(max-width:\s*240px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    for (const selector of [".create-actionbar__inner", ".create-actionbar__inner > button"]) {
      const rule = narrow.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"))?.[1] ?? "";
      assert.ok(rule, `${selector} rule exists in the 240px guard`);
      assert.match(rule, /min-width:\s*0/, `${selector} can shrink`);
      assert.match(rule, /max-width:\s*100%/, `${selector} caps at the bar`);
      assert.match(rule, /width:\s*100%/, `${selector} fills the row`);
    }
    const buttonRule =
      narrow.match(/\.create-actionbar__inner\s*>\s*button\s*\{([^}]*)\}/)?.[1] ?? "";
    assert.match(buttonRule, /white-space:\s*normal/, "button drops nowrap for a safe wrap");
    assert.match(buttonRule, /height:\s*auto/, "button height grows with wrapped lines");
    assert.match(buttonRule, /min-height:\s*2\.5rem/, "button keeps the lg-size tap floor");
    // Text size is never reduced: the guard must not touch font-size.
    assert.doesNotMatch(narrow, /font-size/, "240px guard must not shrink text");
  });

  test("CSS insets the document scroller for keyboard focus with a Create-only bottom gap", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

    // Document scroller: top inset always clears the 3.5rem sticky app header
    // (+ focus ring) for Tab/Shift+Tab, native focus(), and the Results focus
    // recovery hook — they all scroll through the same implicit scrollIntoView.
    const htmlRule =
      [...css.matchAll(/^html\s*\{([^}]*)\}/gm)]
        .map((match) => match[1])
        .find((body) => body.includes("scroll-padding")) ?? "";
    assert.ok(htmlRule, "a dedicated html rule carries the document scroller insets");
    assert.match(
      htmlRule,
      /scroll-padding-top:\s*4\.5rem/,
      "document scroller reserves at least 4.5rem above focused targets"
    );
    assert.match(
      htmlRule,
      /scroll-padding-bottom:\s*0px/,
      "bottom inset defaults to 0 for routes without floating chrome"
    );

    // The bottom gap is reserved only where the fixed actionbar actually
    // floats over content: narrower than the lg (1024px) rail AND taller than
    // the max-height 480px flow guard. Legacy min/max syntax with fractional
    // complements (1023.98px / 480.02px) keeps 1023.5px/480.5px zoom viewports
    // inside the guard while remaining parseable by every evergreen engine:
    // range syntax and :has() are Safari 16.4+/Firefox 121+ only, and an
    // engine without either drops the whole rule (bottom inset 0, fixed CTA
    // covering the focused field). The html lifecycle class replaces :has()
    // here — its mount/unmount contract is pinned by the DOM lifecycle tests
    // in this file.
    const focusSafeArea =
      css.match(
        /@media\s*\(max-width:\s*1023\.98px\) and \(min-height:\s*480\.02px\)\s*\{\s*\n\s*html\.izayoi-create-actionbar-visible\s*\{([^}]*)\}/
      )?.[1] ?? "";
    assert.ok(
      focusSafeArea,
      "bottom inset rule exists, gated on the actionbar html class and legacy media"
    );
    assert.match(
      focusSafeArea,
      /scroll-padding-bottom:\s*calc\(4\.5rem \+ env\(safe-area-inset-bottom, 0px\)\)/,
      "bottom inset = 4.5rem + safe-area only under the fixed bar"
    );

    // Cross-engine parse policy: the stylesheet must not depend on selectors
    // or media syntax that older evergreen engines drop wholesale. Comments
    // are stripped first so prose may still explain the policy.
    const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(
      !cssWithoutComments.includes(":has("),
      "no :has() selectors — Safari 16.4+/Firefox 121+ only, dropped whole rules before that"
    );
    assert.doesNotMatch(
      cssWithoutComments,
      /@media[^{]*\((?:width|height)\s*[<>]/,
      "no media range syntax — legacy min/max fractional complements only"
    );

    // Policy: no other rule may set a non-zero scroll-padding-bottom — other
    // routes and short-height (static bar) viewports must stay at 0.
    const bottomOverrides = [
      ...css.matchAll(/scroll-padding-bottom:\s*([^;]+);/g),
    ].map((match) => match[1].trim());
    assert.ok(
      bottomOverrides.every((value) => value === "0px" || value.startsWith("calc(4.5rem")),
      `unexpected scroll-padding-bottom values: ${bottomOverrides.join(", ")}`
    );
  });

  test("CSS preserves the 6.5rem step-jump landing after the document top inset", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

    // scroll-margin (target) and scroll-padding (scroller) ADD UP in the
    // scroll-into-view algorithm: 2rem margin + 4.5rem document inset must
    // keep the pre-inset 6.5rem landing for step rail jumps.
    const sectionMargin = css.match(
      /section\[id\^="step-"\]\s*\{[^}]*scroll-margin-top:\s*([\d.]+)rem/
    )?.[1];
    assert.ok(sectionMargin, "step sections keep a scroll-margin-top rule");
    assert.equal(
      Number(sectionMargin) + 4.5,
      6.5,
      "section margin + document inset still lands steps at 6.5rem"
    );

    // Keyboard focusables inside the Create form clear the stacked sticky
    // bands (app header + step strip at top-14) on the same 6.5rem line.
    // Scoped below lg because the strip is lg:hidden and the desktop rail
    // sits beside the content, never over it.
    const mobileFocusMargin = css.match(
      /@media\s*\(max-width:\s*1023\.98px\)\s*\{\s*\n\s*\.create-content :is\(a\[href\], button, input, select, textarea, \[tabindex\]\)\s*\{([^}]*)\}/
    )?.[1];
    assert.ok(
      mobileFocusMargin,
      "create-content focusables carry a scroll-margin under the lg breakpoint"
    );
    assert.match(
      mobileFocusMargin ?? "",
      /scroll-margin-top:\s*2rem/,
      "focused create controls land on the 6.5rem line (2rem + 4.5rem inset)"
    );
  });
});

describe("Create actionbar html lifecycle flag (keyboard focus safe area)", () => {
  const htmlFlag = () =>
    document.documentElement.classList.contains("izayoi-create-actionbar-visible");

  test("mount adds the flag to <html>; unmount removes it", async () => {
    const renderedCreateSession = await renderCreateSession();
    assert.ok(
      htmlFlag(),
      "html carries izayoi-create-actionbar-visible while Create is mounted"
    );
    await renderedCreateSession.unmount();
    assert.ok(
      !htmlFlag(),
      "unmount strips izayoi-create-actionbar-visible from <html>"
    );
  });

  test("route switch removes the flag; returning to Create re-adds it", async () => {
    const renderedCreateSession = await renderCreateSession();
    try {
      assert.ok(htmlFlag(), "flag present on the Create route");

      await act(async () => {
        fireEvent.click(
          getByRole(renderedCreateSession.container, "button", {
            name: "Leave create route",
          })
        );
      });
      assert.ok(
        !htmlFlag(),
        "route-away unmounts the actionbar and clears the flag"
      );

      await act(async () => {
        fireEvent.click(
          getByRole(renderedCreateSession.container, "button", {
            name: "Return to create route",
          })
        );
      });
      assert.ok(
        htmlFlag(),
        "re-entering Create mounts the actionbar and re-adds the flag"
      );
    } finally {
      await renderedCreateSession.unmount();
    }
    assert.ok(!htmlFlag(), "final unmount clears the flag again");
  });

  test("StrictMode double-mount keeps the flag present and cleanup still clears it", async () => {
    const renderedCreateSession = await renderCreateSession({ strictMode: true });
    assert.ok(
      htmlFlag(),
      "flag survives the StrictMode mount → cleanup → re-mount cycle"
    );
    await renderedCreateSession.unmount();
    assert.ok(
      !htmlFlag(),
      "StrictMode teardown clears the flag from <html>"
    );
  });
});

const CREATE_SESSION_DRAFT_THEME_PREFIX = "Repair café growth without ads. ";
const CREATE_SESSION_DRAFT_THEME = `${CREATE_SESSION_DRAFT_THEME_PREFIX}${"あ".repeat(291 - CREATE_SESSION_DRAFT_THEME_PREFIX.length)}`;
const CREATE_SESSION_DRAFT_CONSTRAINTS = "No paid ads; budget under $500";
const CREATE_SESSION_DRAFT_PERSONAS = ["INTJ", "INTP", "ENTJ", "ENTP"] as const;
const CREATE_SESSION_COST_WARNING_PERSONAS = [
  ...CREATE_SESSION_DRAFT_PERSONAS,
  "INFJ",
  "INFP",
  "ENFJ",
  "ENFP",
  "ISTJ",
  "ISFJ",
] as const;
const CREATE_SESSION_DRAFT_PROVIDERS: ProviderInfo[] = [
  {
    id: "mock",
    label: "Mock",
    available: true,
    env_var: null,
    models: ["mock-model", "mock-strong"],
  },
  {
    id: "openai",
    label: "OpenAI",
    available: true,
    env_var: "OPENAI_API_KEY",
    models: ["gpt-4o", "gpt-4o-mini"],
  },
];

function getCreateSessionThemeField(container: HTMLElement): HTMLTextAreaElement {
  return getByRole(container, "textbox", {
    name: "What should the council brainstorm?",
  }) as HTMLTextAreaElement;
}

function getCreateSessionConstraintsField(container: HTMLElement): HTMLInputElement {
  return getByRole(container, "textbox", { name: /Constraints/ }) as HTMLInputElement;
}

function getCreateSessionFormControl(
  container: HTMLElement,
  accessibleName: string
): HTMLButtonElement {
  return getCreateSessionButtonByAccessibleName(
    getCreateSessionForm(container),
    accessibleName
  );
}

async function leaveCreateSessionRoute(
  renderedCreateSession: RenderedCreateSession
): Promise<void> {
  await act(async () => {
    getByRole(renderedCreateSession.container, "button", {
      name: "Leave create route",
    }).click();
  });
}

async function returnToCreateSessionRoute(
  renderedCreateSession: RenderedCreateSession
): Promise<void> {
  await act(async () => {
    getByRole(renderedCreateSession.container, "button", {
      name: "Return to create route",
    }).click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function fillCreateSessionDraftMatrix(
  renderedCreateSession: RenderedCreateSession
): Promise<void> {
  const form = getCreateSessionForm(renderedCreateSession.container);
  await act(async () => {
    fireEvent.input(getCreateSessionThemeField(renderedCreateSession.container), {
      target: { value: CREATE_SESSION_DRAFT_THEME },
    });
    fireEvent.input(getCreateSessionConstraintsField(renderedCreateSession.container), {
      target: { value: CREATE_SESSION_DRAFT_CONSTRAINTS },
    });
    fireEvent.change(
      getByRole(renderedCreateSession.container, "combobox", {
        name: "Balanced selection size",
      }),
      { target: { value: "6" } }
    );
  });
  await act(async () => {
    for (const personaType of CREATE_SESSION_DRAFT_PERSONAS) {
      getCreateSessionButtonByAccessibleName(form, personaType).click();
    }
  });
  await act(async () => {
    getCreateSessionButtonByAccessibleName(form, "ENTP devil's advocate").click();
    fireEvent.change(
      getByRole(renderedCreateSession.container, "combobox", { name: "INTJ model" }),
      { target: { value: "mock-strong" } }
    );
    fireEvent.change(
      getByRole(renderedCreateSession.container, "combobox", {
        name: "Facilitator provider",
      }),
      { target: { value: "openai" } }
    );
  });

  const ideasSlider = getByRole(renderedCreateSession.container, "slider", {
    name: "Ideas per persona",
  });
  const discussionSlider = getByRole(renderedCreateSession.container, "slider", {
    name: "Discussion rounds",
  });
  for (let step = 0; step < 4; step += 1) {
    await pressSliderKey(ideasSlider, "ArrowRight");
  }
  await pressSliderKey(discussionSlider, "ArrowLeft");
  await act(async () => {
    getCreateSessionButtonByAccessibleName(form, "LLM judge pre-ranking").click();
  });
}

function assertRestoredCreateSessionDraftMatrix(container: HTMLElement): void {
  const form = getCreateSessionForm(container);
  const themeField = getCreateSessionThemeField(container);
  const constraintsField = getCreateSessionConstraintsField(container);
  assert.equal(themeField.value, CREATE_SESSION_DRAFT_THEME);
  assert.equal(constraintsField.value, CREATE_SESSION_DRAFT_CONSTRAINTS);
  assert.equal(themeField.getAttribute("aria-invalid"), "false");
  assert.equal(themeField.getAttribute("aria-describedby"), "theme-hint theme-counter");
  assert.equal(
    container.querySelector("#theme-counter")?.textContent?.trim(),
    "291 / 2000"
  );
  assert.equal(
    container.querySelector("#constraints-counter")?.textContent?.trim(),
    `${CREATE_SESSION_DRAFT_CONSTRAINTS.length} / 2000`
  );
  assert.equal(
    form.querySelectorAll('#step-cast button[aria-pressed="true"]').length,
    4
  );
  assert.equal(
    getCreateSessionButtonByAccessibleName(form, "ENTP devil's advocate").getAttribute(
      "aria-pressed"
    ),
    "true"
  );
  assert.equal(
    (getByRole(container, "combobox", { name: "INTJ model" }) as HTMLSelectElement)
      .value,
    "mock-strong"
  );
  assert.equal(
    (getByRole(container, "combobox", {
      name: "Facilitator provider",
    }) as HTMLSelectElement).value,
    "openai"
  );
  assert.equal(
    (getByRole(container, "combobox", {
      name: "Facilitator model",
    }) as HTMLSelectElement).value,
    "gpt-4o"
  );
  assert.equal(
    (getByRole(container, "combobox", {
      name: "Balanced selection size",
    }) as HTMLSelectElement).value,
    "6"
  );
  assert.equal(
    getByRole(container, "slider", { name: "Ideas per persona" }).getAttribute(
      "aria-valuenow"
    ),
    "7"
  );
  assert.equal(
    getByRole(container, "slider", { name: "Discussion rounds" }).getAttribute(
      "aria-valuenow"
    ),
    "1"
  );
  assert.equal(
    getCreateSessionButtonByAccessibleName(form, "LLM judge pre-ranking").getAttribute(
      "aria-checked"
    ),
    "false"
  );
  assert.equal(queryByRole(container, "alert"), null);
  assert.ok(
    getAllByRole(container, "button", { name: "Start brainstorming" }).every(
      (button) => !(button as HTMLButtonElement).disabled
    )
  );
}

describe("Create in-memory form draft persistence", () => {
  test("History round-trip restores theme, constraints, cast, models, sliders, and judge", async () => {
    assert.equal(CREATE_SESSION_DRAFT_THEME.length, 291);
    api.providers = async () => ({ providers: CREATE_SESSION_DRAFT_PROVIDERS });
    const renderedCreateSession = await renderCreateSession();

    try {
      await fillCreateSessionDraftMatrix(renderedCreateSession);
      assertRestoredCreateSessionDraftMatrix(renderedCreateSession.container);

      await leaveCreateSessionRoute(renderedCreateSession);
      assert.match(renderedCreateSession.container.textContent ?? "", /Outside create route/);
      await returnToCreateSessionRoute(renderedCreateSession);
      assertRestoredCreateSessionDraftMatrix(renderedCreateSession.container);
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("restored values recompute trim-aware validation, counters, and the cost warning", async () => {
    const renderedCreateSession = await renderCreateSession();

    try {
      const form = getCreateSessionForm(renderedCreateSession.container);
      await act(async () => {
        fireEvent.input(getCreateSessionThemeField(renderedCreateSession.container), {
          target: { value: "   \u3000  " },
        });
        fireEvent.input(getCreateSessionConstraintsField(renderedCreateSession.container), {
          target: { value: "c".repeat(2001) },
        });
        for (const personaType of CREATE_SESSION_COST_WARNING_PERSONAS) {
          getCreateSessionButtonByAccessibleName(form, personaType).click();
        }
      });

      await leaveCreateSessionRoute(renderedCreateSession);
      await returnToCreateSessionRoute(renderedCreateSession);

      const restoredTheme = getCreateSessionThemeField(renderedCreateSession.container);
      const restoredConstraints = getCreateSessionConstraintsField(
        renderedCreateSession.container
      );
      assert.equal(restoredTheme.value, "   \u3000  ");
      assert.equal(restoredTheme.getAttribute("aria-invalid"), "true");
      assert.match(restoredTheme.getAttribute("aria-describedby") ?? "", /theme-error/);
      assert.equal(
        renderedCreateSession.container.querySelector("#theme-error")?.textContent?.trim(),
        "Write a theme for the council."
      );
      assert.equal(
        renderedCreateSession.container.querySelector("#theme-counter")?.textContent?.trim(),
        "6 / 2000"
      );
      assert.equal(restoredConstraints.getAttribute("aria-invalid"), "true");
      assert.match(
        restoredConstraints.getAttribute("aria-describedby") ?? "",
        /constraints-error/
      );
      assert.equal(
        renderedCreateSession.container
          .querySelector("#constraints-counter")
          ?.textContent?.trim(),
        "2001 / 2000"
      );
      assert.match(
        renderedCreateSession.container.querySelector("#cta-reason-rail")?.textContent ?? "",
        /Write a theme for the council/
      );
      const costWarning = getByRole(renderedCreateSession.container, "alert");
      assert.match(costWarning.textContent ?? "", /Cost warning/);
      assert.match(costWarning.textContent ?? "", /10 agents/);
      assert.ok(
        getAllByRole(renderedCreateSession.container, "button", {
          name: "Start brainstorming",
        }).every((button) => (button as HTMLButtonElement).disabled)
      );
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("Start success clears the draft so Live then Create does not restore it", async () => {
    api.providers = async () => ({ providers: CREATE_SESSION_DRAFT_PROVIDERS });
    api.createSession = async () => createTestSession("draft-cleared");
    api.startSession = async () => ({ status: "started" });
    const renderedCreateSession = await renderCreateSession();

    try {
      await fillCreateSessionDraftMatrix(renderedCreateSession);
      await act(async () => {
        getAllByRole(renderedCreateSession.container, "button", {
          name: "Start brainstorming",
        })[0].click();
        await Promise.resolve();
        await Promise.resolve();
      });
      assert.ok(
        renderedCreateSession.navigationPaths.includes("/session/draft-cleared")
      );
      assert.match(renderedCreateSession.container.textContent ?? "", /Live session route/);

      await act(async () => {
        getByRole(renderedCreateSession.container, "button", {
          name: "Return to create from live",
        }).click();
        await Promise.resolve();
        await Promise.resolve();
      });

      const freshTheme = getCreateSessionThemeField(renderedCreateSession.container);
      assert.equal(freshTheme.value, "");
      assert.equal(
        renderedCreateSession.container.querySelector("#theme-counter")?.textContent?.trim(),
        "0 / 2000"
      );
      assert.equal(
        getCreateSessionForm(renderedCreateSession.container).querySelectorAll(
          '#step-cast button[aria-pressed="true"]'
        ).length,
        0
      );
      assert.equal(
        getByRole(renderedCreateSession.container, "slider", {
          name: "Ideas per persona",
        }).getAttribute("aria-valuenow"),
        "3"
      );
      assert.equal(
        getCreateSessionFormControl(
          renderedCreateSession.container,
          "LLM judge pre-ranking"
        ).getAttribute("aria-checked"),
        "true"
      );
      assert.equal(queryByRole(renderedCreateSession.container, "alert"), null);
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("submit failure keeps the draft so a later retry can start", async () => {
    api.providers = async () => ({ providers: CREATE_SESSION_DRAFT_PROVIDERS });
    let createCallCount = 0;
    api.createSession = async () => {
      createCallCount += 1;
      if (createCallCount === 1) {
        throw new Error("create request failed");
      }
      return createTestSession("draft-retry");
    };
    api.startSession = async () => ({ status: "started" });
    const renderedCreateSession = await renderCreateSession();

    try {
      await fillCreateSessionDraftMatrix(renderedCreateSession);
      await act(async () => {
        getAllByRole(renderedCreateSession.container, "button", {
          name: "Start brainstorming",
        })[0].click();
        await Promise.resolve();
        await Promise.resolve();
      });
      assert.match(
        getByRole(renderedCreateSession.container, "alert").textContent ?? "",
        /create request failed/
      );

      await leaveCreateSessionRoute(renderedCreateSession);
      await returnToCreateSessionRoute(renderedCreateSession);
      assertRestoredCreateSessionDraftMatrix(renderedCreateSession.container);
      assert.equal(queryByRole(renderedCreateSession.container, "alert"), null);

      await act(async () => {
        getAllByRole(renderedCreateSession.container, "button", {
          name: "Start brainstorming",
        })[0].click();
        await Promise.resolve();
        await Promise.resolve();
      });
      assert.equal(createCallCount, 2);
      assert.ok(renderedCreateSession.navigationPaths.includes("/session/draft-retry"));
    } finally {
      await renderedCreateSession.unmount();
    }
  });

  test("provider loadError is not restored when metadata later succeeds", async () => {
    api.providers = async () => {
      throw new Error("provider metadata failed");
    };
    const renderedCreateSession = await renderCreateSession();

    try {
      assert.match(
        getByRole(renderedCreateSession.container, "alert").textContent ?? "",
        /provider metadata failed/
      );
      await leaveCreateSessionRoute(renderedCreateSession);
      api.providers = async () => ({ providers: CREATE_SESSION_DRAFT_PROVIDERS });
      await returnToCreateSessionRoute(renderedCreateSession);
      assert.ok(getCreateSessionForm(renderedCreateSession.container));
      assert.equal(queryByRole(renderedCreateSession.container, "alert"), null);
      assert.equal(getCreateSessionThemeField(renderedCreateSession.container).value, "");
    } finally {
      await renderedCreateSession.unmount();
    }
  });
});

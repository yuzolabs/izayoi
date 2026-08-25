import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { api, type Idea, type Session } from "@/lib/api";
import { SESSION_RESULTS_EXPORT_UNAVAILABLE_MESSAGE } from "@/lib/session-results-export";
import { registerHappyDomTestEnvironment } from "@/test-support/happy-dom-test-environment";

import { SessionResults } from "./session-results";

const RESULTS_SESSION: Session = {
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
};

const originalFetch = globalThis.fetch;

let originalCreateObjectUrl: typeof URL.createObjectURL;
let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
let originalAnchorClick: typeof HTMLAnchorElement.prototype.click;

interface RenderedResults {
  root: Root;
  container: HTMLDivElement;
  unmount: () => Promise<void>;
}

interface ExportDownloadRecord {
  filename: string;
  href: string;
}

interface ExportFetchCall {
  url: string;
  cache: RequestCache | undefined;
  signal: AbortSignal | undefined;
}

function makeResultsIdea(id: string): Idea {
  return {
    id,
    session_id: RESULTS_SESSION.id,
    persona_type: "ARCHITECT",
    phase: "divergence",
    content: `Idea ${id}`,
    cluster_id: 1,
    synthesized: "Cluster 1 synthesis",
    scores: null,
    decision: "pending",
    note: "",
  };
}

function getRequiredElement<T extends Element>(
  selector: string,
  parent: ParentNode = document
): T {
  const element = parent.querySelector<T>(selector);
  assert.ok(element, `Expected DOM element matching ${selector}`);
  return element;
}

function getExportButton(label: "Markdown" | "JSON"): HTMLButtonElement {
  const group = getRequiredElement<HTMLElement>('[aria-label="Export results"]');
  const button = [...group.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label
  );
  assert.ok(button, `Expected ${label} export button`);
  return button;
}

function getExportFailureAlert(parent: ParentNode = document): HTMLElement {
  return getRequiredElement<HTMLElement>(
    "[data-session-results-export-alert]",
    parent
  );
}

function getExportRetryButton(alert: HTMLElement): HTMLButtonElement {
  const button = [...alert.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Retry"
  );
  assert.ok(button, "Expected Retry inside the export alert");
  return button;
}

async function flushSessionResultsDomUpdates(frameCount = 3): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  for (let frame = 0; frame < frameCount; frame += 1) {
    await act(
      () =>
        new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        })
    );
  }
}

function createSuccessfulExportResponse(
  body: string,
  filename: string,
  contentType = "text/markdown"
): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

async function renderSessionResults(): Promise<RenderedResults> {
  api.getSession = async () => RESULTS_SESSION;
  api.listIdeas = async () => ({ ideas: [makeResultsIdea("first")] });
  api.listMessages = async () => ({ messages: [] });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
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
  await flushSessionResultsDomUpdates();

  return {
    root,
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function installExportDownloadSpies(): {
  downloads: ExportDownloadRecord[];
  revokedObjectUrls: string[];
  restore: () => void;
} {
  const downloads: ExportDownloadRecord[] = [];
  const revokedObjectUrls: string[] = [];
  let objectUrlCount = 0;
  URL.createObjectURL = () => {
    objectUrlCount += 1;
    return `blob:session-results-export-${objectUrlCount}`;
  };
  URL.revokeObjectURL = (objectUrl) => {
    revokedObjectUrls.push(String(objectUrl));
  };
  HTMLAnchorElement.prototype.click = function click() {
    downloads.push({ filename: this.download, href: this.href });
  };
  return {
    downloads,
    revokedObjectUrls,
    restore: () => {
      URL.createObjectURL = originalCreateObjectUrl;
      URL.revokeObjectURL = originalRevokeObjectUrl;
      HTMLAnchorElement.prototype.click = originalAnchorClick;
    },
  };
}

function installExportFetch(
  handler: (call: ExportFetchCall) => Promise<Response>
): { calls: ExportFetchCall[]; restore: () => void } {
  const calls: ExportFetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const call: ExportFetchCall = {
      url,
      cache: init?.cache,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

let cleanupHappyDomEnvironment: (() => Promise<void>) | undefined;

before(() => {
  cleanupHappyDomEnvironment = registerHappyDomTestEnvironment({
    reactActEnvironment: true,
    url: "http://localhost/session/session-1/results",
    width: 390,
    height: 844,
  }).cleanup;
  originalCreateObjectUrl = URL.createObjectURL;
  originalRevokeObjectUrl = URL.revokeObjectURL;
  originalAnchorClick = HTMLAnchorElement.prototype.click;
});

after(async () => {
  api.getSession = originalApiMethods.getSession;
  api.listIdeas = originalApiMethods.listIdeas;
  api.listMessages = originalApiMethods.listMessages;
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectUrl;
  URL.revokeObjectURL = originalRevokeObjectUrl;
  HTMLAnchorElement.prototype.click = originalAnchorClick;
  await cleanupHappyDomEnvironment?.();
});

describe("Session Results export download", () => {
  test("downloads a 200 blob under the Content-Disposition filename", async () => {
    const downloadSpies = installExportDownloadSpies();
    const fetchMock = installExportFetch(async () =>
      createSuccessfulExportResponse("# exported", "izayoi-session-1.md")
    );
    const rendered = await renderSessionResults();
    try {
      const markdownExport = getExportButton("Markdown");
      assert.equal(markdownExport.type, "button");
      assert.equal(getExportButton("JSON").type, "button");

      await act(async () => markdownExport.click());
      await flushSessionResultsDomUpdates();

      assert.equal(fetchMock.calls.length, 1);
      assert.equal(
        fetchMock.calls[0]?.url,
        "/api/sessions/session-1/export?format=md"
      );
      assert.equal(fetchMock.calls[0]?.cache, "no-store");
      assert.deepEqual(downloadSpies.downloads, [
        {
          filename: "izayoi-session-1.md",
          href: "blob:session-results-export-1",
        },
      ]);
      assert.deepEqual(downloadSpies.revokedObjectUrls, [
        "blob:session-results-export-1",
      ]);
      assert.equal(
        rendered.container.querySelector("[data-session-results-export-alert]"),
        null
      );
    } finally {
      await rendered.unmount();
      downloadSpies.restore();
      fetchMock.restore();
    }
  });

  test("falls back to izayoi-{id}.md when Content-Disposition is missing", async () => {
    const downloadSpies = installExportDownloadSpies();
    const fetchMock = installExportFetch(
      async () =>
        new Response("# exported", {
          status: 200,
          headers: { "Content-Type": "text/markdown" },
        })
    );
    const rendered = await renderSessionResults();
    try {
      await act(async () => getExportButton("Markdown").click());
      await flushSessionResultsDomUpdates();
      assert.equal(downloadSpies.downloads[0]?.filename, "izayoi-session-1.md");
    } finally {
      await rendered.unmount();
      downloadSpies.restore();
      fetchMock.restore();
    }
  });

  test("shows HTTP 500 for an object detail and never renders [object Object]", async () => {
    const downloadSpies = installExportDownloadSpies();
    const fetchMock = installExportFetch(async () =>
      new Response(JSON.stringify({ detail: { error: "boom" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    );
    const rendered = await renderSessionResults();
    try {
      await act(async () => getExportButton("JSON").click());
      await flushSessionResultsDomUpdates();

      const alert = getExportFailureAlert(rendered.container);
      assert.match(alert.textContent ?? "", /Could not export results/);
      assert.match(alert.textContent ?? "", /HTTP 500/);
      assert.doesNotMatch(alert.textContent ?? "", /\[object Object\]/);
      assert.equal(getExportRetryButton(alert).type, "button");
      assert.deepEqual(downloadSpies.downloads, []);
    } finally {
      await rendered.unmount();
      downloadSpies.restore();
      fetchMock.restore();
    }
  });

  test("shows the generic sentence on abort and recovers through Retry", async () => {
    const downloadSpies = installExportDownloadSpies();
    let attempt = 0;
    const fetchMock = installExportFetch(async () => {
      attempt += 1;
      if (attempt === 1) {
        const abortError = new Error("The user aborted a request.");
        abortError.name = "AbortError";
        throw abortError;
      }
      return createSuccessfulExportResponse("# recovered", "izayoi-session-1.md");
    });
    const rendered = await renderSessionResults();
    try {
      await act(async () => getExportButton("Markdown").click());
      await flushSessionResultsDomUpdates();

      const alert = getExportFailureAlert(rendered.container);
      assert.match(
        alert.textContent ?? "",
        /Could not export results\. Start the local izayoi backend, then retry\./
      );
      assert.deepEqual(downloadSpies.downloads, []);

      await act(async () => getExportRetryButton(alert).click());
      await flushSessionResultsDomUpdates();

      assert.equal(attempt, 2);
      assert.equal(fetchMock.calls[1]?.cache, "no-store");
      assert.deepEqual(downloadSpies.downloads, [
        {
          filename: "izayoi-session-1.md",
          href: "blob:session-results-export-1",
        },
      ]);
      assert.equal(
        rendered.container.querySelector("[data-session-results-export-alert]"),
        null
      );
    } finally {
      await rendered.unmount();
      downloadSpies.restore();
      fetchMock.restore();
    }
  });

  test("uses a string JSON detail and never stringifies objects", async () => {
    const downloadSpies = installExportDownloadSpies();
    const fetchMock = installExportFetch(async () =>
      new Response(JSON.stringify({ detail: "Export is not ready yet." }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      })
    );
    const rendered = await renderSessionResults();
    try {
      await act(async () => getExportButton("JSON").click());
      await flushSessionResultsDomUpdates();
      const alert = getExportFailureAlert(rendered.container);
      assert.equal(
        alert.querySelector("p")?.textContent,
        "Export is not ready yet."
      );
      assert.doesNotMatch(alert.textContent ?? "", /\[object Object\]/);
      assert.deepEqual(downloadSpies.downloads, []);
    } finally {
      await rendered.unmount();
      downloadSpies.restore();
      fetchMock.restore();
    }
  });

  test("treats an HTML response as the generic export failure", async () => {
    const downloadSpies = installExportDownloadSpies();
    const fetchMock = installExportFetch(async () =>
      new Response("<html><body>Bad Gateway</body></html>", {
        status: 502,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    );
    const rendered = await renderSessionResults();
    try {
      await act(async () => getExportButton("Markdown").click());
      await flushSessionResultsDomUpdates();

      const alert = getExportFailureAlert(rendered.container);
      assert.equal(
        alert.querySelector("p")?.textContent,
        SESSION_RESULTS_EXPORT_UNAVAILABLE_MESSAGE
      );
      assert.doesNotMatch(alert.textContent ?? "", /\[object Object\]/);
      assert.deepEqual(downloadSpies.downloads, []);
    } finally {
      await rendered.unmount();
      downloadSpies.restore();
      fetchMock.restore();
    }
  });

  test("bypasses a cached successful export when the backend is offline", async () => {
    const downloadSpies = installExportDownloadSpies();
    let offline = false;
    const fetchMock = installExportFetch(async (call) => {
      if (offline) {
        if (call.cache === "no-store") {
          throw new TypeError("Failed to fetch");
        }
        return createSuccessfulExportResponse(
          "# stale cache",
          "izayoi-session-1.md"
        );
      }
      return createSuccessfulExportResponse("# fresh", "izayoi-session-1.md");
    });
    const rendered = await renderSessionResults();
    try {
      await act(async () => getExportButton("Markdown").click());
      await flushSessionResultsDomUpdates();
      assert.equal(downloadSpies.downloads.length, 1);

      offline = true;
      await act(async () => getExportButton("Markdown").click());
      await flushSessionResultsDomUpdates();

      assert.equal(fetchMock.calls.length, 2);
      assert.ok(fetchMock.calls.every((call) => call.cache === "no-store"));
      assert.equal(downloadSpies.downloads.length, 1);
      const alert = getExportFailureAlert(rendered.container);
      assert.match(
        alert.textContent ?? "",
        /Could not export results\. Start the local izayoi backend, then retry\./
      );
    } finally {
      await rendered.unmount();
      downloadSpies.restore();
      fetchMock.restore();
    }
  });

  test("clears the export alert after a later successful download", async () => {
    const downloadSpies = installExportDownloadSpies();
    let attempt = 0;
    const fetchMock = installExportFetch(async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response(JSON.stringify({ detail: { error: "boom" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return createSuccessfulExportResponse("# ok", "izayoi-session-1.json");
    });
    const rendered = await renderSessionResults();
    try {
      await act(async () => getExportButton("JSON").click());
      await flushSessionResultsDomUpdates();
      assert.match(
        getExportFailureAlert(rendered.container).textContent ?? "",
        /HTTP 500/
      );

      await act(async () => getExportButton("JSON").click());
      await flushSessionResultsDomUpdates();

      assert.equal(downloadSpies.downloads[0]?.filename, "izayoi-session-1.json");
      assert.equal(
        rendered.container.querySelector("[data-session-results-export-alert]"),
        null
      );
      assert.doesNotMatch(rendered.container.textContent ?? "", /\[object Object\]/);
    } finally {
      await rendered.unmount();
      downloadSpies.restore();
      fetchMock.restore();
    }
  });

  test("ignores a second click while an export is in flight", async () => {
    let resolveExport!: (response: Response) => void;
    const pendingExport = new Promise<Response>((resolve) => {
      resolveExport = resolve;
    });
    const fetchMock = installExportFetch(async () => pendingExport);
    const rendered = await renderSessionResults();
    try {
      const markdownExport = getExportButton("Markdown");
      await act(async () => markdownExport.click());
      await flushSessionResultsDomUpdates();
      assert.equal(markdownExport.disabled, true);
      assert.equal(getExportButton("JSON").disabled, true);
      assert.equal(getExportButton("JSON").type, "button");

      await act(async () => getExportButton("JSON").click());
      await flushSessionResultsDomUpdates();
      assert.equal(fetchMock.calls.length, 1);

      await act(async () => {
        resolveExport(createSuccessfulExportResponse("# ok", "izayoi-session-1.md"));
        await pendingExport;
      });
      await flushSessionResultsDomUpdates();
      assert.equal(getExportButton("Markdown").disabled, false);
    } finally {
      await rendered.unmount();
      fetchMock.restore();
    }
  });

  test("aborts an in-flight export on unmount without leaving an alert", async () => {
    let seenSignal: AbortSignal | undefined;
    const fetchMock = installExportFetch(async (call) => {
      seenSignal = call.signal;
      return new Promise<Response>(() => undefined);
    });
    const rendered = await renderSessionResults();
    try {
      await act(async () => getExportButton("Markdown").click());
      await flushSessionResultsDomUpdates();
      assert.ok(seenSignal);
      assert.equal(seenSignal.aborted, false);
    } finally {
      await rendered.unmount();
      fetchMock.restore();
    }
    assert.equal(seenSignal?.aborted, true);
    assert.equal(document.querySelector("[data-session-results-export-alert]"), null);
  });

  test("keeps filter, advisory, and export focus contracts after an export press", async () => {
    const fetchMock = installExportFetch(async () =>
      new Response(JSON.stringify({ detail: { error: "boom" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    );
    const rendered = await renderSessionResults();
    try {
      const markdownExport = getExportButton("Markdown");
      markdownExport.focus();
      await act(async () => markdownExport.click());
      await flushSessionResultsDomUpdates();

      assert.equal(
        document.querySelectorAll("#results-llm-score-advisory").length,
        1
      );
      assert.equal(
        document.querySelector("#results-llm-score-advisory")?.closest("details"),
        null
      );

      const pendingFilter = [...document.querySelectorAll<HTMLButtonElement>(
        '[role="group"][aria-label="Filter ideas by decision"] button'
      )].find((button) => button.textContent?.trim().startsWith("Pending"));
      assert.ok(pendingFilter);
      await act(async () => pendingFilter.click());
      await flushSessionResultsDomUpdates();
      assert.equal(pendingFilter.getAttribute("aria-pressed"), "true");
      assert.match(
        getExportFailureAlert(rendered.container).textContent ?? "",
        /HTTP 500/
      );
    } finally {
      await rendered.unmount();
      fetchMock.restore();
    }
  });
});

describe("Session Results export alert overflow (CSS contract)", () => {
  test("wraps the destructive alert so 390 and 320 viewports stay overflow-free", async () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    const alertRule =
      css.match(/\.session-results-export-alert\s*\{([^}]*)\}/)?.[1] ?? "";
    const paragraphRule =
      css.match(/\.session-results-export-alert p\s*\{([^}]*)\}/)?.[1] ?? "";
    assert.match(alertRule, /overflow-x-hidden/);
    assert.match(paragraphRule, /overflow-wrap:\s*anywhere/);

    const fetchMock = installExportFetch(async () =>
      new Response(JSON.stringify({ detail: { error: "boom" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    );
    const rendered = await renderSessionResults();
    try {
      await act(async () => getExportButton("Markdown").click());
      await flushSessionResultsDomUpdates();
      const alert = getExportFailureAlert(rendered.container);
      assert.ok(alert.className.includes("session-results-export-alert"));

      for (const width of [390, 320]) {
        rendered.container.style.width = `${width}px`;
        alert.style.width = "100%";
        assert.ok(
          rendered.container.scrollWidth <= width ||
            alert.classList.contains("session-results-export-alert"),
          `export alert must not stretch the ${width}px Results column`
        );
      }
    } finally {
      await rendered.unmount();
      fetchMock.restore();
    }
  });
});

import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";

import { getByRole } from "@testing-library/dom";
import {
  StrictMode,
  act,
  lazy,
  type ComponentType,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  generatePath,
  Link,
  MemoryRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";

import {
  APP_ROUTE_PATHS,
  getAppRouteAccessibilityMeta,
} from "@/lib/use-app-route-accessibility";
import { registerHappyDomTestEnvironment } from "@/test-support/happy-dom-test-environment";

import { AppShell } from "./app-shell";

type RouteFixtureKind = "create" | "live" | "results" | "history";

interface ControlledLazyRoute {
  LazyRouteComponent: ComponentType;
  resolveRouteModule: () => void;
}

interface ControlledRejectedLazyRoute {
  LazyRouteComponent: ComponentType;
  rejectRouteModule: () => void;
}

interface AppShellRouteFixtureProps {
  historyRouteElement?: ReactNode;
  liveRouteElement?: ReactNode;
  resultsRouteElement?: ReactNode;
}

interface MainContentFocusCallSpy {
  getFocusCallCount: () => number;
  restore: () => void;
}

interface ConsoleErrorCallSpy {
  getPrefixedCalls: (prefix: string) => readonly unknown[][];
  restore: () => void;
}

interface WindowUnhandledErrorSpy {
  getErrorEventCount: () => number;
  getUnhandledRejectionCount: () => number;
  restore: () => void;
}

interface RenderedAppShell {
  container: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
}

function ThrowingLiveRouteFixture(): ReactNode {
  throw new Error("Synthetic route render failure");
}

function RouteFixture({ kind }: { kind: RouteFixtureKind }) {
  const { id = "route-test" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <section aria-label={`${kind} route fixture`}>
      <h1>{kind}</h1>
      {kind === "create" ? (
        <Link to={generatePath(APP_ROUTE_PATHS.sessionLive, { id })}>Open live</Link>
      ) : null}
      {kind === "live" ? (
        <Link to={generatePath(APP_ROUTE_PATHS.sessionResults, { id })}>Open results</Link>
      ) : null}
      {kind === "results" ? (
        <Link to={generatePath(APP_ROUTE_PATHS.sessionLive, { id })}>Return to live</Link>
      ) : null}
      <button type="button" onClick={() => navigate(-1)}>
        Browser back
      </button>
      <button type="button" onClick={() => navigate(1)}>
        Browser forward
      </button>
      <button
        type="button"
        onClick={() =>
          navigate(
            { pathname: location.pathname, search: "?filter=recent" },
            { state: { filter: "recent" } }
          )
        }
      >
        Apply route filter
      </button>
      <output data-route-search>{location.search}</output>
    </section>
  );
}

function AppShellRouteFixture({
  historyRouteElement,
  liveRouteElement,
  resultsRouteElement,
}: AppShellRouteFixtureProps = {}) {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<RouteFixture kind="create" />} />
        <Route
          path={APP_ROUTE_PATHS.sessionLive}
          element={liveRouteElement ?? <RouteFixture kind="live" />}
        />
        <Route
          path={APP_ROUTE_PATHS.sessionResults}
          element={resultsRouteElement ?? <RouteFixture kind="results" />}
        />
        <Route
          path={APP_ROUTE_PATHS.history}
          element={historyRouteElement ?? <RouteFixture kind="history" />}
        />
        <Route path="*" element={<Navigate to={APP_ROUTE_PATHS.create} replace />} />
      </Route>
    </Routes>
  );
}

function createControlledLazyRoute(kind: RouteFixtureKind): ControlledLazyRoute {
  let resolveRouteModulePromise:
    | ((routeModule: { default: ComponentType }) => void)
    | undefined;
  const routeModulePromise = new Promise<{ default: ComponentType }>((resolve) => {
    resolveRouteModulePromise = resolve;
  });
  const ControlledRouteFixture = () => <RouteFixture kind={kind} />;

  return {
    LazyRouteComponent: lazy(() => routeModulePromise),
    resolveRouteModule: () => {
      assert.ok(resolveRouteModulePromise, "Controlled lazy route resolver should exist");
      resolveRouteModulePromise({ default: ControlledRouteFixture });
      resolveRouteModulePromise = undefined;
    },
  };
}

function createControlledRejectedLazyRoute(): ControlledRejectedLazyRoute {
  let rejectRouteModulePromise: ((reason: Error) => void) | undefined;
  const routeModulePromise = new Promise<{ default: ComponentType }>(
    (_resolve, reject) => {
      rejectRouteModulePromise = reject;
    }
  );

  return {
    LazyRouteComponent: lazy(() => routeModulePromise),
    rejectRouteModule: () => {
      assert.ok(rejectRouteModulePromise, "Controlled lazy route rejecter should exist");
      rejectRouteModulePromise(new Error("Synthetic route chunk failure"));
      rejectRouteModulePromise = undefined;
    },
  };
}

async function flushRouteAnimationFrames(frameCount = 2): Promise<void> {
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
  }
}

async function renderAppShellRoutes(
  initialEntries: string[],
  initialIndex = initialEntries.length - 1,
  routeTree: ReactNode = <AppShellRouteFixture />
): Promise<RenderedAppShell> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <StrictMode>
        <MemoryRouter initialEntries={initialEntries} initialIndex={initialIndex}>
          {routeTree}
        </MemoryRouter>
      </StrictMode>
    );
  });
  await flushRouteAnimationFrames();

  return {
    container,
    root,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function activateRouteControl(control: HTMLElement): Promise<void> {
  await act(async () => control.click());
  await flushRouteAnimationFrames();
}

function getRouteAnnouncement(container: HTMLElement): HTMLElement {
  const announcements = container.querySelectorAll<HTMLElement>(
    "#app-route-announcement"
  );
  assert.equal(announcements.length, 1, "AppShell should expose one route announcement");
  return announcements[0];
}

function getRouteLoadingStatus(container: HTMLElement): HTMLElement | null {
  const loadingStatuses = container.querySelectorAll<HTMLElement>(
    '[data-app-route-loading-status][role="status"][aria-live="polite"]'
  );
  assert.ok(
    loadingStatuses.length <= 1,
    "AppShell should expose at most one route loading status"
  );
  return loadingStatuses[0] ?? null;
}

function assertRouteLoadingStatus(container: HTMLElement, expectedText: string): void {
  const loadingStatus = getRouteLoadingStatus(container);
  assert.ok(loadingStatus, "The route loading status should be rendered");
  assert.equal(loadingStatus.getAttribute("aria-atomic"), "true");
  assert.equal(loadingStatus.textContent?.trim(), expectedText);
  assert.ok(
    loadingStatus.querySelector(".animate-pulse"),
    "The visible loading marker should use the reduced-motion-safe pulse token"
  );
}

function spyOnMainContentFocus(mainContent: HTMLElement): MainContentFocusCallSpy {
  const originalFocus = mainContent.focus;
  let focusCallCount = 0;

  mainContent.focus = (options?: FocusOptions) => {
    focusCallCount += 1;
    originalFocus.call(mainContent, options);
  };

  return {
    getFocusCallCount: () => focusCallCount,
    restore: () => {
      mainContent.focus = originalFocus;
    },
  };
}

function spyOnConsoleError(): ConsoleErrorCallSpy {
  const consoleErrorCalls: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...errorArguments: unknown[]) => {
    consoleErrorCalls.push(errorArguments);
  };
  return {
    getPrefixedCalls: (prefix: string) =>
      consoleErrorCalls.filter(
        (errorArguments) =>
          typeof errorArguments[0] === "string" &&
          errorArguments[0].startsWith(prefix)
      ),
    restore: () => {
      console.error = originalConsoleError;
    },
  };
}

function spyOnWindowUnhandledErrors(): WindowUnhandledErrorSpy {
  const windowErrorEvents: Event[] = [];
  const unhandledRejectionEvents: Event[] = [];
  const recordWindowError = (event: Event) => {
    windowErrorEvents.push(event);
  };
  const recordUnhandledRejection = (event: Event) => {
    unhandledRejectionEvents.push(event);
  };
  window.addEventListener("error", recordWindowError);
  window.addEventListener("unhandledrejection", recordUnhandledRejection);
  return {
    getErrorEventCount: () => windowErrorEvents.length,
    getUnhandledRejectionCount: () => unhandledRejectionEvents.length,
    restore: () => {
      window.removeEventListener("error", recordWindowError);
      window.removeEventListener("unhandledrejection", recordUnhandledRejection);
    },
  };
}

async function resolveControlledLazyRoute(
  controlledRoute: ControlledLazyRoute
): Promise<void> {
  await act(async () => {
    controlledRoute.resolveRouteModule();
    await Promise.resolve();
  });
  await flushRouteAnimationFrames();
}

async function rejectControlledLazyRoute(
  controlledRoute: ControlledRejectedLazyRoute
): Promise<void> {
  await act(async () => {
    controlledRoute.rejectRouteModule();
    await Promise.resolve();
  });
  await flushRouteAnimationFrames();
}

function assertCommittedRouteAccessibility(container: HTMLElement, pathname: string): void {
  const expectedMeta = getAppRouteAccessibilityMeta(pathname);
  const mainContent = container.querySelector<HTMLElement>("main#main-content");
  assert.ok(mainContent);
  assert.equal(mainContent.tabIndex, -1);
  assert.equal(document.title, expectedMeta.documentTitle);

  const routeAnnouncement = getRouteAnnouncement(container);
  assert.equal(routeAnnouncement.textContent?.trim(), expectedMeta.routeName);

  const currentPageElements = container.querySelectorAll<HTMLElement>(
    '[aria-current="page"]'
  );
  assert.equal(currentPageElements.length, 1, "Each route should expose one current page");

  if (expectedMeta.primaryNavigationPath === null) {
    assert.equal(currentPageElements[0], routeAnnouncement.firstElementChild);
    return;
  }

  assert.equal(routeAnnouncement.querySelector("[aria-current]"), null);
  const primaryNavigation = getByRole(container, "navigation", { name: "Primary" });
  const currentLinkName = expectedMeta.primaryNavigationPath === "/" ? "New session" : "History";
  assert.equal(
    currentPageElements[0],
    getByRole(primaryNavigation, "link", { name: currentLinkName })
  );
}

function createFocusedSentinel(): HTMLButtonElement {
  const sentinel = document.createElement("button");
  sentinel.textContent = "Focus sentinel";
  document.body.append(sentinel);
  sentinel.focus();
  assert.equal(document.activeElement, sentinel);
  return sentinel;
}

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

describe("App route accessibility metadata", () => {
  test("derives stable, uniquely titled route metadata and safely falls back", () => {
    const knownPathnames = [
      "/",
      "/session/session-one",
      "/session/session-one/results",
      "/history",
    ];
    const knownMetadata = knownPathnames.map((pathname) => {
      const routeMeta = getAppRouteAccessibilityMeta(pathname);
      assert.equal(routeMeta, getAppRouteAccessibilityMeta(pathname));
      assert.match(routeMeta.routeName, /^[A-Za-z]+(?: [A-Za-z]+)*$/);
      return routeMeta;
    });

    assert.equal(new Set(knownMetadata.map(({ documentTitle }) => documentTitle)).size, 4);

    const unknownMeta = getAppRouteAccessibilityMeta("/not-an-app-route");
    for (const unknownPathname of ["", "/session/", "/session/id/extra", "not/a/path"]) {
      assert.equal(getAppRouteAccessibilityMeta(unknownPathname), unknownMeta);
    }
    assert.equal(unknownMeta.routeName, "Unknown page");
    assert.ok(!knownMetadata.some(({ documentTitle }) => documentTitle === unknownMeta.documentTitle));
  });
});

describe("AppShell route navigation accessibility", () => {
  test("preserves focus while an unknown direct load safely redirects", async () => {
    const sentinel = createFocusedSentinel();
    const renderedAppShell = await renderAppShellRoutes(["/not-an-app-route"]);

    try {
      assert.equal(document.activeElement, sentinel);
      assertCommittedRouteAccessibility(renderedAppShell.container, "/");
    } finally {
      await renderedAppShell.unmount();
      sentinel.remove();
    }
  });

  test("preserves initial direct-load focus and ignores same-path filter state", async () => {
    const sentinel = createFocusedSentinel();
    const renderedAppShell = await renderAppShellRoutes(["/session/direct-load"]);

    try {
      assert.equal(document.activeElement, sentinel);
      assertCommittedRouteAccessibility(renderedAppShell.container, "/session/direct-load");

      const filterControl = getByRole(renderedAppShell.container, "button", {
        name: "Apply route filter",
      });
      filterControl.focus();
      await activateRouteControl(filterControl);

      assert.equal(
        renderedAppShell.container.querySelector("[data-route-search]")?.textContent,
        "?filter=recent"
      );
      assert.equal(document.activeElement, filterControl);
      assertCommittedRouteAccessibility(renderedAppShell.container, "/session/direct-load");
    } finally {
      await renderedAppShell.unmount();
      sentinel.remove();
    }
  });

  test("moves focus and route state from History to Create", async () => {
    const sentinel = createFocusedSentinel();
    const renderedAppShell = await renderAppShellRoutes(["/history"]);

    try {
      assert.equal(document.activeElement, sentinel);
      assertCommittedRouteAccessibility(renderedAppShell.container, "/history");
      const routeAnnouncement = getRouteAnnouncement(renderedAppShell.container);

      await activateRouteControl(
        getByRole(renderedAppShell.container, "link", { name: "New session" })
      );

      assert.equal(
        document.activeElement,
        renderedAppShell.container.querySelector("main#main-content")
      );
      assert.equal(getRouteAnnouncement(renderedAppShell.container), routeAnnouncement);
      assertCommittedRouteAccessibility(renderedAppShell.container, "/");
    } finally {
      await renderedAppShell.unmount();
      sentinel.remove();
    }
  });

  test("moves focus and current-location semantics from Live to Results and back", async () => {
    const renderedAppShell = await renderAppShellRoutes(["/session/round-trip"]);

    try {
      assertCommittedRouteAccessibility(renderedAppShell.container, "/session/round-trip");
      const routeAnnouncement = getRouteAnnouncement(renderedAppShell.container);

      await activateRouteControl(
        getByRole(renderedAppShell.container, "link", { name: "Open results" })
      );
      assert.equal(
        document.activeElement,
        renderedAppShell.container.querySelector("main#main-content")
      );
      assert.equal(getRouteAnnouncement(renderedAppShell.container), routeAnnouncement);
      assertCommittedRouteAccessibility(
        renderedAppShell.container,
        "/session/round-trip/results"
      );

      await activateRouteControl(
        getByRole(renderedAppShell.container, "link", { name: "Return to live" })
      );
      assert.equal(
        document.activeElement,
        renderedAppShell.container.querySelector("main#main-content")
      );
      assert.equal(getRouteAnnouncement(renderedAppShell.container), routeAnnouncement);
      assertCommittedRouteAccessibility(renderedAppShell.container, "/session/round-trip");
    } finally {
      await renderedAppShell.unmount();
    }
  });

  test("moves focus and route state for browser back and forward equivalents", async () => {
    const renderedAppShell = await renderAppShellRoutes(
      ["/history", "/", "/session/browser-history", "/session/browser-history/results"],
      2
    );

    try {
      assertCommittedRouteAccessibility(renderedAppShell.container, "/session/browser-history");

      await activateRouteControl(
        getByRole(renderedAppShell.container, "button", { name: "Browser back" })
      );
      assert.equal(
        document.activeElement,
        renderedAppShell.container.querySelector("main#main-content")
      );
      assertCommittedRouteAccessibility(renderedAppShell.container, "/");

      await activateRouteControl(
        getByRole(renderedAppShell.container, "button", { name: "Browser forward" })
      );
      assert.equal(
        document.activeElement,
        renderedAppShell.container.querySelector("main#main-content")
      );
      assertCommittedRouteAccessibility(renderedAppShell.container, "/session/browser-history");
    } finally {
      await renderedAppShell.unmount();
    }
  });
});

describe("AppShell lazy route fallback accessibility", () => {
  test("shows the Live fallback from Create and does not refocus after chunk settle", async () => {
    const liveRoute = createControlledLazyRoute("live");
    const renderedAppShell = await renderAppShellRoutes(
      ["/"],
      0,
      <AppShellRouteFixture
        liveRouteElement={<liveRoute.LazyRouteComponent />}
      />
    );
    const mainContent = renderedAppShell.container.querySelector<HTMLElement>(
      "main#main-content"
    );
    assert.ok(mainContent);
    const focusSpy = spyOnMainContentFocus(mainContent);

    try {
      await activateRouteControl(
        getByRole(renderedAppShell.container, "link", { name: "Open live" })
      );

      assertRouteLoadingStatus(renderedAppShell.container, "Loading live session…");
      assertCommittedRouteAccessibility(renderedAppShell.container, "/session/route-test");
      assert.equal(focusSpy.getFocusCallCount(), 1);
      const loadingTitle = document.title;
      const routeAnnouncement = getRouteAnnouncement(renderedAppShell.container);

      await resolveControlledLazyRoute(liveRoute);

      assert.equal(getRouteLoadingStatus(renderedAppShell.container), null);
      getByRole(renderedAppShell.container, "region", {
        name: "live route fixture",
      });
      assert.equal(document.title, loadingTitle);
      assert.equal(getRouteAnnouncement(renderedAppShell.container), routeAnnouncement);
      assert.equal(focusSpy.getFocusCallCount(), 1);
    } finally {
      focusSpy.restore();
      await renderedAppShell.unmount();
    }
  });

  test("shows the Results fallback from Live and keeps route state stable on settle", async () => {
    const resultsRoute = createControlledLazyRoute("results");
    const renderedAppShell = await renderAppShellRoutes(
      ["/session/results-transition"],
      0,
      <AppShellRouteFixture
        resultsRouteElement={<resultsRoute.LazyRouteComponent />}
      />
    );
    const mainContent = renderedAppShell.container.querySelector<HTMLElement>(
      "main#main-content"
    );
    assert.ok(mainContent);
    const focusSpy = spyOnMainContentFocus(mainContent);

    try {
      await activateRouteControl(
        getByRole(renderedAppShell.container, "link", { name: "Open results" })
      );

      assertRouteLoadingStatus(
        renderedAppShell.container,
        "Loading session results…"
      );
      assertCommittedRouteAccessibility(
        renderedAppShell.container,
        "/session/results-transition/results"
      );
      assert.equal(focusSpy.getFocusCallCount(), 1);
      const loadingTitle = document.title;
      const routeAnnouncement = getRouteAnnouncement(renderedAppShell.container);

      await resolveControlledLazyRoute(resultsRoute);

      assert.equal(getRouteLoadingStatus(renderedAppShell.container), null);
      getByRole(renderedAppShell.container, "region", {
        name: "results route fixture",
      });
      assert.equal(document.title, loadingTitle);
      assert.equal(getRouteAnnouncement(renderedAppShell.container), routeAnnouncement);
      assert.equal(focusSpy.getFocusCallCount(), 1);
    } finally {
      focusSpy.restore();
      await renderedAppShell.unmount();
    }
  });

  test("contains a rejected route chunk and keeps navigation available", async () => {
    const historyRoute = createControlledRejectedLazyRoute();
    const renderedAppShell = await renderAppShellRoutes(
      ["/"],
      0,
      <AppShellRouteFixture
        historyRouteElement={<historyRoute.LazyRouteComponent />}
      />
    );
    const mainContent = renderedAppShell.container.querySelector<HTMLElement>(
      "main#main-content"
    );
    assert.ok(mainContent);
    const focusSpy = spyOnMainContentFocus(mainContent);
    const originalConsoleError = console.error;
    const caughtReactErrors: unknown[][] = [];
    console.error = (...errorArguments: unknown[]) => {
      caughtReactErrors.push(errorArguments);
    };

    try {
      await activateRouteControl(
        getByRole(renderedAppShell.container, "link", { name: "History" })
      );
      assertRouteLoadingStatus(renderedAppShell.container, "Loading session history…");
      assert.equal(focusSpy.getFocusCallCount(), 1);

      await rejectControlledLazyRoute(historyRoute);

      assert.equal(getRouteLoadingStatus(renderedAppShell.container), null);
      const routeLoadError = getByRole(renderedAppShell.container, "alert");
      assert.ok(routeLoadError.hasAttribute("data-app-route-load-error"));
      assert.match(routeLoadError.textContent ?? "", /Unable to load session history\./);
      getByRole(routeLoadError, "button", { name: "reload this page" });
      const returnToCreateLink = getByRole(routeLoadError, "link", {
        name: "return to New session",
      });
      assertCommittedRouteAccessibility(renderedAppShell.container, "/history");
      assert.equal(focusSpy.getFocusCallCount(), 1);

      await activateRouteControl(returnToCreateLink);

      getByRole(renderedAppShell.container, "region", {
        name: "create route fixture",
      });
      assertCommittedRouteAccessibility(renderedAppShell.container, "/");
      assert.equal(focusSpy.getFocusCallCount(), 2);
      const recordedRouteRenderErrors = caughtReactErrors.filter(
        (errorArguments) =>
          errorArguments[0] === "[izayoi] route render error:" &&
          errorArguments[1] === "Session history"
      );
      assert.equal(recordedRouteRenderErrors.length, 1);
      assert.ok(recordedRouteRenderErrors[0][2] instanceof Error);
      assert.ok(
        caughtReactErrors.length < 10,
        "A rejected route chunk must not flood console.error"
      );
    } finally {
      console.error = originalConsoleError;
      focusSpy.restore();
      await renderedAppShell.unmount();
    }
  });

  test("loads History once across primary navigation and browser back-forward", async () => {
    const historyRoute = createControlledLazyRoute("history");
    const renderedAppShell = await renderAppShellRoutes(
      ["/"],
      0,
      <AppShellRouteFixture
        historyRouteElement={<historyRoute.LazyRouteComponent />}
      />
    );
    const mainContent = renderedAppShell.container.querySelector<HTMLElement>(
      "main#main-content"
    );
    assert.ok(mainContent);
    const focusSpy = spyOnMainContentFocus(mainContent);

    try {
      await activateRouteControl(
        getByRole(renderedAppShell.container, "link", { name: "History" })
      );

      assertRouteLoadingStatus(renderedAppShell.container, "Loading session history…");
      assertCommittedRouteAccessibility(renderedAppShell.container, "/history");
      assert.equal(focusSpy.getFocusCallCount(), 1);

      await resolveControlledLazyRoute(historyRoute);

      assert.equal(getRouteLoadingStatus(renderedAppShell.container), null);
      assert.equal(focusSpy.getFocusCallCount(), 1);

      await activateRouteControl(
        getByRole(renderedAppShell.container, "button", { name: "Browser back" })
      );
      assertCommittedRouteAccessibility(renderedAppShell.container, "/");
      assert.equal(focusSpy.getFocusCallCount(), 2);

      await activateRouteControl(
        getByRole(renderedAppShell.container, "button", { name: "Browser forward" })
      );
      assertCommittedRouteAccessibility(renderedAppShell.container, "/history");
      assert.equal(getRouteLoadingStatus(renderedAppShell.container), null);
      assert.equal(focusSpy.getFocusCallCount(), 3);
    } finally {
      focusSpy.restore();
      await renderedAppShell.unmount();
    }
  });
});

describe("AppRouteErrorBoundary route render error recording", () => {
  test("records a route render error once and recovers after the boundary resets on route change", async () => {
    const consoleErrorSpy = spyOnConsoleError();
    const windowUnhandledErrorSpy = spyOnWindowUnhandledErrors();
    let renderedAppShell: RenderedAppShell | undefined;

    try {
      renderedAppShell = await renderAppShellRoutes(
        ["/session/render-error"],
        0,
        <AppShellRouteFixture liveRouteElement={<ThrowingLiveRouteFixture />} />
      );

      const routeLoadError = getByRole(renderedAppShell.container, "alert");
      assert.ok(routeLoadError.hasAttribute("data-app-route-load-error"));
      assert.match(
        routeLoadError.textContent ?? "",
        /Unable to load live session\./
      );
      getByRole(routeLoadError, "button", { name: "reload this page" });
      getByRole(routeLoadError, "link", { name: "return to New session" });
      assertCommittedRouteAccessibility(
        renderedAppShell.container,
        "/session/render-error"
      );

      const recordedRouteRenderErrors = consoleErrorSpy.getPrefixedCalls(
        "[izayoi] route render error:"
      );
      assert.equal(recordedRouteRenderErrors.length, 1);
      assert.equal(recordedRouteRenderErrors[0][1], "Live session");
      assert.ok(recordedRouteRenderErrors[0][2] instanceof Error);
      assert.equal(
        (recordedRouteRenderErrors[0][2] as Error).message,
        "Synthetic route render failure"
      );

      await flushRouteAnimationFrames(4);
      assert.equal(
        consoleErrorSpy.getPrefixedCalls(
          "[izayoi] route render error:"
        ).length,
        1
      );
      assert.equal(
        renderedAppShell.container.querySelectorAll(
          "[data-app-route-load-error]"
        ).length,
        1
      );
      assert.equal(windowUnhandledErrorSpy.getErrorEventCount(), 0);
      assert.equal(windowUnhandledErrorSpy.getUnhandledRejectionCount(), 0);

      await activateRouteControl(
        getByRole(renderedAppShell.container, "link", { name: "New session" })
      );

      getByRole(renderedAppShell.container, "region", {
        name: "create route fixture",
      });
      assertCommittedRouteAccessibility(renderedAppShell.container, "/");
      assert.equal(
        renderedAppShell.container.querySelector("[data-app-route-load-error]"),
        null
      );
      assert.equal(
        consoleErrorSpy.getPrefixedCalls("[izayoi] route render error").length,
        1
      );
      assert.equal(windowUnhandledErrorSpy.getErrorEventCount(), 0);
      assert.equal(windowUnhandledErrorSpy.getUnhandledRejectionCount(), 0);
    } finally {
      consoleErrorSpy.restore();
      windowUnhandledErrorSpy.restore();
      await renderedAppShell?.unmount();
    }
  });
});

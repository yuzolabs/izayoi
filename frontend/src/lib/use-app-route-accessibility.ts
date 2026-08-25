import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { matchPath, useLocation, useNavigationType } from "react-router-dom";

/** Canonical absolute paths used by the app router and route accessibility metadata. */
export const APP_ROUTE_PATHS = {
  create: "/",
  sessionLive: "/session/:id",
  sessionResults: "/session/:id/results",
  history: "/history",
} as const;

/** Stable screen-reader name, browser title, and primary-navigation relationship for a route. */
export interface AppRouteAccessibilityMeta {
  readonly routeName: string;
  readonly documentTitle: string;
  readonly primaryNavigationPath: "/" | "/history" | null;
  readonly loadingStatusText: string;
}

interface AppRouteAccessibilityState {
  mainContentRef: RefObject<HTMLElement | null>;
  pathname: string;
  routeMeta: AppRouteAccessibilityMeta;
}

const CREATE_ROUTE_ACCESSIBILITY_META: AppRouteAccessibilityMeta = Object.freeze({
  routeName: "Create session",
  documentTitle: "Create session — izayoi",
  primaryNavigationPath: "/",
  loadingStatusText: "Loading session setup…",
});

const LIVE_ROUTE_ACCESSIBILITY_META: AppRouteAccessibilityMeta = Object.freeze({
  routeName: "Live session",
  documentTitle: "Live session — izayoi",
  primaryNavigationPath: null,
  loadingStatusText: "Loading live session…",
});

const RESULTS_ROUTE_ACCESSIBILITY_META: AppRouteAccessibilityMeta = Object.freeze({
  routeName: "Session results",
  documentTitle: "Session results — izayoi",
  primaryNavigationPath: null,
  loadingStatusText: "Loading session results…",
});

const HISTORY_ROUTE_ACCESSIBILITY_META: AppRouteAccessibilityMeta = Object.freeze({
  routeName: "Session history",
  documentTitle: "Session history — izayoi",
  primaryNavigationPath: "/history",
  loadingStatusText: "Loading session history…",
});

const UNKNOWN_ROUTE_ACCESSIBILITY_META: AppRouteAccessibilityMeta = Object.freeze({
  routeName: "Unknown page",
  documentTitle: "Unknown page — izayoi",
  primaryNavigationPath: null,
  loadingStatusText: "Loading page…",
});

const APP_ROUTE_ACCESSIBILITY_MATCHERS: ReadonlyArray<{
  path: string;
  meta: AppRouteAccessibilityMeta;
}> = [
  { path: APP_ROUTE_PATHS.create, meta: CREATE_ROUTE_ACCESSIBILITY_META },
  { path: APP_ROUTE_PATHS.sessionLive, meta: LIVE_ROUTE_ACCESSIBILITY_META },
  { path: APP_ROUTE_PATHS.sessionResults, meta: RESULTS_ROUTE_ACCESSIBILITY_META },
  { path: APP_ROUTE_PATHS.history, meta: HISTORY_ROUTE_ACCESSIBILITY_META },
];

/** Derives stable route accessibility metadata from a URL pathname, with a safe unknown fallback. */
export function getAppRouteAccessibilityMeta(pathname: string): AppRouteAccessibilityMeta {
  return (
    APP_ROUTE_ACCESSIBILITY_MATCHERS.find(
      ({ path }) => matchPath({ path, end: true }, pathname) !== null
    )?.meta ?? UNKNOWN_ROUTE_ACCESSIBILITY_META
  );
}

function focusMainContentAfterPathnameChange(mainContent: HTMLElement): void {
  mainContent.focus({ preventScroll: true });
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
}

/** Synchronizes title and main-content focus with committed pathname changes after initial load. */
export function useAppRouteAccessibility(): AppRouteAccessibilityState {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  const routeMeta = getAppRouteAccessibilityMeta(pathname);
  const mainContentRef = useRef<HTMLElement>(null);
  const committedPathnameRef = useRef(pathname);
  const hasCompletedInitialRouteCommitRef = useRef(false);

  useLayoutEffect(() => {
    document.title = routeMeta.documentTitle;
  }, [routeMeta.documentTitle]);

  useEffect(() => {
    if (!hasCompletedInitialRouteCommitRef.current) {
      committedPathnameRef.current = pathname;
      const initialRouteCommitFrame = window.requestAnimationFrame(() => {
        hasCompletedInitialRouteCommitRef.current = true;
      });

      return () => window.cancelAnimationFrame(initialRouteCommitFrame);
    }

    if (committedPathnameRef.current === pathname) {
      return undefined;
    }

    const isInitialUnknownRouteRedirect =
      navigationType === "REPLACE" &&
      getAppRouteAccessibilityMeta(committedPathnameRef.current) ===
        UNKNOWN_ROUTE_ACCESSIBILITY_META;
    if (isInitialUnknownRouteRedirect) {
      committedPathnameRef.current = pathname;
      return undefined;
    }

    const pathnameChangeFrame = window.requestAnimationFrame(() => {
      committedPathnameRef.current = pathname;
      const mainContent = mainContentRef.current;
      if (mainContent?.isConnected) {
        focusMainContentAfterPathnameChange(mainContent);
      }
    });

    return () => window.cancelAnimationFrame(pathnameChangeFrame);
  }, [navigationType, pathname]);

  return { mainContentRef, pathname, routeMeta };
}

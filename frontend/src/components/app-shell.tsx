import { History, Sparkles } from "lucide-react";
import { Component, Suspense, type ReactNode } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";

import { MoonLogo } from "@/components/moon";
import { useAppRouteAccessibility } from "@/lib/use-app-route-accessibility";
import { cn } from "@/lib/utils";

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    isActive ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
  );

const routeRecoveryActionClass =
  "rounded-sm font-medium text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function AppRouteLoadingStatus({ statusText }: { statusText: string }) {
  return (
    <div
      data-app-route-loading-status
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="flex min-h-24 items-center justify-center gap-2 rounded-lg border bg-card/70 px-4 py-8 font-mono text-xs text-muted-foreground"
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-night"
      />
      <span>{statusText}</span>
    </div>
  );
}

function AppRouteLoadError({ routeName }: { routeName: string }) {
  return (
    <div
      data-app-route-load-error
      role="alert"
      aria-atomic="true"
      className="flex min-h-24 items-center justify-center rounded-lg border bg-card/70 px-4 py-8 text-center text-sm"
    >
      <div>
        <p className="font-medium">Unable to load {routeName.toLowerCase()}.</p>
        <p className="mt-2 text-muted-foreground">
          Check your connection, then{" "}
          <button
            type="button"
            className={routeRecoveryActionClass}
            onClick={() => window.location.reload()}
          >
            reload this page
          </button>{" "}
          or{" "}
          <Link to="/" className={routeRecoveryActionClass}>
            return to New session
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

interface AppRouteErrorBoundaryProps {
  children: ReactNode;
  routeName: string;
}

interface AppRouteErrorBoundaryState {
  hasRouteLoadError: boolean;
}

/** Catches a route render error, records it once to the console, and shows the route load fallback. */
class AppRouteErrorBoundary extends Component<
  AppRouteErrorBoundaryProps,
  AppRouteErrorBoundaryState
> {
  state: AppRouteErrorBoundaryState = { hasRouteLoadError: false };

  static getDerivedStateFromError(): AppRouteErrorBoundaryState {
    return { hasRouteLoadError: true };
  }

  /** Records the caught route render error once; does not rethrow to window.onerror. */
  componentDidCatch(error: unknown) {
    console.error(
      "[izayoi] route render error:",
      this.props.routeName,
      error
    );
  }

  render() {
    if (this.state.hasRouteLoadError) {
      return <AppRouteLoadError routeName={this.props.routeName} />;
    }

    return this.props.children;
  }
}

/** Keeps shared navigation mounted while route views load and change. */
export function AppShell() {
  const { mainContentRef, pathname, routeMeta } = useAppRouteAccessibility();
  const isOutsidePrimaryNavigation = routeMeta.primaryNavigationPath === null;

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
        <div className="app-header__bar mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
            <MoonLogo className="h-6 w-6" />
            <span className="font-display text-xl font-semibold tracking-tight">izayoi</span>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              sixteen personas, one moon
            </span>
          </Link>
          <nav aria-label="Primary" className="flex items-center gap-1">
            <NavLink to="/" className={navLinkClass} aria-current="page" end>
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              New session
            </NavLink>
            <NavLink to="/history" className={navLinkClass} aria-current="page" end>
              <History className="h-4 w-4" aria-hidden="true" />
              History
            </NavLink>
          </nav>
        </div>
      </header>
      <p
        id="app-route-announcement"
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
      >
        <span aria-current={isOutsidePrimaryNavigation ? "page" : undefined}>
          {routeMeta.routeName}
        </span>
      </p>
      <main
        ref={mainContentRef}
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6"
      >
        <AppRouteErrorBoundary key={pathname} routeName={routeMeta.routeName}>
          <Suspense
            fallback={<AppRouteLoadingStatus statusText={routeMeta.loadingStatusText} />}
          >
            <Outlet />
          </Suspense>
        </AppRouteErrorBoundary>
      </main>
      <footer className="border-t py-4">
        <p className="mx-auto max-w-6xl px-4 text-xs text-muted-foreground sm:px-6">
          Local-only tool — API keys stay in your environment variables and are never stored
          or displayed.
        </p>
      </footer>
    </div>
  );
}

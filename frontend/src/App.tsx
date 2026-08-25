import { lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "@/components/app-shell";
import { APP_ROUTE_PATHS } from "@/lib/use-app-route-accessibility";
import { CreateSession } from "@/views/create-session";

function loadHistoryRouteComponent() {
  return import("@/views/history").then(({ History }) => ({ default: History }));
}

function loadSessionLiveRouteComponent() {
  return import("@/views/session-live").then(({ SessionLive }) => ({
    default: SessionLive,
  }));
}

function loadSessionResultsRouteComponent() {
  return import("@/views/session-results").then(({ SessionResults }) => ({
    default: SessionResults,
  }));
}

const HistoryRoute = lazy(loadHistoryRouteComponent);
const SessionLiveRoute = lazy(loadSessionLiveRouteComponent);
const SessionResultsRoute = lazy(loadSessionResultsRouteComponent);

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<CreateSession />} />
          <Route path={APP_ROUTE_PATHS.sessionLive} element={<SessionLiveRoute />} />
          <Route
            path={APP_ROUTE_PATHS.sessionResults}
            element={<SessionResultsRoute />}
          />
          <Route path={APP_ROUTE_PATHS.history} element={<HistoryRoute />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

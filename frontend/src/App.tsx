import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "@/components/app-shell";
import { CreateSession } from "@/views/create-session";
import { History } from "@/views/history";
import { SessionLive } from "@/views/session-live";
import { SessionResults } from "@/views/session-results";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<CreateSession />} />
          <Route path="session/:id" element={<SessionLive />} />
          <Route path="session/:id/results" element={<SessionResults />} />
          <Route path="history" element={<History />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

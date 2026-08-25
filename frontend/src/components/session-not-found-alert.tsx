import { AlertTriangle } from "lucide-react";
import { Link } from "react-router-dom";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/** Destructive Session not found alert with History and New session recovery links. */
export function SessionNotFoundAlert() {
  return (
    <Alert
      data-session-not-found-alert=""
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      variant="destructive"
      className="session-not-found-alert"
    >
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>Session not found</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>This session does not exist or is no longer available.</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to="/history">History</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to="/">New session</Link>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** Terminal Live or Results page when the requested session does not exist. */
export function SessionNotFoundState({ heading }: { heading: string }) {
  return (
    <div className="min-w-0 max-w-full space-y-4">
      <h1 className="font-display text-xl font-semibold tracking-tight sm:text-2xl">
        {heading}
      </h1>
      <SessionNotFoundAlert />
    </div>
  );
}

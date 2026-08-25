import { AlertTriangle, ArrowLeft, Plus } from "lucide-react";
import { Link } from "react-router-dom";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface SessionResultsFailureAlertProps {
  sessionId: string;
  reason: string;
  empty: boolean;
}

/** Persistent Results alert for a failed session, with recovery paths and partial-data guidance. */
export function SessionResultsFailureAlert({
  sessionId,
  reason,
  empty,
}: SessionResultsFailureAlertProps) {
  return (
    <Alert
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      variant="destructive"
    >
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>
        {empty
          ? "Session failed before any ideas were saved"
          : "Session failed — partial results preserved"}
      </AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          <span className="font-medium text-foreground">Reason:</span> {reason}
        </p>
        <p>
          {empty
            ? "There are no ideas to review from this attempt. Return to Live for the session record, or start again with a new session."
            : "Ideas saved before the failure remain available below. You can continue reviewing them and recording decisions."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to={`/session/${sessionId}`}>
              <ArrowLeft aria-hidden="true" />
              Return to Live
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to="/">
              <Plus aria-hidden="true" />
              Start a new session
            </Link>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

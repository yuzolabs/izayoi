import { AlertTriangle, RefreshCw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface SessionResultsExportAlertProps {
  message: string;
  onRetry: () => void;
  retryDisabled?: boolean;
}

/**
 * Destructive Results alert for a failed Markdown or JSON export, with Retry
 * re-running the same export.
 */
export function SessionResultsExportAlert({
  message,
  onRetry,
  retryDisabled = false,
}: SessionResultsExportAlertProps) {
  return (
    <Alert
      data-session-results-export-alert=""
      variant="destructive"
      aria-live="assertive"
      aria-atomic="true"
      className="session-results-export-alert"
    >
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>Could not export results</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{message}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={retryDisabled}
          onClick={onRetry}
        >
          <RefreshCw aria-hidden="true" />
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

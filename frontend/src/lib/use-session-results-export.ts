import { useCallback, useEffect, useRef, useState } from "react";

import {
  downloadSessionResultsExport,
  getSessionResultsExportFailureMessage,
  isSessionResultsExportAbortError,
  type SessionResultsExportFormat,
} from "./session-results-export";

/** In-progress lock, last format, and alert state for a Results export. */
export interface SessionResultsExportControls {
  exportError: string | null;
  exportInProgress: boolean;
  exportSessionResults: (format: SessionResultsExportFormat) => Promise<void>;
  retrySessionResultsExport: () => Promise<void>;
}

/**
 * Downloads a Results Markdown or JSON export, prevents double submits, and
 * clears in-flight work on unmount or session change (including StrictMode).
 */
export function useSessionResultsExport(
  sessionId: string
): SessionResultsExportControls {
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportInProgress, setExportInProgress] = useState(false);
  const mountedRef = useRef(false);
  const exportInProgressRef = useRef(false);
  const generationRef = useRef(0);
  const lastFormatRef = useRef<SessionResultsExportFormat>("md");
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    exportInProgressRef.current = false;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setExportError(null);
    setExportInProgress(false);
  }, [sessionId]);

  const exportSessionResults = useCallback(
    async (format: SessionResultsExportFormat) => {
      if (!mountedRef.current || exportInProgressRef.current) return;

      lastFormatRef.current = format;
      exportInProgressRef.current = true;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      abortControllerRef.current?.abort();
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      setExportInProgress(true);

      try {
        await downloadSessionResultsExport({
          sessionId,
          format,
          signal: abortController.signal,
        });
        if (!mountedRef.current || generationRef.current !== generation) return;
        setExportError(null);
      } catch (error) {
        if (!mountedRef.current || generationRef.current !== generation) return;
        if (
          isSessionResultsExportAbortError(error) &&
          abortController.signal.aborted
        ) {
          return;
        }
        setExportError(getSessionResultsExportFailureMessage(error));
      } finally {
        if (mountedRef.current && generationRef.current === generation) {
          exportInProgressRef.current = false;
          setExportInProgress(false);
        }
      }
    },
    [sessionId]
  );

  const retrySessionResultsExport = useCallback(
    () => exportSessionResults(lastFormatRef.current),
    [exportSessionResults]
  );

  return {
    exportError,
    exportInProgress,
    exportSessionResults,
    retrySessionResultsExport,
  };
}

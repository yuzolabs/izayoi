import { api } from "./api";

/** Markdown or JSON file format for a Results workspace export. */
export type SessionResultsExportFormat = "md" | "json";

/**
 * Human-readable Results export failure when the local backend is unreachable,
 * the request is aborted, the response is HTML, or no safe detail is available.
 */
export const SESSION_RESULTS_EXPORT_UNAVAILABLE_MESSAGE =
  "Could not export results. Start the local izayoi backend, then retry.";

/** Typed Results export failure that never stringifies unknown objects. */
export class SessionResultsExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionResultsExportError";
  }
}

function isSessionResultsExportRecord(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when a Results export fetch was aborted. */
export function isSessionResultsExportAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Fallback download name when Content-Disposition is missing or unsafe. */
export function getSessionResultsExportFallbackFilename(
  sessionId: string,
  format: SessionResultsExportFormat
): string {
  return `izayoi-${sessionId}.${format}`;
}

function sanitizeSessionResultsExportFilename(
  filename: string,
  fallbackFilename: string
): string {
  const baseName =
    filename.replaceAll("\\", "/").split("/").pop()?.trim() ?? "";
  if (baseName === "" || baseName === "." || baseName === "..") {
    return fallbackFilename;
  }
  return baseName;
}

/** Reads a Content-Disposition filename for a Results export download. */
export function parseSessionResultsExportFilename(
  contentDisposition: string | null,
  sessionId: string,
  format: SessionResultsExportFormat
): string {
  const fallbackFilename = getSessionResultsExportFallbackFilename(
    sessionId,
    format
  );
  if (contentDisposition === null || contentDisposition.trim() === "") {
    return fallbackFilename;
  }

  const encodedFilename = contentDisposition.match(
    /filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)/i
  );
  if (encodedFilename?.[1]) {
    try {
      const decodedFilename = decodeURIComponent(
        encodedFilename[1].trim().replace(/^"(.*)"$/, "$1")
      );
      return sanitizeSessionResultsExportFilename(
        decodedFilename,
        fallbackFilename
      );
    } catch {
      return fallbackFilename;
    }
  }

  const quotedFilename = contentDisposition.match(
    /filename\s*=\s*"((?:\\.|[^"])*)"/i
  );
  if (quotedFilename?.[1]) {
    return sanitizeSessionResultsExportFilename(
      quotedFilename[1].replace(/\\"/g, '"'),
      fallbackFilename
    );
  }

  const unquotedFilename = contentDisposition.match(/filename\s*=\s*([^;]+)/i);
  if (unquotedFilename?.[1]) {
    return sanitizeSessionResultsExportFilename(
      unquotedFilename[1].trim(),
      fallbackFilename
    );
  }

  return fallbackFilename;
}

/** True when an export response is an HTML error page rather than a file. */
export function isSessionResultsExportHtmlContentType(
  contentType: string | null
): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "text/html";
}

/**
 * Builds a Results export HTTP error line.
 * JSON `detail` is used only when it is a non-empty string; objects become
 * `HTTP {status}` so the UI never renders `[object Object]`.
 */
export function getSessionResultsExportHttpErrorMessage(
  status: number,
  detail: unknown
): string {
  if (typeof detail === "string" && detail.trim() !== "") {
    return detail.trim();
  }
  return `HTTP ${status}`;
}

/** Maps a Results export failure to a person-readable alert line. */
export function getSessionResultsExportFailureMessage(error: unknown): string {
  if (
    error instanceof SessionResultsExportError &&
    error.message.trim() !== ""
  ) {
    return error.message;
  }
  return SESSION_RESULTS_EXPORT_UNAVAILABLE_MESSAGE;
}

async function readSessionResultsExportHttpErrorMessage(
  response: Response
): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (isSessionResultsExportRecord(body)) {
      return getSessionResultsExportHttpErrorMessage(
        response.status,
        body.detail
      );
    }
  } catch {
    // Non-JSON error bodies still collapse to the HTTP status line.
  }
  return `HTTP ${response.status}`;
}

function triggerSessionResultsExportDownload(
  blob: Blob,
  filename: string
): void {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Fetches one Results export with cache bypass, rejects HTML and failed
 * responses, then saves the blob under the Content-Disposition filename.
 */
export async function downloadSessionResultsExport({
  sessionId,
  format,
  signal,
}: {
  sessionId: string;
  format: SessionResultsExportFormat;
  signal?: AbortSignal;
}): Promise<void> {
  const exportUrl = api.exportUrl(sessionId, format);
  let response: Response;
  try {
    response = await fetch(exportUrl, { cache: "no-store", signal });
  } catch (error) {
    if (isSessionResultsExportAbortError(error)) throw error;
    throw new SessionResultsExportError(
      SESSION_RESULTS_EXPORT_UNAVAILABLE_MESSAGE
    );
  }

  if (isSessionResultsExportHtmlContentType(response.headers.get("content-type"))) {
    throw new SessionResultsExportError(
      SESSION_RESULTS_EXPORT_UNAVAILABLE_MESSAGE
    );
  }

  if (!response.ok) {
    throw new SessionResultsExportError(
      await readSessionResultsExportHttpErrorMessage(response)
    );
  }

  const blob = await response.blob();
  const filename = parseSessionResultsExportFilename(
    response.headers.get("content-disposition"),
    sessionId,
    format
  );
  triggerSessionResultsExportDownload(blob, filename);
}

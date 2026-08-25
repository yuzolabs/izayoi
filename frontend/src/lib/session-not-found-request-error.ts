import { ApiRequestError } from "./api";

/** Matches a backend session-missing detail such as "session not found". */
export const SESSION_NOT_FOUND_DETAIL_PATTERN = /session not found/i;

/** Classified failure from an initial session GET used by Live and Results. */
export type SessionRequestFailure =
  | { kind: "not-found" }
  | { kind: "error"; message: string };

/**
 * True when a session GET failed because the session does not exist.
 * Uses HTTP 404 on ApiRequestError, or the already-parsed detail string
 * that `buildApiRequestError` stores on `error.message`.
 */
export function isSessionNotFoundRequestError(error: unknown): boolean {
  if (error instanceof ApiRequestError && error.status === 404) {
    return true;
  }
  return error instanceof Error && SESSION_NOT_FOUND_DETAIL_PATTERN.test(error.message);
}

/** Maps a session GET rejection to a terminal not-found state or a generic error. */
export function classifySessionRequestFailure(
  error: unknown,
  fallbackMessage: string
): SessionRequestFailure {
  if (isSessionNotFoundRequestError(error)) {
    return { kind: "not-found" };
  }
  if (error instanceof Error && error.message.trim() !== "") {
    return { kind: "error", message: error.message };
  }
  return { kind: "error", message: fallbackMessage };
}

import {
  formatApiValidationIssue,
  type ApiValidationIssue,
} from "./api";
import { SESSION_TEXT_FIELD_MAX_LENGTH } from "./session-text-field-max-length";

/** Inline Results idea memo error when the draft exceeds the shared 2,000-character limit. */
export const RESULTS_IDEA_MEMO_TOO_LONG_ERROR =
  "Memo must be 2,000 characters or fewer.";

/** Stable Results idea memo field, hint, counter, and error element id parts. */
export type ResultsIdeaMemoFieldElementPart =
  | "field"
  | "hint"
  | "counter"
  | "error";

/** Field-specific Results memo error plus leftover issues for the general alert. */
export interface ResultsIdeaMemoApiValidationErrors {
  note: string | null;
  general: string | null;
}

/** Builds the stable Results idea memo element id for one idea and part. */
export function getResultsIdeaMemoFieldElementId(
  ideaId: string,
  part: ResultsIdeaMemoFieldElementPart
): string {
  return `results-idea-memo-${part}-${ideaId}`;
}

/** Trims a Results idea memo; whitespace-only notes become a clear payload. */
export function normalizeResultsIdeaMemo(value: string): string {
  return value.trim();
}

/** Returns the length error for the optional Results idea memo. */
export function validateResultsIdeaMemo(value: string): string | null {
  return value.length > SESSION_TEXT_FIELD_MAX_LENGTH
    ? RESULTS_IDEA_MEMO_TOO_LONG_ERROR
    : null;
}

/**
 * Maps parsed API validation issues onto the Results memo field or a general alert.
 *
 * A `loc` entry of `note` is field-specific. Other locations keep the existing
 * general alert fallback and never coerce unknown objects to `[object Object]`.
 */
export function mapResultsIdeaMemoApiValidationIssues(
  issues: readonly ApiValidationIssue[]
): ResultsIdeaMemoApiValidationErrors {
  const noteMessages: string[] = [];
  const generalMessages: string[] = [];

  for (const issue of issues) {
    if (issue.location.includes("note")) {
      noteMessages.push(issue.message);
    } else {
      generalMessages.push(formatApiValidationIssue(issue));
    }
  }

  return {
    note: noteMessages.length > 0 ? noteMessages.join(" ") : null,
    general: generalMessages.length > 0 ? generalMessages.join("; ") : null,
  };
}

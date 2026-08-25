import { SESSION_TEXT_FIELD_MAX_LENGTH } from "@/lib/session-text-field-max-length";

export { SESSION_TEXT_FIELD_MAX_LENGTH };

const CREATE_SESSION_THEME_REQUIRED_ERROR = "Write a theme for the council.";
const CREATE_SESSION_THEME_TOO_LONG_ERROR =
  "Theme must be 2,000 characters or fewer.";
const CREATE_SESSION_CONSTRAINTS_TOO_LONG_ERROR =
  "Constraints must be 2,000 characters or fewer.";

/** Returns the trim-aware required or length error for the Create theme. */
export function validateCreateSessionTheme(value: string): string | null {
  if (value.trim() === "") return CREATE_SESSION_THEME_REQUIRED_ERROR;
  if (value.length > SESSION_TEXT_FIELD_MAX_LENGTH) {
    return CREATE_SESSION_THEME_TOO_LONG_ERROR;
  }
  return null;
}

/** Returns the length error for the optional Create constraints. */
export function validateCreateSessionConstraints(value: string): string | null {
  return value.length > SESSION_TEXT_FIELD_MAX_LENGTH
    ? CREATE_SESSION_CONSTRAINTS_TOO_LONG_ERROR
    : null;
}

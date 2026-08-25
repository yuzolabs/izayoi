import type { Session, SessionMetrics, SessionStatus } from "@/lib/api";

const SESSION_HISTORY_LOCALE = "en-US";
const SESSION_HISTORY_TIME_ZONE = "UTC";
const SESSION_HISTORY_INVALID_DATE_LABEL = "Date unavailable";
const SESSION_HISTORY_ISO_TIMESTAMP_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.(?<fraction>\d+))?)?(?<timeZone>Z|[+-](?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))?$/i;
const SESSION_HISTORY_DAYS_IN_MONTH = [
  31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
] as const;

const sessionHistoryDateTimeFormatter = new Intl.DateTimeFormat(
  SESSION_HISTORY_LOCALE,
  {
    timeZone: SESSION_HISTORY_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }
);

/** Searchable icon keys for the six session History status presentations. */
export type SessionHistoryStatusIconName =
  | "framing"
  | "divergence"
  | "discussion"
  | "convergence"
  | "done"
  | "error";

/** Status, badge, and next-action semantics for one session History row. */
export interface SessionHistoryStatusPresentation {
  status: SessionStatus;
  label: string;
  iconName: SessionHistoryStatusIconName;
  badgeVariant: "default" | "success" | "destructive";
  actionLabel: "Open live" | "Review decisions" | "Inspect failure";
  actionPath: string;
}

interface SessionHistoryStatusDefinition {
  status: SessionStatus;
  label: string;
  iconName: SessionHistoryStatusIconName;
  badgeVariant: SessionHistoryStatusPresentation["badgeVariant"];
  actionLabel: SessionHistoryStatusPresentation["actionLabel"];
  destination: "live" | "results";
}

interface SessionHistoryInstantSortKey {
  epochSeconds: bigint;
  fractionalDigits: string;
}

interface SessionHistoryParsedIsoTimestamp {
  displayDate: Date;
  sortKey: SessionHistoryInstantSortKey;
}

const SESSION_HISTORY_STATUS_DEFINITIONS: Record<
  SessionStatus,
  SessionHistoryStatusDefinition
> = {
  framing: {
    status: "framing",
    label: "Framing",
    iconName: "framing",
    badgeVariant: "default",
    actionLabel: "Open live",
    destination: "live",
  },
  divergence: {
    status: "divergence",
    label: "Divergence",
    iconName: "divergence",
    badgeVariant: "default",
    actionLabel: "Open live",
    destination: "live",
  },
  discussion: {
    status: "discussion",
    label: "Discussion",
    iconName: "discussion",
    badgeVariant: "default",
    actionLabel: "Open live",
    destination: "live",
  },
  convergence: {
    status: "convergence",
    label: "Convergence",
    iconName: "convergence",
    badgeVariant: "default",
    actionLabel: "Open live",
    destination: "live",
  },
  done: {
    status: "done",
    label: "Done",
    iconName: "done",
    badgeVariant: "success",
    actionLabel: "Review decisions",
    destination: "results",
  },
  error: {
    status: "error",
    label: "Error",
    iconName: "error",
    badgeVariant: "destructive",
    actionLabel: "Inspect failure",
    destination: "results",
  },
};

/** UTC display text and an ISO machine value for a session History timestamp. */
export interface SessionHistoryDatePresentation {
  label: string;
  dateTime: string | null;
}

/** Safe, display-ready values for one session History card. */
export interface SessionHistoryCardPresentation {
  sessionId: string;
  theme: string;
  constraints: string;
  status: SessionHistoryStatusPresentation;
  createdAt: SessionHistoryDatePresentation;
  personaCountLabel: string;
  metricsLabel: string;
}

function isSessionHistoryLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function getSessionHistoryDaysInMonth(year: number, month: number): number {
  if (month === 2 && isSessionHistoryLeapYear(year)) return 29;
  return SESSION_HISTORY_DAYS_IN_MONTH[month - 1] ?? 0;
}

function parseSessionHistoryIsoTimestamp(
  timestamp: unknown
): SessionHistoryParsedIsoTimestamp | null {
  if (typeof timestamp !== "string") return null;
  const trimmedTimestamp = timestamp.trim();
  const match = SESSION_HISTORY_ISO_TIMESTAMP_PATTERN.exec(trimmedTimestamp);
  if (match?.groups === undefined) return null;

  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const hour = Number(match.groups.hour);
  const minute = Number(match.groups.minute);
  const second =
    match.groups.second === undefined ? 0 : Number(match.groups.second);
  const offsetHour =
    match.groups.offsetHour === undefined
      ? 0
      : Number(match.groups.offsetHour);
  const offsetMinute =
    match.groups.offsetMinute === undefined
      ? 0
      : Number(match.groups.offsetMinute);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > getSessionHistoryDaysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }

  const localWholeSecondTimestamp = `${match.groups.year}-${match.groups.month}-${match.groups.day}T${match.groups.hour}:${match.groups.minute}:${String(second).padStart(2, "0")}Z`;
  const localWholeSecondMilliseconds = new Date(
    localWholeSecondTimestamp
  ).getTime();
  const offsetSign = match.groups.timeZone?.startsWith("-") ? -1 : 1;
  const offsetSeconds =
    offsetSign * (offsetHour * 60 * 60 + offsetMinute * 60);
  const epochMilliseconds =
    localWholeSecondMilliseconds - offsetSeconds * 1_000;

  if (!Number.isSafeInteger(epochMilliseconds)) return null;

  const fractionalDigits = match.groups.fraction ?? "";
  const displayMilliseconds = Number(
    fractionalDigits.slice(0, 3).padEnd(3, "0")
  );

  return {
    displayDate: new Date(epochMilliseconds + displayMilliseconds),
    sortKey: {
      epochSeconds: BigInt(epochMilliseconds / 1_000),
      fractionalDigits,
    },
  };
}

function getSessionHistoryDatePart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes
): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

function compareSessionHistoryFractionDigits(
  leftFractionalDigits: string,
  rightFractionalDigits: string
): number {
  const normalizedPrecision = Math.max(
    leftFractionalDigits.length,
    rightFractionalDigits.length
  );

  for (let index = 0; index < normalizedPrecision; index += 1) {
    const leftDigit =
      index < leftFractionalDigits.length
        ? leftFractionalDigits.charCodeAt(index)
        : 48;
    const rightDigit =
      index < rightFractionalDigits.length
        ? rightFractionalDigits.charCodeAt(index)
        : 48;
    if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1;
  }

  return 0;
}

function compareSessionHistoryInstantSortKeys(
  leftSortKey: SessionHistoryInstantSortKey,
  rightSortKey: SessionHistoryInstantSortKey
): number {
  if (leftSortKey.epochSeconds !== rightSortKey.epochSeconds) {
    return leftSortKey.epochSeconds < rightSortKey.epochSeconds ? -1 : 1;
  }

  return compareSessionHistoryFractionDigits(
    leftSortKey.fractionalDigits,
    rightSortKey.fractionalDigits
  );
}

function compareSessionHistoryIds(leftId: unknown, rightId: unknown): number {
  const safeLeftId = typeof leftId === "string" ? leftId : "";
  const safeRightId = typeof rightId === "string" ? rightId : "";
  if (safeLeftId === safeRightId) return 0;
  return safeLeftId < safeRightId ? -1 : 1;
}

function normalizeSessionHistoryText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalizedValue = value.trim();
  return normalizedValue === "" ? fallback : normalizedValue;
}

function formatSessionHistoryIdeaCount(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return "Ideas unavailable";
  }
  return `${value} ${value === 1 ? "idea" : "ideas"}`;
}

function formatSessionHistoryMetricDecimal(label: string, value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${label} ${value.toFixed(2)}`
    : `${label} unavailable`;
}

/** Maps every API session status to its icon, English label, and existing next route. */
export function getSessionHistoryStatusPresentation(
  status: SessionStatus,
  sessionId: string
): SessionHistoryStatusPresentation {
  const definition =
    SESSION_HISTORY_STATUS_DEFINITIONS[status] ??
    SESSION_HISTORY_STATUS_DEFINITIONS.error;
  const encodedSessionId = encodeURIComponent(sessionId);
  const actionPath =
    definition.destination === "live"
      ? `/session/${encodedSessionId}`
      : `/session/${encodedSessionId}/results`;

  return {
    status: definition.status,
    label: definition.label,
    iconName: definition.iconName,
    badgeVariant: definition.badgeVariant,
    actionLabel: definition.actionLabel,
    actionPath,
  };
}

/** Formats an API ISO timestamp in English/UTC; timezone-less API values are treated as UTC. */
export function formatSessionHistoryCreatedAt(
  timestamp: string
): SessionHistoryDatePresentation {
  const parsedTimestamp = parseSessionHistoryIsoTimestamp(timestamp);
  if (parsedTimestamp === null) {
    return { label: SESSION_HISTORY_INVALID_DATE_LABEL, dateTime: null };
  }

  const parts = sessionHistoryDateTimeFormatter.formatToParts(
    parsedTimestamp.displayDate
  );
  const month = getSessionHistoryDatePart(parts, "month");
  const day = getSessionHistoryDatePart(parts, "day");
  const year = getSessionHistoryDatePart(parts, "year");
  const hour = getSessionHistoryDatePart(parts, "hour");
  const minute = getSessionHistoryDatePart(parts, "minute");

  return {
    label: `${month} ${day}, ${year} at ${hour}:${minute} ${SESSION_HISTORY_TIME_ZONE}`,
    dateTime: parsedTimestamp.displayDate.toISOString(),
  };
}

/** Triage counts for the History archive masthead index line. */
export interface SessionHistoryArchiveCounts {
  total: number;
  running: number;
  decided: number;
  failed: number;
}

/** Counts sessions into running / decided / failed groups for the archive index. */
export function countSessionHistoryArchiveTriage(
  sessions: readonly Session[]
): SessionHistoryArchiveCounts {
  const counts: SessionHistoryArchiveCounts = {
    total: sessions.length,
    running: 0,
    decided: 0,
    failed: 0,
  };
  for (const session of sessions) {
    if (session.status === "done") counts.decided += 1;
    else if (session.status === "error") counts.failed += 1;
    else counts.running += 1;
  }
  return counts;
}

/** Formats absent, zero, or partially invalid session metrics without hiding valid zeroes. */
export function formatSessionHistoryMetrics(
  metrics: SessionMetrics | null | undefined
): string {
  if (metrics === null || metrics === undefined) return "Metrics unavailable";

  const runtimeMetrics: Partial<SessionMetrics> = metrics;
  return [
    formatSessionHistoryIdeaCount(runtimeMetrics.total_ideas),
    formatSessionHistoryMetricDecimal("NDR", runtimeMetrics.non_duplicate_ratio),
    formatSessionHistoryMetricDecimal(
      "dispersion",
      runtimeMetrics.semantic_dispersion
    ),
  ].join(" · ");
}

/** Derives resilient text, metrics, date, and action values for one session History card. */
export function deriveSessionHistoryCardPresentation(
  session: Session
): SessionHistoryCardPresentation {
  const personaCount = Array.isArray(session.agents) ? session.agents.length : 0;

  return {
    sessionId: session.id,
    theme: normalizeSessionHistoryText(session.theme, "Untitled session"),
    constraints: normalizeSessionHistoryText(
      session.constraints,
      "No constraints provided"
    ),
    status: getSessionHistoryStatusPresentation(session.status, session.id),
    createdAt: formatSessionHistoryCreatedAt(session.created_at),
    personaCountLabel: `${personaCount} ${personaCount === 1 ? "persona" : "personas"}`,
    metricsLabel: formatSessionHistoryMetrics(session.metrics),
  };
}

/** Returns a new latest-first session History array, breaking identical-instant ties by session ID. */
export function sortSessionHistoryNewestFirst(
  sessions: readonly Session[]
): Session[] {
  return sessions
    .map((session, originalIndex) => ({
      session,
      originalIndex,
      parsedTimestamp: parseSessionHistoryIsoTimestamp(session.created_at),
    }))
    .sort((left, right) => {
      if (left.parsedTimestamp === null || right.parsedTimestamp === null) {
        if (left.parsedTimestamp === right.parsedTimestamp) {
          return left.originalIndex - right.originalIndex;
        }
        return left.parsedTimestamp === null ? 1 : -1;
      }

      const instantComparison = compareSessionHistoryInstantSortKeys(
        left.parsedTimestamp.sortKey,
        right.parsedTimestamp.sortKey
      );
      if (instantComparison !== 0) return -instantComparison;

      const idComparison = compareSessionHistoryIds(
        left.session.id,
        right.session.id
      );
      return idComparison === 0
        ? left.originalIndex - right.originalIndex
        : idComparison;
    })
    .map(({ session }) => session);
}

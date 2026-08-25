import {
  ArrowRight,
  CircleCheck,
  Frame,
  GitBranch,
  GitMerge,
  LoaderCircle,
  MessageSquare,
  MoonStar,
  Plus,
  RefreshCw,
  TriangleAlert,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { MoonIcon } from "@/components/moon";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type Session } from "@/lib/api";
import {
  countSessionHistoryArchiveTriage,
  deriveSessionHistoryCardPresentation,
  sortSessionHistoryNewestFirst,
  type SessionHistoryStatusIconName,
  type SessionHistoryStatusPresentation,
} from "@/lib/session-history-presentation";
import { cn } from "@/lib/utils";

const SESSION_HISTORY_HEADING_ID = "session-history-heading";

const SESSION_HISTORY_STATUS_ICONS: Record<
  SessionHistoryStatusIconName,
  LucideIcon
> = {
  framing: Frame,
  divergence: GitBranch,
  discussion: MessageSquare,
  convergence: GitMerge,
  done: CircleCheck,
  error: TriangleAlert,
};

/* Status tiles pair a distinct glyph shape with a status-group tint, so
   running / decided / failed never rely on hue alone. */
const SESSION_HISTORY_STATUS_TILE_CLASS: Record<
  SessionHistoryStatusPresentation["badgeVariant"],
  { tile: string; label: string }
> = {
  default: {
    tile: "border-border bg-secondary/70 text-foreground/70",
    label: "text-muted-foreground",
  },
  success: {
    tile: "border-success/30 bg-success/10 text-success",
    label: "text-success",
  },
  destructive: {
    tile: "border-destructive/30 bg-destructive/10 text-destructive",
    label: "text-destructive",
  },
};

type SessionHistoryLoadState =
  | { status: "loading" }
  | { status: "loaded"; sessions: Session[] }
  | { status: "error"; message: string };

function getSessionHistoryRequestErrorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim() !== "") {
    return reason.message;
  }
  return "Session history request failed. Please try again.";
}

/** Index line of the night masthead: what is on record and where to look. */
function HistoryArchiveMasthead({
  loadState,
}: {
  loadState: SessionHistoryLoadState;
}) {
  let indexLine: ReactNode;
  if (loadState.status === "loading") {
    indexLine = (
      <>
        <LoaderCircle
          aria-hidden="true"
          className="h-3 w-3 animate-spin text-night-muted"
        />
        <span>reading the archive…</span>
      </>
    );
  } else if (loadState.status === "error") {
    indexLine = <span>archive unreachable</span>;
  } else {
    const counts = countSessionHistoryArchiveTriage(loadState.sessions);
    indexLine = (
      <>
        <span className="archive-masthead__index-value">
          {counts.total} {counts.total === 1 ? "session" : "sessions"} on record
        </span>
        {counts.running > 0 && <span>· {counts.running} running</span>}
        {counts.decided > 0 && <span>· {counts.decided} decided</span>}
        {counts.failed > 0 && (
          <span className="text-destructive-night">· {counts.failed} failed</span>
        )}
      </>
    );
  }

  return (
    <header className="archive-masthead p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <p className="archive-masthead__eyebrow">
            <MoonIcon
              illumination={1}
              waning
              className="h-3.5 w-3.5 text-night-foreground/80"
              shadeClassName="fill-white/10"
            />
            Archive ledger
          </p>
          <h1
            id={SESSION_HISTORY_HEADING_ID}
            className="mt-2 font-display text-2xl font-semibold tracking-tight text-night-foreground sm:text-3xl"
          >
            Past councils
          </h1>
          <p className="archive-masthead__index mt-2.5">{indexLine}</p>
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-night-muted">
            Every council is stored locally in SQLite — reopen to replay,
            re-decide, or re-export. All times UTC.
          </p>
        </div>
        <Link to="/" className="archive-masthead__cta">
          <Plus aria-hidden="true" className="h-4 w-4" />
          New session
        </Link>
      </div>
    </header>
  );
}

/** Skeleton ledger that previews the exact masthead + column layout. */
function SessionHistoryLoading() {
  return (
    <section
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-labelledby="session-history-loading-heading"
    >
      <h2 id="session-history-loading-heading" className="sr-only">
        Loading session history
      </h2>
      <p className="sr-only">Loading past sessions.</p>
      <div aria-hidden="true" className="history-ledger">
        <div className="history-ledger__columns">
          <span>Council theme</span>
          <span>Status</span>
          <span>Recorded</span>
          <span>Diversity</span>
          <span className="lg:text-right">Next step</span>
        </div>
        <ul>
          {[0, 1, 2, 3].map((rowIndex) => (
            <li
              key={rowIndex}
              className="history-ledger__row border-t border-border"
            >
              <div className="history-ledger__cell--theme space-y-2">
                <Skeleton className="h-4 w-[82%]" />
                <Skeleton className="h-3 w-[55%]" />
              </div>
              <div className="history-ledger__cell--status flex items-center gap-2">
                <Skeleton className="h-6 w-6 rounded-md" />
                <Skeleton className="h-3 w-14" />
              </div>
              <div className="history-ledger__cell--date">
                <Skeleton className="h-3 w-24" />
              </div>
              <div className="history-ledger__cell--metrics">
                <Skeleton className="h-3 w-full max-w-52" />
              </div>
              <div className="history-ledger__cell--action">
                <Skeleton className="h-10 w-full rounded-md lg:h-9 lg:w-28" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function SessionHistoryRequestError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Alert
      variant="destructive"
      aria-live="assertive"
      aria-atomic="true"
      aria-labelledby="session-history-error-heading"
    >
      <TriangleAlert aria-hidden="true" />
      <h2
        id="session-history-error-heading"
        className="mb-1 font-medium leading-none tracking-tight"
      >
        Could not load session history
      </h2>
      <AlertDescription className="space-y-3">
        <p>{message}</p>
        <p>Start the local izayoi backend, then retry.</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function SessionHistoryEmpty() {
  return (
    <section aria-labelledby="session-history-empty-heading">
      <p role="status" aria-live="polite" className="sr-only">
        No past sessions found.
      </p>
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
          <MoonStar className="h-8 w-8 text-primary" aria-hidden="true" />
          <h2 id="session-history-empty-heading" className="font-medium">
            No past sessions
          </h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            No councils have convened yet. Gather sixteen personas around a theme
            and the moon will keep the record.
          </p>
          <Button asChild>
            <Link to="/">Start first session</Link>
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}

function SessionHistoryStatusCell({
  status,
}: {
  status: SessionHistoryStatusPresentation;
}) {
  const StatusIcon = SESSION_HISTORY_STATUS_ICONS[status.iconName];
  const tileClass =
    SESSION_HISTORY_STATUS_TILE_CLASS[status.badgeVariant];

  return (
    <div
      aria-label={`Status: ${status.label}`}
      className="history-ledger__cell--status flex items-center gap-2"
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border",
          tileClass.tile
        )}
      >
        <StatusIcon className="h-3.5 w-3.5" />
      </span>
      <span
        className={cn(
          "min-w-0 break-words text-xs font-medium [overflow-wrap:anywhere]",
          tileClass.label
        )}
      >
        {status.label}
      </span>
    </div>
  );
}

function SessionHistoryList({ sessions }: { sessions: Session[] }) {
  return (
    <section aria-labelledby="session-history-list-heading">
      <h2 id="session-history-list-heading" className="sr-only">
        Session history
      </h2>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {sessions.length} {sessions.length === 1 ? "session" : "sessions"} loaded.
      </p>
      <div className="history-ledger">
        <div className="history-ledger__columns" aria-hidden="true">
          <span>Council theme</span>
          <span>Status</span>
          <span>Recorded</span>
          <span>Diversity</span>
          <span className="lg:text-right">Next step</span>
        </div>
        <ul className="divide-y">
          {sessions.map((session) => {
            const presentation = deriveSessionHistoryCardPresentation(session);

            return (
              <li key={presentation.sessionId} className="history-ledger__row">
                <article className="history-ledger__cell--theme">
                  <h3 className="min-w-0">
                    <Link
                      to={presentation.status.actionPath}
                      title={presentation.theme}
                      className="history-ledger__theme line-clamp-2"
                    >
                      {presentation.theme}
                    </Link>
                  </h3>
                  <p
                    title={presentation.constraints}
                    className="mt-0.5 line-clamp-1 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]"
                  >
                    {presentation.constraints}
                  </p>
                </article>
                <SessionHistoryStatusCell status={presentation.status} />
                <div className="history-ledger__cell--date">
                  {presentation.createdAt.dateTime === null ? (
                    <span>{presentation.createdAt.label}</span>
                  ) : (
                    <time dateTime={presentation.createdAt.dateTime}>
                      {presentation.createdAt.label}
                    </time>
                  )}
                </div>
                <div className="history-ledger__cell--metrics">
                  <p className="break-words font-mono text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                    <span className="inline-flex items-center gap-1">
                      <Users className="h-3 w-3 shrink-0" aria-hidden="true" />
                      {presentation.personaCountLabel}
                    </span>{" "}
                    · {presentation.metricsLabel}
                  </p>
                </div>
                <div className="history-ledger__cell--action">
                  <Link
                    to={presentation.status.actionPath}
                    aria-label={`${presentation.status.actionLabel}: ${presentation.theme}`}
                    className="history-ledger__action"
                  >
                    {presentation.status.actionLabel}
                    <ArrowRight aria-hidden="true" className="h-4 w-4" />
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/** Loads and presents the latest-first session History with status-specific next actions. */
export function History() {
  const [loadState, setLoadState] = useState<SessionHistoryLoadState>({
    status: "loading",
  });
  const [requestVersion, setRequestVersion] = useState(0);
  const latestRequestId = useRef(0);

  useEffect(() => {
    const requestId = latestRequestId.current + 1;
    latestRequestId.current = requestId;
    let acceptsStateUpdates = true;

    setLoadState({ status: "loading" });
    void api
      .listSessions()
      .then((response) => {
        if (!acceptsStateUpdates || latestRequestId.current !== requestId) return;
        if (!Array.isArray(response.sessions)) {
          throw new Error("Session history response is missing its session list.");
        }
        setLoadState({
          status: "loaded",
          sessions: sortSessionHistoryNewestFirst(response.sessions),
        });
      })
      .catch((reason: unknown) => {
        if (!acceptsStateUpdates || latestRequestId.current !== requestId) return;
        setLoadState({
          status: "error",
          message: getSessionHistoryRequestErrorMessage(reason),
        });
      });

    return () => {
      acceptsStateUpdates = false;
    };
  }, [requestVersion]);

  const retrySessionHistoryRequest = () => {
    setLoadState({ status: "loading" });
    setRequestVersion((currentVersion) => currentVersion + 1);
  };

  return (
    <div
      className="space-y-6"
      aria-labelledby={SESSION_HISTORY_HEADING_ID}
      aria-busy={loadState.status === "loading"}
    >
      <HistoryArchiveMasthead loadState={loadState} />
      {loadState.status === "loading" && <SessionHistoryLoading />}
      {loadState.status === "error" && (
        <SessionHistoryRequestError
          message={loadState.message}
          onRetry={retrySessionHistoryRequest}
        />
      )}
      {loadState.status === "loaded" && loadState.sessions.length === 0 && (
        <SessionHistoryEmpty />
      )}
      {loadState.status === "loaded" && loadState.sessions.length > 0 && (
        <SessionHistoryList sessions={loadState.sessions} />
      )}
    </div>
  );
}

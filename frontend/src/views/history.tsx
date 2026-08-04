import { ArrowRight, MoonStar, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type Session, type SessionStatus } from "@/lib/api";

const STATUS_BADGE: Record<SessionStatus, { label: string; variant: "secondary" | "default" | "success" | "destructive" | "caution" }> = {
  framing: { label: "Framing", variant: "default" },
  divergence: { label: "Diverging", variant: "default" },
  discussion: { label: "Discussing", variant: "default" },
  convergence: { label: "Converging", variant: "default" },
  done: { label: "Done", variant: "success" },
  error: { label: "Error", variant: "destructive" },
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function History() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listSessions()
      .then((r) => setSessions(r.sessions))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load history"));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Past councils</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every session is stored locally in SQLite — replay, re-decide, or re-export anytime.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Could not load history</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!sessions && !error && (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {sessions?.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <MoonStar className="h-8 w-8 text-primary" />
            <p className="text-sm text-muted-foreground">
              No councils have convened yet. Gather sixteen personas around a theme and the
              moon will keep the record.
            </p>
            <Button asChild>
              <Link to="/">Start your first session</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {sessions?.map((session) => {
          const badge = STATUS_BADGE[session.status];
          const running = session.status !== "done" && session.status !== "error";
          return (
            <Card key={session.id} className="transition-colors hover:border-foreground/25">
              <CardContent className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={running ? `/session/${session.id}` : `/session/${session.id}/results`}
                      className="truncate font-medium hover:underline"
                    >
                      {session.theme}
                    </Link>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>{formatDate(session.created_at)}</span>
                    <span className="inline-flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {session.agents.length} personas
                    </span>
                    {session.metrics && (
                      <span className="font-mono">
                        {session.metrics.total_ideas} ideas · NDR{" "}
                        {session.metrics.non_duplicate_ratio.toFixed(2)} · dispersion{" "}
                        {session.metrics.semantic_dispersion.toFixed(2)}
                      </span>
                    )}
                  </div>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to={running ? `/session/${session.id}` : `/session/${session.id}/results`}>
                    {running ? "Open live" : "Open results"}
                    <ArrowRight />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

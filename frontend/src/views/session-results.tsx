import {
  AlertTriangle,
  ArrowLeft,
  Download,
  Info,
  MoonStar,
  Play,
  ScrollText,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { DiscussionLog, type LogMessage } from "@/components/discussion-log";
import { IdeaCard } from "@/components/idea-card";
import { MetricsTiles } from "@/components/metrics-tiles";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type ChatMessage, type Idea, type Session } from "@/lib/api";

interface Cluster {
  id: number | null;
  ideas: Idea[];
  synthesized: string | null;
}

function groupIntoClusters(ideas: Idea[]): Cluster[] {
  const byCluster = new Map<number | null, Idea[]>();
  for (const idea of ideas) {
    const key = idea.cluster_id;
    byCluster.set(key, [...(byCluster.get(key) ?? []), idea]);
  }
  return [...byCluster.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([id, members]) => ({
      id,
      ideas: members,
      synthesized: members.find((m) => m.synthesized)?.synthesized ?? null,
    }));
}

export function SessionResults() {
  const { id = "" } = useParams();
  const [session, setSession] = useState<Session | null>(null);
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.getSession(id), api.listIdeas(id), api.listMessages(id)])
      .then(([s, i, m]) => {
        setSession(s);
        setIdeas(i.ideas);
        setMessages(m.messages);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load results"));
  }, [id]);

  const clusters = useMemo(() => (ideas ? groupIntoClusters(ideas) : []), [ideas]);
  const framing = messages.find((m) => m.round === 0);
  const logMessages: LogMessage[] = messages
    .filter((m) => m.round >= 1)
    .map((m) => ({ round: m.round, from: m.anon_name, content: m.content }));
  const counts = useMemo(() => {
    const all = ideas ?? [];
    return {
      adopted: all.filter((i) => i.decision === "adopted").length,
      held: all.filter((i) => i.decision === "held").length,
      rejected: all.filter((i) => i.decision === "rejected").length,
      pending: all.filter((i) => i.decision === "pending").length,
    };
  }, [ideas]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>Could not load results</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!session || !ideas) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const running = session.status !== "done" && session.status !== "error";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl">
          <Button asChild variant="ghost" size="sm" className="-ml-2 mb-1">
            <Link to={`/session/${id}`}>
              <ArrowLeft />
              Live view
            </Link>
          </Button>
          <h1 className="font-display text-2xl font-semibold tracking-tight">{session.theme}</h1>
          {session.constraints && (
            <p className="mt-1 text-sm text-muted-foreground">Constraints: {session.constraints}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <a href={api.exportUrl(id, "md")} download>
              <Download />
              Markdown
            </a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={api.exportUrl(id, "json")} download>
              <Download />
              JSON
            </a>
          </Button>
        </div>
      </div>

      {running && (
        <Alert variant="caution">
          <Play />
          <AlertTitle>Session still running</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            These results are partial. Clusters, synthesis and scores appear after convergence.
            <Button asChild size="sm" variant="outline">
              <Link to={`/session/${id}`}>Watch it live</Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {session.metrics && <MetricsTiles metrics={session.metrics} />}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Decisions:</span>
        <Badge variant="success">{counts.adopted} adopted</Badge>
        <Badge variant="caution">{counts.held} held</Badge>
        <Badge variant="destructive">{counts.rejected} rejected</Badge>
        <Badge variant="secondary">{counts.pending} pending</Badge>
      </div>

      {framing && (
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <MoonStar className="h-4 w-4 text-primary" />
              Facilitator framing
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-1">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {framing.content}
            </p>
          </CardContent>
        </Card>
      )}

      <Alert>
        <Info />
        <AlertTitle>LLM scores are advisory</AlertTitle>
        <AlertDescription>
          Judge scores agree with human ranking only about half the time. Use them to triage,
          not to decide — your adopt/hold/reject calls and memos are the record that matters.
        </AlertDescription>
      </Alert>

      <section className="space-y-5">
        <h2 className="font-display text-xl font-semibold">
          Clusters <span className="font-mono text-sm font-normal text-muted-foreground">({clusters.length})</span>
        </h2>
        {clusters.map((cluster) => (
          <Card key={cluster.id ?? "unclustered"}>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                {cluster.id !== null ? (
                  <>
                    <span className="font-mono">Cluster #{cluster.id}</span>
                    <Badge variant="secondary">{cluster.ideas.length} ideas</Badge>
                  </>
                ) : (
                  "Not yet clustered"
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-1">
              {cluster.synthesized && (
                <div className="rounded-md border border-primary/30 bg-accent/50 p-3">
                  <p className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-wide text-primary">
                    Synthesized by the facilitator
                  </p>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{cluster.synthesized}</p>
                </div>
              )}
              {cluster.ideas.map((idea) => (
                <IdeaCard
                  key={idea.id}
                  idea={idea}
                  onChange={(updated) =>
                    setIdeas((prev) =>
                      prev ? prev.map((i) => (i.id === updated.id ? updated : i)) : prev
                    )
                  }
                />
              ))}
            </CardContent>
          </Card>
        ))}
      </section>

      {logMessages.length > 0 && (
        <details className="group rounded-lg border bg-card">
          <summary className="flex cursor-pointer items-center gap-2 p-4 text-sm font-medium">
            <ScrollText className="h-4 w-4 text-primary" />
            Discussion transcript ({logMessages.length} turns, anonymized)
          </summary>
          <div className="border-t p-4">
            <DiscussionLog messages={logMessages} />
          </div>
        </details>
      )}
    </div>
  );
}

import { AlertTriangle, ArrowRight, Lightbulb, MoonStar } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { AgentCard, type AgentViewState } from "@/components/agent-card";
import { DiscussionLog, type LogMessage } from "@/components/discussion-log";
import { MetricsTiles } from "@/components/metrics-tiles";
import { PersonaBadge } from "@/components/persona-badge";
import { PhaseStepper } from "@/components/phase-stepper";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScoreBadges } from "@/components/score-badge";
import {
  api,
  subscribeSession,
  type Idea,
  type Session,
  type SessionMetrics,
} from "@/lib/api";

const INITIAL_AGENT_STATE: AgentViewState = { status: "waiting", text: "", task: "", round: 0 };
const MAX_STREAM_CHARS = 30_000;

export function SessionLive() {
  const { id = "" } = useParams();
  const [session, setSession] = useState<Session | null>(null);
  const [phase, setPhase] = useState("framing");
  const [agents, setAgents] = useState<Record<string, AgentViewState>>({});
  const [messages, setMessages] = useState<LogMessage[]>([]);
  // P2: idea events arrive twice; a Map keyed by id upserts naturally.
  const [ideas, setIdeas] = useState<Map<string, Idea>>(new Map());
  const [metrics, setMetrics] = useState<SessionMetrics | null>(null);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [personaNames, setPersonaNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    api.personas().then((r) =>
      setPersonaNames(new Map(r.personas.map((p) => [p.type, p.name_ja])))
    );
  }, []);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    api
      .getSession(id)
      .then((s) => {
        if (cancelled) return;
        setSession(s);
        setPhase(s.status === "error" ? "framing" : s.status);
        setFinished(s.status === "done" || s.status === "error");
        if (s.status === "error") setError(s.phase_progress || "Session failed");
        if (s.metrics) setMetrics(s.metrics);
        const initial: Record<string, AgentViewState> = {};
        for (const agent of s.agents) initial[agent.persona_type] = INITIAL_AGENT_STATE;
        setAgents(initial);

        unsubscribe = subscribeSession(id, {
          onEvent: (event) => {
            switch (event.type) {
              case "phase":
                setPhase(event.phase);
                if (event.phase === "done" || event.phase === "error") setFinished(true);
                break;
              case "agent_start":
                setAgents((prev) => ({
                  ...prev,
                  [event.agent]: { status: "streaming", text: "", task: event.task, round: event.round },
                }));
                break;
              case "token":
                setAgents((prev) => {
                  const current = prev[event.agent] ?? INITIAL_AGENT_STATE;
                  return {
                    ...prev,
                    [event.agent]: {
                      ...current,
                      text: (current.text + event.delta).slice(-MAX_STREAM_CHARS),
                    },
                  };
                });
                break;
              case "agent_done":
                setAgents((prev) => ({
                  ...prev,
                  [event.agent]: { ...(prev[event.agent] ?? INITIAL_AGENT_STATE), status: "done" },
                }));
                break;
              case "idea":
                setIdeas((prev) => {
                  const next = new Map(prev);
                  next.set(event.idea.id, event.idea);
                  return next;
                });
                break;
              case "message":
                setMessages((prev) => [
                  ...prev,
                  { round: event.round, from: event.from, content: event.content },
                ]);
                break;
              case "metrics":
                setMetrics(event.metrics);
                break;
              case "error":
                setError(event.message);
                setFinished(true);
                break;
            }
          },
          onReset: () => {
            // Reconnect rule: transient per-token and log state restarts clean;
            // ideas/metrics survive because they re-upsert from the replay.
            setAgents((prev) => {
              const reset: Record<string, AgentViewState> = {};
              for (const key of Object.keys(prev)) reset[key] = INITIAL_AGENT_STATE;
              return reset;
            });
            setMessages([]);
          },
          onError: (message) => setError(message),
        });
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load session"));

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [id]);

  const ideaList = useMemo(() => [...ideas.values()], [ideas]);
  const running = !finished;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl">
          <h1 className="truncate font-display text-2xl font-semibold tracking-tight">
            {session?.theme ?? "Session"}
          </h1>
          {session?.constraints && (
            <p className="mt-1 text-sm text-muted-foreground">
              Constraints: {session.constraints}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {running && (
            <Badge variant="default" className="gap-1.5">
              <MoonStar className="h-3 w-3 animate-spin" />
              Live
            </Badge>
          )}
          <Button asChild variant={finished ? "default" : "outline"} size="sm">
            <Link to={`/session/${id}/results`}>
              Results
              <ArrowRight />
            </Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-5">
          <PhaseStepper current={phase} />
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {metrics && <MetricsTiles metrics={metrics} />}

      <section>
        <h2 className="mb-3 font-display text-lg font-semibold">The council at work</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {(session?.agents ?? []).map((agent) => (
            <AgentCard
              key={agent.persona_type}
              agent={agent}
              personaName={personaNames.get(agent.persona_type) ?? ""}
              state={agents[agent.persona_type] ?? INITIAL_AGENT_STATE}
              sessionFinished={finished}
            />
          ))}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <DiscussionLog messages={messages} />
        <Card className="flex min-h-0 flex-col">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Lightbulb className="h-4 w-4 text-primary" />
              Confirmed ideas
              <Badge variant="secondary" className="font-mono">
                {ideaList.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="max-h-96 flex-1 space-y-2.5 overflow-y-auto p-4 pt-2">
            {ideaList.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Ideas land here the moment each persona finishes its independent pass.
              </p>
            )}
            {ideaList.map((idea) => (
              <div key={idea.id} className="animate-fade-in rounded-md border bg-card p-3">
                <p className="text-sm leading-relaxed">{idea.content}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <PersonaBadge type={idea.persona_type} />
                  <Badge variant="outline" className="font-normal">
                    {idea.phase === "divergence" ? "Independent" : "Discussion"}
                  </Badge>
                  {idea.cluster_id !== null && (
                    <Badge variant="outline" className="font-mono font-normal">
                      #{idea.cluster_id}
                    </Badge>
                  )}
                  {idea.scores && <ScoreBadges scores={idea.scores} />}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {finished && !error && (
        <Alert variant="success">
          <MoonStar />
          <AlertTitle>The sixteenth night has arrived</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            The council has finished. Review the clusters, weigh the scores, and make the
            final call — it is yours, not the judge's.
            <Button asChild size="sm" variant="outline">
              <Link to={`/session/${id}/results`}>
                Go to results
                <ArrowRight />
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

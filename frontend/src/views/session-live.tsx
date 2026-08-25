import { AlertTriangle, ArrowRight, MoonStar, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { AgentCard, type AgentViewState } from "@/components/agent-card";
import { ConfirmedIdeasLedger } from "@/components/confirmed-ideas-ledger";
import { DiscussionLog, type LogMessage } from "@/components/discussion-log";
import { LiveMasthead, type SessionLiveLoadState } from "@/components/live-masthead";
import { SessionNotFoundState } from "@/components/session-not-found-alert";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  api,
  subscribeSession,
  type Idea,
  type Session,
  type SessionMetrics,
  type SessionStreamConnectionState,
} from "@/lib/api";
import { classifySessionRequestFailure } from "@/lib/session-not-found-request-error";
import {
  appendSessionAgentOutput,
  compactSessionAgentOutput,
  createSessionAgentOutputState,
  resetSessionAgentOutput,
  type SessionAgentOutputRetentionRequest,
} from "@/lib/session-agent-output";
import {
  getInitialSessionLivePhase,
  hasSessionLiveDiscussionOpened,
  reduceSessionLivePhase,
  type SessionLivePhase,
} from "@/lib/session-live-phase";

const INITIAL_AGENT_STATE: AgentViewState = {
  status: "waiting",
  output: createSessionAgentOutputState(),
  task: "",
  round: 0,
};

/** Live session view driven by the replay-safe session SSE contract. */
export function SessionLive() {
  const { id = "" } = useParams();
  const [session, setSession] = useState<Session | null>(null);
  const [loadState, setLoadState] = useState<SessionLiveLoadState | "not-found">(
    "loading"
  );
  const [phase, setPhase] = useState<SessionLivePhase | null>(null);
  const [connectionState, setConnectionState] =
    useState<SessionStreamConnectionState>("connecting");
  const [streamDisconnectMessage, setStreamDisconnectMessage] = useState<string | null>(null);
  const [streamReplayVersion, setStreamReplayVersion] = useState(0);
  const [agents, setAgents] = useState<Record<string, AgentViewState>>({});
  const [messages, setMessages] = useState<LogMessage[]>([]);
  // P2: idea events arrive twice; a Map keyed by id upserts naturally.
  const [ideas, setIdeas] = useState<Map<string, Idea>>(new Map());
  const [metrics, setMetrics] = useState<SessionMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [personaNames, setPersonaNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    api
      .personas()
      .then((response) => {
        if (cancelled) return;
        setPersonaNames(
          new Map(response.personas.map((persona) => [persona.type, persona.name_ja]))
        );
      })
      .catch(() => {
        // Persona labels are optional presentation data; type codes remain available.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    setSession(null);
    setLoadState("loading");
    setPhase(null);
    setConnectionState("connecting");
    setStreamDisconnectMessage(null);
    setStreamReplayVersion((version) => version + 1);
    setAgents({});
    setMessages([]);
    setIdeas(new Map());
    setMetrics(null);
    setError(null);

    api
      .getSession(id)
      .then((loadedSession) => {
        if (cancelled) return;

        const initialPhase = getInitialSessionLivePhase(loadedSession.status);
        const sessionFailed = loadedSession.status === "error";
        setSession(loadedSession);
        setLoadState("ready");
        setPhase(initialPhase);
        if (sessionFailed) setError(loadedSession.phase_progress || "Session failed");
        if (loadedSession.metrics) setMetrics(loadedSession.metrics);
        const initialAgents: Record<string, AgentViewState> = {};
        for (const agent of loadedSession.agents) {
          initialAgents[agent.persona_type] = INITIAL_AGENT_STATE;
        }
        setAgents(initialAgents);

        unsubscribe = subscribeSession(id, {
          onEvent: (event) => {
            switch (event.type) {
              case "phase":
                if (event.phase === "error") {
                  setError((currentError) => currentError ?? "The session ended with an error.");
                  break;
                }
                setPhase((currentPhase) =>
                  reduceSessionLivePhase({ currentPhase, receivedPhase: event.phase })
                );
                break;
              case "agent_start":
                setAgents((previousAgents) => {
                  const currentAgent = previousAgents[event.agent] ?? INITIAL_AGENT_STATE;
                  return {
                    ...previousAgents,
                    [event.agent]: {
                      status: "streaming",
                      output: resetSessionAgentOutput({ currentOutput: currentAgent.output }),
                      task: event.task,
                      round: event.round,
                    },
                  };
                });
                break;
              case "token":
                setAgents((previousAgents) => {
                  const currentAgent = previousAgents[event.agent] ?? INITIAL_AGENT_STATE;
                  return {
                    ...previousAgents,
                    [event.agent]: {
                      ...currentAgent,
                      output: appendSessionAgentOutput({
                        currentOutput: currentAgent.output,
                        delta: event.delta,
                      }),
                    },
                  };
                });
                break;
              case "agent_done":
                setAgents((previousAgents) => ({
                  ...previousAgents,
                  [event.agent]: {
                    ...(previousAgents[event.agent] ?? INITIAL_AGENT_STATE),
                    status: "done",
                  },
                }));
                break;
              case "idea":
                setIdeas((previousIdeas) => {
                  const nextIdeas = new Map(previousIdeas);
                  nextIdeas.set(event.idea.id, event.idea);
                  return nextIdeas;
                });
                break;
              case "message":
                setMessages((previousMessages) => [
                  ...previousMessages,
                  { round: event.round, from: event.from, content: event.content },
                ]);
                break;
              case "metrics":
                setMetrics(event.metrics);
                break;
              case "error":
                setError(event.message);
                break;
            }
          },
          onReset: () => {
            // Reconnect rule: transient per-token and log state restarts clean;
            // ideas/metrics survive because they re-upsert from the replay.
            setStreamReplayVersion((version) => version + 1);
            setAgents((previousAgents) => {
              const resetAgents: Record<string, AgentViewState> = {};
              for (const key of Object.keys(previousAgents)) {
                resetAgents[key] = {
                  ...INITIAL_AGENT_STATE,
                  output: resetSessionAgentOutput({
                    currentOutput: previousAgents[key].output,
                  }),
                };
              }
              return resetAgents;
            });
            setMessages([]);
          },
          onConnectionStateChange: (nextConnectionState) => {
            setConnectionState(nextConnectionState);
            if (nextConnectionState !== "disconnected") setStreamDisconnectMessage(null);
          },
          onError: (message) => {
            setConnectionState("disconnected");
            setStreamDisconnectMessage(message);
          },
        });
      })
      .catch((caughtError) => {
        if (cancelled) return;
        const requestFailure = classifySessionRequestFailure(
          caughtError,
          "Failed to load session"
        );
        if (requestFailure.kind === "not-found") {
          setLoadState("not-found");
          return;
        }
        setLoadState("failed");
        setError(requestFailure.message);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [id]);

  const handleAgentOutputRetentionRequest = useCallback(
    (
      agentPersonaType: string,
      retentionRequest: SessionAgentOutputRetentionRequest
    ) => {
      setAgents((previousAgents) => {
        const currentAgent = previousAgents[agentPersonaType];
        if (!currentAgent) return previousAgents;

        const compactedOutput = compactSessionAgentOutput({
          currentOutput: currentAgent.output,
          retentionRequest,
        });
        if (compactedOutput === currentAgent.output) return previousAgents;

        return {
          ...previousAgents,
          [agentPersonaType]: {
            ...currentAgent,
            output: compactedOutput,
          },
        };
      });
    },
    []
  );

  const ideaList = useMemo(() => [...ideas.values()], [ideas]);
  const discussionOpened = hasSessionLiveDiscussionOpened(phase);
  const sessionCompleted = phase === "done" && error === null;
  const sessionFailed = error !== null;
  const sessionFinished = sessionCompleted || sessionFailed;
  const discussionHistoryLoading =
    discussionOpened &&
    messages.length === 0 &&
    (connectionState === "connecting" ||
      connectionState === "reconnecting" ||
      (sessionFinished &&
        connectionState !== "complete" &&
        connectionState !== "disconnected"));
  const discussionEmptyMessage =
    connectionState === "disconnected"
      ? "Discussion updates are unavailable while the live stream is disconnected."
      : connectionState === "complete" || sessionCompleted
        ? "No discussion messages were recorded for this session."
        : "Discussion is open. Messages will appear as the council exchanges ideas.";

  if (loadState === "not-found") {
    return <SessionNotFoundState heading="Session" />;
  }

  return (
    <div className="space-y-6">
      <LiveMasthead
        session={session}
        loadState={loadState}
        phase={phase}
        phaseStatus={loadState === "loading" ? "loading" : sessionFailed ? "failed" : "active"}
        connectionState={connectionState}
        hasError={sessionFailed}
        metrics={metrics}
        resultsHref={`/session/${id}/results`}
        resultsEmphasized={sessionFinished}
      />

      {error && (
        <Alert role="alert" aria-live="assertive" variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {streamDisconnectMessage && !error && (
        <Alert role="alert" aria-live="assertive" variant="destructive">
          <WifiOff aria-hidden="true" />
          <AlertTitle>Live updates disconnected</AlertTitle>
          <AlertDescription>
            {streamDisconnectMessage} The session may still be running. Reload this page to try
            again.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start">
        {/* Main region: the council's live workbenches. */}
        <section aria-labelledby="session-live-agents-heading" className="min-w-0">
          <h2
            id="session-live-agents-heading"
            className="mb-3 border-b border-border pb-3 font-display text-lg font-semibold tracking-tight"
          >
            The council at work
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            {loadState === "loading" && (
              <p role="status" className="text-sm text-muted-foreground">
                Loading council members…
              </p>
            )}
            {(session?.agents ?? []).map((agent) => (
              <AgentCard
                key={agent.persona_type}
                agent={agent}
                personaName={personaNames.get(agent.persona_type) ?? ""}
                state={agents[agent.persona_type] ?? INITIAL_AGENT_STATE}
                sessionFinished={sessionCompleted}
                sessionFailed={sessionFailed}
                replayVersion={streamReplayVersion}
                onOutputRetentionRequest={handleAgentOutputRetentionRequest}
              />
            ))}
          </div>
        </section>

        {/* Auxiliary rail: what is confirmed, and what the council is debating. */}
        <div className="min-w-0 space-y-6">
          <ConfirmedIdeasLedger ideas={ideaList} />
          <DiscussionLog
            messages={messages}
            availability={discussionOpened ? "available" : "future"}
            emptyMessage={discussionEmptyMessage}
            isLoading={discussionHistoryLoading}
            replayVersion={streamReplayVersion}
          />
        </div>
      </div>

      {sessionCompleted && (
        <Alert role="status" aria-live="polite" variant="success">
          <MoonStar aria-hidden="true" />
          <AlertTitle>The sixteenth night has arrived</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            The council has finished. Review the clusters, weigh the scores, and make the final
            call — it is yours, not the judge's.
            <Button asChild size="sm" variant="outline">
              <Link to={`/session/${id}/results`}>
                Go to results
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

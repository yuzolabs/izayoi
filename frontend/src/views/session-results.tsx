import { ArrowLeft, MoonStar, Play, ScrollText } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import { Link, useParams } from "react-router-dom";

import { DiscussionLog, type LogMessage } from "@/components/discussion-log";
import { IdeaCard } from "@/components/idea-card";
import { MetricsTiles } from "@/components/metrics-tiles";
import { ResultsClusterDossier } from "@/components/results-cluster-dossier";
import { ResultsDecisionIndex } from "@/components/results-decision-index";
import { SessionNotFoundState } from "@/components/session-not-found-alert";
import { SessionResultsExportAlert } from "@/components/session-results-export-alert";
import { SessionResultsFailureAlert } from "@/components/session-results-failure-alert";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type ChatMessage, type Idea, type Session } from "@/lib/api";
import {
  classifySessionRequestFailure,
  type SessionRequestFailure,
} from "@/lib/session-not-found-request-error";
import {
  createResultsClusterDisclosureState,
  isResultsClusterExpanded,
  reduceResultsClusterDisclosureState,
} from "@/lib/session-results-cluster-disclosure-state";
import {
  createResultsDecisionWorkspaceState,
  deriveResultsDecisionWorkspace,
  deriveSessionResultsAvailability,
  reduceResultsDecisionWorkspaceState,
  type ResultsIdeaSaveState,
} from "@/lib/session-results-decision-state";
import type { SessionResultsMutationJournal } from "@/lib/session-results-mutation-journal";
import {
  type SessionResultsMutationRecoveryPolicy,
  useSessionResultsIdeaMutationCoordinator,
} from "@/lib/use-session-results-idea-mutation-coordinator";
import { useSessionResultsExport } from "@/lib/use-session-results-export";
import {
  getSessionResultsClusterHeaderId,
  SESSION_RESULTS_CLEAR_FILTER_CONTROL_ID,
  SESSION_RESULTS_COLLAPSE_ALL_CONTROL_ID,
  SESSION_RESULTS_EXPAND_ALL_CONTROL_ID,
  useSessionResultsFocusRecovery,
} from "@/lib/use-session-results-focus-recovery";

const RESULTS_LLM_SCORE_ADVISORY_ID = "results-llm-score-advisory";

interface SessionResultsProps {
  mutationJournal?: SessionResultsMutationJournal;
  mutationRecoveryPolicy?: SessionResultsMutationRecoveryPolicy;
}

/** Results workspace with decision filtering, cluster disclosure, and resilient saves. */
export function SessionResults({
  mutationJournal,
  mutationRecoveryPolicy,
}: SessionResultsProps = {}) {
  const { id = "" } = useParams();
  const [session, setSession] = useState<Session | null>(null);
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [requestFailure, setRequestFailure] = useState<SessionRequestFailure | null>(
    null
  );
  const [workspaceState, dispatchWorkspaceAction] = useReducer(
    reduceResultsDecisionWorkspaceState,
    undefined,
    createResultsDecisionWorkspaceState
  );
  const [clusterDisclosureState, dispatchClusterDisclosureAction] = useReducer(
    reduceResultsClusterDisclosureState,
    undefined,
    createResultsClusterDisclosureState
  );
  const [ideaSaveStates, setIdeaSaveStates] = useState<Record<string, ResultsIdeaSaveState>>(
    {}
  );
  const [saveAnnouncement, setSaveAnnouncement] = useState("");

  const resultsAvailability = deriveSessionResultsAvailability(
    session,
    ideas,
    requestFailure?.kind === "error" ? requestFailure.message : null
  );
  const decisionWorkspace = useMemo(
    () => deriveResultsDecisionWorkspace(ideas ?? [], workspaceState.activeFilter),
    [ideas, workspaceState.activeFilter]
  );
  const visibleClusterKeys = useMemo(
    () => decisionWorkspace.visibleClusters.map((cluster) => cluster.key),
    [decisionWorkspace.visibleClusters]
  );
  useLayoutEffect(() => {
    if (ideas === null) return;
    dispatchClusterDisclosureAction({
      type: "matching-clusters-changed",
      clusterKeys: visibleClusterKeys,
    });
  }, [ideas, visibleClusterKeys]);

  const allVisibleClustersExpanded =
    visibleClusterKeys.length > 0 &&
    visibleClusterKeys.every((clusterKey) =>
      isResultsClusterExpanded(clusterDisclosureState, clusterKey)
    );
  const allVisibleClustersCollapsed =
    visibleClusterKeys.length > 0 &&
    visibleClusterKeys.every(
      (clusterKey) => !isResultsClusterExpanded(clusterDisclosureState, clusterKey)
    );
  const activeFilterLabel =
    workspaceState.activeFilter === "all"
      ? "All"
      : workspaceState.activeFilter.charAt(0).toUpperCase() + workspaceState.activeFilter.slice(1);
  const firstExpandedVisibleClusterKey = visibleClusterKeys.find((clusterKey) =>
    isResultsClusterExpanded(clusterDisclosureState, clusterKey)
  );
  const contentFocusTargetId =
    firstExpandedVisibleClusterKey !== undefined
      ? getSessionResultsClusterHeaderId(firstExpandedVisibleClusterKey)
      : ideas !== null && ideas.length > 0 && visibleClusterKeys.length === 0
        ? SESSION_RESULTS_CLEAR_FILTER_CONTROL_ID
        : null;
  const {
    prepareSessionResultsContentFocus,
    prepareSessionResultsDisclosureControlFocus,
  } = useSessionResultsFocusRecovery(contentFocusTargetId);

  const {
    exportError,
    exportInProgress,
    exportSessionResults,
    retrySessionResultsExport,
  } = useSessionResultsExport(id);

  const {
    recoverLoadedResultsIdeaMutations,
    saveResultsIdeaDecision,
    retryFailedResultsIdeaDecision,
    resetResultsIdeaMutationGeneration,
  } = useSessionResultsIdeaMutationCoordinator({
    sessionId: id,
    setIdeas,
    setIdeaSaveStates,
    setSaveAnnouncement,
    prepareSessionResultsContentFocus,
    mutationJournal,
    recoveryPolicy: mutationRecoveryPolicy,
  });

  useEffect(() => {
    let cancelled = false;
    resetResultsIdeaMutationGeneration();
    setSession(null);
    setIdeas(null);
    setMessages([]);
    setRequestFailure(null);
    setIdeaSaveStates({});
    setSaveAnnouncement("");
    dispatchWorkspaceAction({ type: "workspace-reset" });
    dispatchClusterDisclosureAction({ type: "cluster-disclosure-reset" });

    Promise.all([api.getSession(id), api.listIdeas(id), api.listMessages(id)])
      .then(([loadedSession, loadedIdeas, loadedMessages]) => {
        if (cancelled) return;
        const recoveredIdeas = recoverLoadedResultsIdeaMutations(
          loadedIdeas.ideas
        );
        setSession(loadedSession);
        setIdeas(recoveredIdeas);
        setMessages(loadedMessages.messages);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setRequestFailure(
          classifySessionRequestFailure(loadError, "Failed to load results")
        );
      });

    return () => {
      cancelled = true;
    };
  }, [
    id,
    recoverLoadedResultsIdeaMutations,
    resetResultsIdeaMutationGeneration,
  ]);

  const framing = messages.find((message) => message.round === 0);
  const logMessages: LogMessage[] = messages
    .filter((message) => message.round >= 1)
    .map((message) => ({
      round: message.round,
      from: message.anon_name,
      content: message.content,
    }));

  if (requestFailure?.kind === "not-found") {
    return <SessionNotFoundState heading="Session results" />;
  }

  if (resultsAvailability.kind === "load-error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load results</AlertTitle>
        <AlertDescription>{resultsAvailability.message}</AlertDescription>
      </Alert>
    );
  }

  if (resultsAvailability.kind === "loading" || session === null || ideas === null) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[19.5rem_minmax(0,1fr)] lg:items-start lg:gap-8">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {saveAnnouncement}
      </p>

      <ResultsDecisionIndex
        liveHref={`/session/${id}`}
        theme={session.theme}
        constraints={session.constraints || null}
        status={
          resultsAvailability.kind === "failed"
            ? { kind: "failed", empty: resultsAvailability.empty }
            : resultsAvailability.running
              ? { kind: "running" }
              : { kind: "done" }
        }
        counts={decisionWorkspace.counts}
        activeFilter={workspaceState.activeFilter}
        onSelectFilter={(filter) => {
          prepareSessionResultsContentFocus();
          dispatchWorkspaceAction({ type: "decision-filter-selected", filter });
        }}
        onExportSessionResults={(format) => {
          void exportSessionResults(format);
        }}
        sessionResultsExportInProgress={exportInProgress}
        advisoryId={RESULTS_LLM_SCORE_ADVISORY_ID}
      />

      {/* Paper side: the cluster workspace stays quiet so decisions dominate.
          On mobile the clusters lead (the desk's single job); metrics and framing
          follow — desktop keeps the approved metrics → framing → clusters order. */}
      <div className="flex min-w-0 flex-col gap-5">
        {exportError !== null && (
          <SessionResultsExportAlert
            message={exportError}
            retryDisabled={exportInProgress}
            onRetry={() => {
              void retrySessionResultsExport();
            }}
          />
        )}

        {resultsAvailability.kind === "failed" && (
          <SessionResultsFailureAlert
            sessionId={id}
            reason={resultsAvailability.reason}
            empty={resultsAvailability.empty}
          />
        )}

        {resultsAvailability.kind === "ready" && resultsAvailability.running && (
          <Alert variant="caution" className="order-1">
            <Play />
            <AlertTitle>Session still running</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-3">
              These results are partial. Clusters, synthesis and scores appear after
              convergence.
              <Button asChild size="sm" variant="outline">
                <Link to={`/session/${id}`}>Watch it live</Link>
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {session.metrics && <MetricsTiles metrics={session.metrics} className="order-4 lg:order-2" />}

        {framing && (
          <section
            aria-label="Facilitator framing"
            className="order-3 rounded-lg border bg-card p-4"
          >
            <p className="mb-1.5 flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-wide text-primary">
              <MoonStar aria-hidden="true" className="h-3.5 w-3.5" />
              Facilitator framing
            </p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {framing.content}
            </p>
          </section>
        )}

        <section
          aria-labelledby="results-clusters-heading"
          className="order-2 space-y-4 lg:order-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border pb-2.5 lg:pb-3">
            <h2
              id="results-clusters-heading"
              className="font-display text-lg font-semibold leading-snug tracking-tight lg:text-xl lg:leading-7"
            >
              Clusters
              <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                {decisionWorkspace.visibleClusters.length} of{" "}
                {decisionWorkspace.totalClusterCount} shown
                {workspaceState.activeFilter !== "all" && ` · ${activeFilterLabel} only`}
              </span>
            </h2>
            <div className="flex items-center gap-2">
              <Button
                id={SESSION_RESULTS_EXPAND_ALL_CONTROL_ID}
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  visibleClusterKeys.length === 0 || allVisibleClustersExpanded
                }
                onClick={() => {
                  prepareSessionResultsDisclosureControlFocus(
                    SESSION_RESULTS_COLLAPSE_ALL_CONTROL_ID
                  );
                  dispatchClusterDisclosureAction({
                    type: "matching-clusters-expanded",
                    clusterKeys: visibleClusterKeys,
                  });
                }}
              >
                Expand all
              </Button>
              <Button
                id={SESSION_RESULTS_COLLAPSE_ALL_CONTROL_ID}
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  visibleClusterKeys.length === 0 || allVisibleClustersCollapsed
                }
                onClick={() => {
                  prepareSessionResultsDisclosureControlFocus(
                    SESSION_RESULTS_EXPAND_ALL_CONTROL_ID
                  );
                  dispatchClusterDisclosureAction({
                    type: "matching-clusters-collapsed",
                    clusterKeys: visibleClusterKeys,
                  });
                }}
              >
                Collapse all
              </Button>
            </div>
          </div>

          {resultsAvailability.empty ? (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">
                <p>
                  {resultsAvailability.kind === "failed"
                    ? "No ideas were saved before this session failed."
                    : resultsAvailability.running
                      ? "No ideas are recorded yet. They appear here as the live session progresses."
                      : "The council finished without recording any ideas."}
                </p>
              </CardContent>
            </Card>
          ) : decisionWorkspace.visibleClusters.length === 0 ? (
            <Card>
              <CardContent className="flex flex-wrap items-center gap-3 p-6" role="status">
                <p className="text-sm text-muted-foreground">
                  No ideas match the {activeFilterLabel} filter.
                </p>
                <Button
                  id={SESSION_RESULTS_CLEAR_FILTER_CONTROL_ID}
                  type="button"
                  size="sm"
                  variant="outline"
                  data-session-results-focus-region="zero-state"
                  onClick={() => {
                    prepareSessionResultsContentFocus();
                    dispatchWorkspaceAction({
                      type: "decision-filter-selected",
                      filter: "all",
                    });
                  }}
                >
                  Clear filter
                </Button>
              </CardContent>
            </Card>
          ) : (
            decisionWorkspace.visibleClusters.map((cluster) => (
              <ResultsClusterDossier
                key={cluster.key}
                cluster={cluster}
                activeFilter={workspaceState.activeFilter}
                expanded={isResultsClusterExpanded(
                  clusterDisclosureState,
                  cluster.key
                )}
                onToggle={() =>
                  dispatchClusterDisclosureAction({
                    type: "cluster-toggled",
                    clusterKey: cluster.key,
                  })
                }
              >
                {cluster.ideas.map((idea) => (
                  <IdeaCard
                    key={idea.id}
                    idea={idea}
                    saveState={ideaSaveStates[idea.id]}
                    scoreAdvisoryId={RESULTS_LLM_SCORE_ADVISORY_ID}
                    onSave={(attempt) => saveResultsIdeaDecision(idea, attempt)}
                    onRetry={() => retryFailedResultsIdeaDecision(idea.id)}
                  />
                ))}
              </ResultsClusterDossier>
            ))
          )}
        </section>

        {logMessages.length > 0 && (
          <details className="group order-5 rounded-lg border bg-card">
            <summary className="flex cursor-pointer items-center gap-2 p-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              <ScrollText aria-hidden="true" className="h-4 w-4 text-primary" />
              Discussion transcript
              <span className="font-mono text-xs font-normal text-muted-foreground">
                {logMessages.length} turns, anonymized
              </span>
            </summary>
            <div className="border-t p-4">
              <DiscussionLog messages={logMessages} />
            </div>
          </details>
        )}

        <p className="order-6 flex items-center gap-1.5 text-xs text-muted-foreground">
          <ArrowLeft aria-hidden="true" className="h-3 w-3" />
          Decisions and memos save as you make them — return to the Live view or History
          anytime.
        </p>
      </div>
    </div>
  );
}

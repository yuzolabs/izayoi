import {
  AlertTriangle,
  ArrowDown,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useId } from "react";

import { PersonaBadge } from "@/components/persona-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { AgentConfig } from "@/lib/api";
import { groupColorOf } from "@/lib/persona-meta";
import type {
  SessionAgentOutputRetentionRequest,
  SessionAgentOutputState,
} from "@/lib/session-agent-output";
import { useSessionLiveFollow } from "@/lib/use-session-live-follow";
import { cn } from "@/lib/utils";

/** Display status for one participant on the Live session screen. */
export type AgentStatus = "waiting" | "streaming" | "done" | "failed";

/** Transient SSE-backed output state for one Live session participant. */
export interface AgentViewState {
  status: AgentStatus;
  output: SessionAgentOutputState;
  task: string;
  round: number;
}

const STATUS_PRESENTATION: Record<
  AgentStatus,
  {
    label: string;
    variant: "secondary" | "default" | "success" | "destructive";
    icon: LucideIcon;
  }
> = {
  waiting: { label: "Waiting", variant: "secondary", icon: Clock3 },
  streaming: { label: "Streaming", variant: "default", icon: LoaderCircle },
  done: { label: "Done", variant: "success", icon: CheckCircle2 },
  failed: { label: "Failed", variant: "destructive", icon: AlertTriangle },
};

const OUTPUT_PLACEHOLDER: Record<AgentStatus, string> = {
  waiting: "Output will appear here…",
  streaming: "Waiting for the first token…",
  done: "Completed — per-token replay is not stored; see the ideas and log below.",
  failed: "No further output is available.",
};

function AgentOutputPlaceholder({ status }: { status: AgentStatus }) {
  const presentation = STATUS_PRESENTATION[status];
  return (
    <span role="status" className="flex items-start gap-2 text-muted-foreground">
      <presentation.icon
        aria-hidden="true"
        className={cn("mt-0.5 h-4 w-4 shrink-0", status === "streaming" && "animate-spin")}
      />
      <span>{OUTPUT_PLACEHOLDER[status]}</span>
    </span>
  );
}

/** Live participant workbench with an announced status and reader-controlled output following. */
export function AgentCard({
  agent,
  personaName,
  state,
  sessionFinished,
  sessionFailed,
  replayVersion,
  onOutputRetentionRequest,
}: {
  agent: AgentConfig;
  personaName: string;
  state: AgentViewState;
  /** P7: completed sessions show cards as done even without token replay. */
  sessionFinished: boolean;
  /** Session-level failures mark every unfinished participant as failed. */
  sessionFailed: boolean;
  /** Increments when the SSE stream resets transient output for replay. */
  replayVersion: number;
  /** Sends selection and viewport pins to the SSE-owned output state. */
  onOutputRetentionRequest?: (
    agentPersonaType: string,
    request: SessionAgentOutputRetentionRequest
  ) => void;
}) {
  const outputRegionId = useId();
  const agentName = personaName || agent.persona_type;
  const effectiveStatus: AgentStatus = sessionFailed
    ? state.status === "done"
      ? "done"
      : "failed"
    : sessionFinished && state.status !== "failed"
      ? "done"
      : state.status;
  const presentation = STATUS_PRESENTATION[effectiveStatus];
  const requestAgentOutputRetention = useCallback(
    (request: SessionAgentOutputRetentionRequest) => {
      onOutputRetentionRequest?.(agent.persona_type, request);
    },
    [agent.persona_type, onOutputRetentionRequest]
  );
  const {
    scrollRegionRef,
    followState,
    handleScroll,
    handleJumpMouseDown,
    jumpToLatest,
  } = useSessionLiveFollow({
    contentVersion: state.output.receivedCharacterCount,
    retentionVersion: state.output.retentionVersion,
    resetVersion: `${agent.persona_type}:${replayVersion}:${state.output.streamVersion}`,
    onOutputRetentionRequest: requestAgentOutputRetention,
  });

  return (
    <Card
      role="region"
      aria-label={`${agentName} agent`}
      className={cn(
        "flex flex-col border-l-[3px]",
        effectiveStatus === "streaming" && "ring-1 ring-primary/40"
      )}
      style={{ borderLeftColor: groupColorOf(agent.persona_type) }}
    >
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0 p-4 pb-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <PersonaBadge type={agent.persona_type} name={personaName} />
          {agent.role === "devils_advocate" && (
            <Badge variant="caution" title="Challenges the emerging consensus">
              Devil's advocate
            </Badge>
          )}
        </div>
        <Badge
          role="status"
          aria-live="polite"
          aria-atomic="true"
          variant={presentation.variant}
        >
          <presentation.icon
            aria-hidden="true"
            className={cn("h-3 w-3", effectiveStatus === "streaming" && "animate-spin")}
          />
          <span className="sr-only">{agentName} status: </span>
          {presentation.label}
        </Badge>
      </CardHeader>
      <CardContent className="flex-1 p-4 pt-0">
        <p className="border-b border-border/70 pb-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {agent.provider} · {agent.model}
          {state.task ? ` · ${state.task} (round ${state.round})` : ""}
        </p>
        <div
          id={outputRegionId}
          ref={scrollRegionRef}
          role="log"
          aria-label={`${agentName} live output`}
          aria-live="off"
          aria-busy={effectiveStatus === "streaming" || undefined}
          tabIndex={0}
          onScroll={handleScroll}
          className={cn(
            "mt-2.5 h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/40 p-3 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            effectiveStatus === "streaming" && "stream-caret"
          )}
        >
          {state.output.chunks.length > 0 ? (
            state.output.chunks.map((chunk) => (
              <span
                key={chunk.renderKey}
                data-session-agent-output-chunk=""
                data-session-agent-output-render-key={chunk.renderKey}
              >
                {chunk.text}
              </span>
            ))
          ) : (
            <AgentOutputPlaceholder status={effectiveStatus} />
          )}
        </div>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {followState.hasNewContent ? `${agentName} has new output.` : ""}
        </span>
        {followState.mode === "paused" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-controls={outputRegionId}
            onMouseDown={handleJumpMouseDown}
            onClick={jumpToLatest}
            className={cn(
              "follow-jump",
              followState.hasNewContent && "follow-jump--new"
            )}
          >
            <ArrowDown aria-hidden="true" />
            {followState.hasNewContent ? "New output · Jump to latest" : "Jump to latest output"}
          </Button>
        )}
        {state.output.truncated && (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            Older live output was compacted so the latest output remains available.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

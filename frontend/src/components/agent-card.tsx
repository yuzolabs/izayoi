import { useEffect, useRef } from "react";

import { PersonaBadge } from "@/components/persona-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { AgentConfig } from "@/lib/api";
import { cn } from "@/lib/utils";

export type AgentStatus = "waiting" | "streaming" | "done" | "failed";

export interface AgentViewState {
  status: AgentStatus;
  text: string;
  task: string;
  round: number;
}

const STATUS_PRESENTATION: Record<AgentStatus, { label: string; variant: "secondary" | "default" | "success" | "destructive" }> = {
  waiting: { label: "Waiting", variant: "secondary" },
  streaming: { label: "Streaming", variant: "default" },
  done: { label: "Done", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
};

export function AgentCard({
  agent,
  personaName,
  state,
  sessionFinished,
}: {
  agent: AgentConfig;
  personaName: string;
  state: AgentViewState;
  /** P7: finished sessions show cards as completed even without token replay. */
  sessionFinished: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const effectiveStatus: AgentStatus =
    sessionFinished && state.status === "waiting" ? "done" : state.status;
  const presentation = STATUS_PRESENTATION[effectiveStatus];

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.text]);

  return (
    <Card className={cn("flex flex-col", effectiveStatus === "streaming" && "border-primary/50")}>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 p-4 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <PersonaBadge type={agent.persona_type} name={personaName} />
          {agent.role === "devils_advocate" && (
            <Badge variant="caution" title="Challenges the emerging consensus">
              Devil's advocate
            </Badge>
          )}
        </div>
        <Badge variant={presentation.variant}>{presentation.label}</Badge>
      </CardHeader>
      <CardContent className="flex-1 p-4 pt-2">
        <p className="mb-2 font-mono text-[11px] text-muted-foreground">
          {agent.provider} · {agent.model}
          {state.task ? ` · ${state.task} (round ${state.round})` : ""}
        </p>
        <div
          ref={bodyRef}
          className={cn(
            "h-36 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/60 p-3 text-sm leading-relaxed",
            effectiveStatus === "streaming" && "stream-caret"
          )}
        >
          {state.text ||
            (sessionFinished ? (
              <span className="text-muted-foreground">
                Completed — per-token replay is not stored; see the ideas and log below.
              </span>
            ) : (
              <span className="text-muted-foreground">Output will appear here…</span>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}

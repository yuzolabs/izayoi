import {
  ArrowDown,
  LoaderCircle,
  LockKeyhole,
  MessageSquare,
  MessageSquareDashed,
} from "lucide-react";
import { useId } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSessionLiveFollow } from "@/lib/use-session-live-follow";
import { cn } from "@/lib/utils";

export interface LogMessage {
  round: number;
  from: string;
  content: string;
}

/** Whether the discussion log is still a future phase or may reveal messages. */
export type DiscussionLogAvailability = "future" | "available";

/** State and copy needed to render an anonymized, replay-safe discussion log. */
export interface DiscussionLogProps {
  messages: readonly LogMessage[];
  availability?: DiscussionLogAvailability;
  emptyMessage?: string;
  isLoading?: boolean;
  replayVersion?: number;
}

/** Anonymized discussion log (participants appear as Persona A/B/…). */
export function DiscussionLog({
  messages,
  availability = "available",
  emptyMessage = "No discussion messages were recorded.",
  isLoading = false,
  replayVersion = 0,
}: DiscussionLogProps) {
  const logRegionId = useId();
  const visibleMessages = availability === "available" ? messages : [];
  const {
    scrollRegionRef,
    followState,
    handleScroll,
    handleJumpMouseDown,
    jumpToLatest,
  } = useSessionLiveFollow({
    contentVersion: visibleMessages.length,
    resetVersion: replayVersion,
  });

  return (
    <Card className="flex min-h-0 flex-col">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0 p-4 pb-2">
        <CardTitle className="flex min-w-0 flex-wrap items-center gap-2 text-base">
          <MessageSquare aria-hidden="true" className="h-4 w-4 text-primary" />
          Discussion log
          <span className="text-xs font-normal text-muted-foreground">
            anonymized · scores hidden during debate
          </span>
        </CardTitle>
        {availability === "available" && followState.mode === "paused" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-controls={logRegionId}
            onMouseDown={handleJumpMouseDown}
            onClick={jumpToLatest}
            className={cn(
              "follow-jump ml-auto shrink-0",
              followState.hasNewContent && "follow-jump--new"
            )}
          >
            <ArrowDown aria-hidden="true" />
            {followState.hasNewContent ? "New messages · Jump to latest" : "Jump to latest"}
          </Button>
        )}
      </CardHeader>
      <CardContent
        id={logRegionId}
        ref={scrollRegionRef}
        role={availability === "available" ? "log" : "region"}
        aria-label="Anonymized discussion log"
        aria-live={availability === "available" ? "polite" : "off"}
        aria-relevant="additions text"
        aria-busy={isLoading || undefined}
        tabIndex={0}
        onScroll={handleScroll}
        className="max-h-96 flex-1 space-y-3 overflow-y-auto p-4 pt-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {availability === "future" ? (
          /* The gate is a scheduled phase, not an empty feature: sealed by design. */
          <div role="status" className="rounded-lg border border-dashed border-border bg-muted/30 p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <LockKeyhole aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
              Sealed until Discussion opens
            </p>
            <p className="mt-1.5 pl-6 text-xs leading-relaxed text-muted-foreground">
              The council is thinking independently first. Debate begins in phase 3 of 5;
              the log will fill here as personas exchange challenges.
            </p>
          </div>
        ) : visibleMessages.length === 0 ? (
          <div role="status" className="flex items-start gap-2 text-sm text-muted-foreground">
            {isLoading ? (
              <LoaderCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
            ) : (
              <MessageSquareDashed aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <p>{isLoading ? "Loading discussion history…" : emptyMessage}</p>
          </div>
        ) : (
          visibleMessages.map((message, index) => (
            <article key={`${replayVersion}:${index}`} className="animate-fade-in">
              <div className="mb-0.5 flex items-center gap-2">
                <span className="font-mono text-xs font-semibold">{message.from}</span>
                {message.round > 0 && (
                  <Badge variant="secondary" className="px-1.5 text-[10px]">
                    round {message.round}
                  </Badge>
                )}
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                {message.content}
              </p>
            </article>
          ))
        )}
      </CardContent>
    </Card>
  );
}

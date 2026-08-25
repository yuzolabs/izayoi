import { Check, LoaderCircle, Pause, RotateCcw, X } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { PersonaBadge } from "@/components/persona-badge";
import { ScoreBadges } from "@/components/score-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Decision, Idea } from "@/lib/api";
import {
  getResultsIdeaMemoFieldElementId,
  normalizeResultsIdeaMemo,
  validateResultsIdeaMemo,
} from "@/lib/results-idea-memo-field-validation";
import type {
  ResultsIdeaDecisionAttempt,
  ResultsIdeaSaveState,
} from "@/lib/session-results-decision-state";
import { SESSION_TEXT_FIELD_MAX_LENGTH } from "@/lib/session-text-field-max-length";
import { cn } from "@/lib/utils";

const IDEA_DECISION_OPTIONS: {
  id: Decision;
  label: string;
  icon: typeof Check;
  activeClass: string;
}[] = [
  {
    id: "adopted",
    label: "Adopt",
    icon: Check,
    activeClass: "border-success bg-success text-primary-foreground hover:bg-success/90",
  },
  {
    id: "held",
    label: "Hold",
    icon: Pause,
    activeClass: "border-caution bg-caution text-primary-foreground hover:bg-caution/90",
  },
  {
    id: "rejected",
    label: "Reject",
    icon: X,
    activeClass:
      "border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90",
  },
  {
    id: "pending",
    label: "Pending",
    icon: RotateCcw,
    activeClass: "border-muted-foreground bg-secondary text-secondary-foreground",
  },
];

const IDEA_DECISION_BADGE: Record<
  Decision,
  { label: string; variant: "secondary" | "success" | "caution" | "destructive" }
> = {
  pending: { label: "Pending", variant: "secondary" },
  adopted: { label: "Adopted", variant: "success" },
  held: { label: "Held", variant: "caution" },
  rejected: { label: "Rejected", variant: "destructive" },
};

interface IdeaCardProps {
  idea: Idea;
  saveState?: ResultsIdeaSaveState;
  scoreAdvisoryId: string;
  onSave: (attempt: ResultsIdeaDecisionAttempt) => void;
  onRetry: () => void;
}

/** Renders keyboard-native decision, memo save, and retry controls for one Results idea. */
export function IdeaCard({
  idea,
  saveState,
  scoreAdvisoryId,
  onSave,
  onRetry,
}: IdeaCardProps) {
  const ideaContentId = useId();
  const saveStatusId = useId();
  const memoFieldId = getResultsIdeaMemoFieldElementId(idea.id, "field");
  const memoHintId = getResultsIdeaMemoFieldElementId(idea.id, "hint");
  const memoCounterId = getResultsIdeaMemoFieldElementId(idea.id, "counter");
  const memoErrorId = getResultsIdeaMemoFieldElementId(idea.id, "error");
  const failedMemo =
    saveState?.status === "error" ? saveState.attempt.note : undefined;
  const [note, setNote] = useState(() => failedMemo ?? idea.note);
  const [memoServerError, setMemoServerError] = useState<string | null>(() =>
    saveState?.status === "error" ? (saveState.memoError ?? null) : null
  );

  useEffect(() => {
    if (saveState?.status === "saved") {
      setNote(idea.note);
      setMemoServerError(null);
    } else if (saveState?.status === "error") {
      setNote(saveState.attempt.note ?? idea.note);
      setMemoServerError(saveState.memoError ?? null);
    }
  }, [idea.note, saveState]);

  const busy =
    saveState?.status === "saving" || saveState?.status === "recovering";
  const badge = IDEA_DECISION_BADGE[idea.decision];
  const liveMemoValidationError = validateResultsIdeaMemo(note);
  const memoFieldError = liveMemoValidationError ?? memoServerError;
  const normalizedNote = normalizeResultsIdeaMemo(note);
  const noteDirty = normalizedNote !== normalizeResultsIdeaMemo(idea.note);
  const describedBy = [
    memoHintId,
    memoCounterId,
    memoFieldError === null ? null : memoErrorId,
    saveStatusId,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");

  const updateResultsIdeaMemo = (nextNote: string) => {
    setNote(nextNote);
    setMemoServerError(null);
  };

  const commitResultsIdeaDecision = (
    decision: Decision,
    includeNote: boolean
  ) => {
    if (liveMemoValidationError !== null) return;
    onSave({
      decision,
      ...(includeNote || noteDirty ? { note: normalizedNote } : {}),
    });
  };

  return (
    <article
      className="min-w-0 rounded-lg border bg-card p-3.5 lg:p-4"
      aria-busy={busy}
      data-session-results-focus-region="idea-card"
    >
      {/* 1. The idea itself — read it first. */}
      <div className="flex items-start justify-between gap-3">
        <p
          id={ideaContentId}
          className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed"
        >
          {idea.content}
        </p>
        <Badge
          variant={badge.variant}
          aria-label={`Current decision: ${badge.label}`}
          className="shrink-0"
        >
          {badge.label}
        </Badge>
      </div>
      {/* 2. Provenance and advisory scores — triage context, not verdicts. */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <PersonaBadge type={idea.persona_type} />
        <Badge variant="outline" className="font-normal">
          {idea.phase === "divergence" ? "Independent" : "Discussion"}
        </Badge>
        {idea.cluster_id !== null && (
          <Badge variant="outline" className="font-mono font-normal">
            cluster #{idea.cluster_id}
          </Badge>
        )}
        {idea.scores && (
          <span role="group" aria-label="LLM scores" aria-describedby={scoreAdvisoryId}>
            <ScoreBadges scores={idea.scores} />
          </span>
        )}
      </div>
      {/* 3. The decision — a 2×2 keypad on mobile, a row on wider screens. */}
      <div
        className="mt-2.5 grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap lg:mt-3"
        role="group"
        aria-labelledby={ideaContentId}
        aria-describedby={saveStatusId}
      >
        {IDEA_DECISION_OPTIONS.map((decisionOption) => (
          <Button
            key={decisionOption.id}
            type="button"
            size="sm"
            variant={idea.decision === decisionOption.id ? "default" : "outline"}
            className={cn(
              "w-full sm:w-auto",
              idea.decision === decisionOption.id && decisionOption.activeClass
            )}
            aria-pressed={idea.decision === decisionOption.id}
            onClick={() => commitResultsIdeaDecision(decisionOption.id, false)}
          >
            <decisionOption.icon />
            {decisionOption.label}
          </Button>
        ))}
      </div>
      {/* 4. The memo — the human record that outlives the scores. */}
      <div className="mt-3 min-w-0 border-t border-border pt-3">
        <label className="sr-only" htmlFor={memoFieldId}>
          Decision memo for this idea
        </label>
        <Textarea
          id={memoFieldId}
          value={note}
          maxLength={SESSION_TEXT_FIELD_MAX_LENGTH}
          aria-invalid={
            memoFieldError !== null || saveState?.status === "error"
          }
          aria-describedby={describedBy}
          aria-errormessage={memoFieldError === null ? undefined : memoErrorId}
          onInput={(event) => updateResultsIdeaMemo(event.currentTarget.value)}
          onChange={(event) => updateResultsIdeaMemo(event.currentTarget.value)}
          placeholder="Adoption memo — why this idea, caveats, next step…"
          className="results-idea-memo-field min-h-[56px] text-sm"
        />
        <p id={memoHintId} className="mt-1.5 text-xs text-muted-foreground">
          Optional. Leading and trailing spaces are removed on save.
        </p>
        <p
          id={memoCounterId}
          className="font-mono text-xs text-muted-foreground"
        >
          {note.length} / {SESSION_TEXT_FIELD_MAX_LENGTH}
        </p>
        {memoFieldError !== null && (
          <p id={memoErrorId} className="text-xs text-destructive">
            {memoFieldError}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={!noteDirty || liveMemoValidationError !== null}
            onClick={() => commitResultsIdeaDecision(idea.decision, true)}
          >
            Save memo
          </Button>
          <span
            id={saveStatusId}
            className="text-xs"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {(saveState?.status === "saving" ||
              saveState?.status === "recovering") && (
              <span className="inline-flex items-center gap-1">
                <LoaderCircle aria-hidden="true" className="h-3 w-3 animate-spin" />
                {saveState.status === "recovering"
                  ? saveState.message
                  : "Saving…"}
              </span>
            )}
            {saveState?.status === "saved" && "Saved"}
            {saveState?.status === "error" &&
              (saveState.memoError == null ||
                saveState.message !== saveState.memoError) && (
                <span className="text-destructive">
                  Save failed: {saveState.message}
                </span>
              )}
          </span>
          {saveState?.status === "error" && (
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              Retry failed save
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

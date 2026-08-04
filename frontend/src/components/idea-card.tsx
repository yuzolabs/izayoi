import { Check, Pause, RotateCcw, X } from "lucide-react";
import { useState } from "react";

import { PersonaBadge } from "@/components/persona-badge";
import { ScoreBadges } from "@/components/score-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, type Decision, type Idea } from "@/lib/api";
import { cn } from "@/lib/utils";

const DECISIONS: { id: Decision; label: string; icon: typeof Check; activeClass: string }[] = [
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
    activeClass: "border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90",
  },
];

const DECISION_BADGE: Record<Decision, { label: string; variant: "secondary" | "success" | "caution" | "destructive" }> = {
  pending: { label: "Pending", variant: "secondary" },
  adopted: { label: "Adopted", variant: "success" },
  held: { label: "Held", variant: "caution" },
  rejected: { label: "Rejected", variant: "destructive" },
};

export function IdeaCard({
  idea,
  onChange,
}: {
  idea: Idea;
  onChange: (idea: Idea) => void;
}) {
  const [note, setNote] = useState(idea.note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = async (decision: Decision, noteText?: string) => {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateDecision(idea.id, decision, noteText);
      onChange(updated);
      setNote(updated.note);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const badge = DECISION_BADGE[idea.decision];
  const noteDirty = note !== idea.note;

  return (
    <div className="rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed">{idea.content}</p>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>
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
        {idea.scores && <ScoreBadges scores={idea.scores} />}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {DECISIONS.map((d) => (
          <Button
            key={d.id}
            size="sm"
            variant={idea.decision === d.id ? "default" : "outline"}
            className={cn(idea.decision === d.id && d.activeClass)}
            disabled={saving}
            onClick={() => patch(d.id, noteDirty ? note : undefined)}
          >
            <d.icon />
            {d.label}
          </Button>
        ))}
        {idea.decision !== "pending" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => patch("pending", noteDirty ? note : undefined)}
            title="Reset to pending"
          >
            <RotateCcw />
            Reset
          </Button>
        )}
      </div>
      <div className="mt-3">
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Adoption memo — why this idea, caveats, next step…"
          className="min-h-[56px] text-sm"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={saving || !noteDirty}
            onClick={() => patch(idea.decision, note)}
          >
            Save memo
          </Button>
          {error && <span className="text-xs text-destructive">{error}</span>}
        </div>
      </div>
    </div>
  );
}

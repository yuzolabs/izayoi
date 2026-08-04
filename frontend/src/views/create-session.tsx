import { AlertTriangle, Check, MoonStar, Play, Scale, Shuffle, Users, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  availableProviders,
  ProviderModelSelect,
} from "@/components/provider-select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, type AgentConfig, type Persona, type ProviderInfo } from "@/lib/api";
import { groupColorOf, PERSONA_GROUPS } from "@/lib/persona-meta";
import { cn } from "@/lib/utils";

const STEP_TITLES = ["Theme", "Cast the council", "Assign models", "Parameters"] as const;

function StepHeading({ index, children }: { index: number; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="font-mono text-xs font-semibold text-primary">
        {String(index + 1).padStart(2, "0")}
      </span>
      <h2 className="font-display text-xl font-semibold tracking-tight">{children}</h2>
    </div>
  );
}

export function CreateSession() {
  const navigate = useNavigate();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [theme, setTheme] = useState("");
  const [constraints, setConstraints] = useState("");
  const [cast, setCast] = useState<Map<string, AgentConfig>>(new Map());
  const [balanceCount, setBalanceCount] = useState(4);
  const [ideasPerAgent, setIdeasPerAgent] = useState(3);
  const [discussionRounds, setDiscussionRounds] = useState(2);
  const [enableJudge, setEnableJudge] = useState(true);
  const [facilitator, setFacilitator] = useState({ provider: "", model: "" });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.providers(), api.personas()])
      .then(([p, s]) => {
        setProviders(p.providers);
        setPersonas(s.personas);
        const usable = availableProviders(p.providers);
        if (usable.length > 0) {
          setFacilitator({ provider: usable[0].id, model: usable[0].models[0] });
        }
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load metadata"));
  }, []);

  const usableProviders = useMemo(() => availableProviders(providers), [providers]);
  const personaByType = useMemo(
    () => new Map(personas.map((p) => [p.type, p])),
    [personas]
  );

  const assignRoundRobin = (types: string[]): Map<string, AgentConfig> => {
    const next = new Map<string, AgentConfig>();
    types.forEach((type, index) => {
      const provider = usableProviders[index % Math.max(1, usableProviders.length)];
      next.set(type, {
        persona_type: type,
        provider: provider?.id ?? "mock",
        model: provider?.models[0] ?? "mock",
        role: index === types.length - 1 ? "devils_advocate" : "participant",
      });
    });
    return next;
  };

  const togglePersona = (type: string) => {
    setCast((prev) => {
      const next = new Map(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        const provider = usableProviders[next.size % Math.max(1, usableProviders.length)];
        next.set(type, {
          persona_type: type,
          provider: provider?.id ?? "mock",
          model: provider?.models[0] ?? "mock",
          role: "participant",
        });
      }
      return next;
    });
  };

  const updateAgent = (type: string, patch: Partial<AgentConfig>) => {
    setCast((prev) => {
      const next = new Map(prev);
      const current = next.get(type);
      if (current) next.set(type, { ...current, ...patch });
      return next;
    });
  };

  const setDevil = (type: string) => {
    setCast((prev) => {
      const next = new Map(prev);
      for (const [key, agent] of next) {
        next.set(key, { ...agent, role: key === type ? "devils_advocate" : "participant" });
      }
      return next;
    });
  };

  const applyBalanced = async () => {
    try {
      const { types } = await api.balanced(balanceCount);
      setCast(assignRoundRobin(types));
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Balanced selection failed");
    }
  };

  const applyAll16 = () => {
    setCast(assignRoundRobin(personas.map((p) => p.type)));
  };

  const agents = [...cast.values()];
  const devilCount = agents.filter((a) => a.role === "devils_advocate").length;
  const canSubmit =
    theme.trim().length > 0 && agents.length >= 2 && facilitator.provider !== "" && !submitting;
  const estimatedCalls =
    agents.length * (1 + discussionRounds) + 1 + (enableJudge ? agents.length : 0);

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const session = await api.createSession({
        theme: theme.trim(),
        constraints: constraints.trim(),
        ideas_per_agent: ideasPerAgent,
        discussion_rounds: discussionRounds,
        agents,
        facilitator,
        enable_judge: enableJudge,
      });
      await api.startSession(session.id);
      navigate(`/session/${session.id}`);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Failed to start the session");
      setSubmitting(false);
    }
  };

  if (loadError) {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>Could not reach the backend</AlertTitle>
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-10 pb-24">
      <div className="max-w-2xl">
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Convene a council of sixteen minds
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Each persona brainstorms alone first — no groupthink — then debates anonymously,
          and a facilitator merges, scores and lays the decision at your feet.
        </p>
      </div>

      {/* Step 1 — Theme */}
      <section className="space-y-4">
        <StepHeading index={0}>{STEP_TITLES[0]}</StepHeading>
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="space-y-2">
              <Label htmlFor="theme">What should the council brainstorm?</Label>
              <Textarea
                id="theme"
                value={theme}
                onChange={(e) => setTheme(e.target.value)}
                placeholder="e.g. Find ten ways to grow a neighborhood repair café without paid advertising"
                className="min-h-[96px]"
                maxLength={2000}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="constraints">
                Constraints <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="constraints"
                value={constraints}
                onChange={(e) => setConstraints(e.target.value)}
                placeholder="e.g. No budget over $500, must work for non-technical members"
                maxLength={2000}
              />
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Step 2 — Cast */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <StepHeading index={1}>{STEP_TITLES[1]}</StepHeading>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Balanced selection size"
              value={String(balanceCount)}
              onChange={(e) => setBalanceCount(Number(e.target.value))}
              className="w-16"
            >
              {[4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
            <Button variant="outline" size="sm" onClick={applyBalanced}>
              <Shuffle />
              Balanced pick
            </Button>
            <Button variant="outline" size="sm" onClick={applyAll16}>
              <Users />
              All 16
            </Button>
            {cast.size > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setCast(new Map())}>
                <X />
                Clear
              </Button>
            )}
          </div>
        </div>

        {cast.size >= 10 && (
          <Alert variant="caution">
            <AlertTriangle />
            <AlertTitle>Cost warning</AlertTitle>
            <AlertDescription>
              {cast.size} agents × ({ideasPerAgent} ideas + {discussionRounds} discussion rounds)
              means roughly {estimatedCalls} LLM calls before judging. All-16 mode is powerful
              but expensive and slow.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {PERSONA_GROUPS.map((group) => (
            <div key={group.id} className="space-y-2">
              <div className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: group.color }}
                />
                <span className="text-sm font-medium">{group.label}</span>
              </div>
              <div className="space-y-2">
                {group.types.map((type) => {
                  const persona = personaByType.get(type);
                  const selected = cast.has(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => togglePersona(type)}
                      style={
                        selected
                          ? { borderColor: groupColorOf(type), boxShadow: `0 0 0 1px ${groupColorOf(type)}` }
                          : undefined
                      }
                      className={cn(
                        "w-full rounded-md border bg-card p-3 text-left transition-all hover:border-foreground/30",
                        selected && "bg-accent/50"
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-baseline gap-2">
                          <span className="font-mono text-sm font-semibold">{type}</span>
                          <span className="text-xs text-muted-foreground">
                            {persona?.name_ja}
                          </span>
                        </span>
                        {selected && <Check className="h-4 w-4" style={{ color: groupColorOf(type) }} />}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {persona?.summary}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {cast.size} of 16 selected — a diverse quartet usually beats a uniform crowd.
        </p>
      </section>

      {/* Step 3 — Assign */}
      {cast.size > 0 && (
        <section className="space-y-4">
          <StepHeading index={2}>{STEP_TITLES[2]}</StepHeading>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>
                Spreading personas across model families is the core diversity strategy.
                Unavailable providers show the environment variable they need. Exactly one
                devil's advocate is allowed.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 p-5 pt-2">
              {agents.map((agent) => (
                <div
                  key={agent.persona_type}
                  className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center"
                >
                  <div className="flex w-40 shrink-0 items-center gap-2">
                    <span className="font-mono text-sm font-semibold">{agent.persona_type}</span>
                    <span className="text-xs text-muted-foreground">
                      {personaByType.get(agent.persona_type)?.name_ja}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <ProviderModelSelect
                      providers={providers}
                      provider={agent.provider}
                      model={agent.model}
                      compact
                      onChange={(provider, model) => updateAgent(agent.persona_type, { provider, model })}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant={agent.role === "devils_advocate" ? "default" : "outline"}
                    className="shrink-0"
                    title="Designate as devil's advocate"
                    onClick={() =>
                      agent.role === "devils_advocate"
                        ? updateAgent(agent.persona_type, { role: "participant" })
                        : setDevil(agent.persona_type)
                    }
                  >
                    <Scale />
                    Devil
                  </Button>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                {devilCount === 1
                  ? "One devil's advocate designated."
                  : "No devil's advocate — the last cast member will be asked to fill the role."}
              </p>
            </CardContent>
          </Card>
        </section>
      )}

      {/* Step 4 — Parameters */}
      <section className="space-y-4">
        <StepHeading index={3}>{STEP_TITLES[3]}</StepHeading>
        <Card>
          <CardContent className="space-y-6 p-5">
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Ideas per persona</Label>
                  <span className="font-mono text-sm">{ideasPerAgent}</span>
                </div>
                <Slider
                  min={1}
                  max={10}
                  step={1}
                  value={[ideasPerAgent]}
                  onValueChange={([v]) => setIdeasPerAgent(v)}
                />
                <p className="text-xs text-muted-foreground">
                  Generated in isolation, before anyone sees anyone else's work.
                </p>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Discussion rounds</Label>
                  <span className="font-mono text-sm">{discussionRounds}</span>
                </div>
                <Slider
                  min={0}
                  max={3}
                  step={1}
                  value={[discussionRounds]}
                  onValueChange={([v]) => setDiscussionRounds(v)}
                />
                <p className="text-xs text-muted-foreground">
                  Beyond 2–3 rounds, debate saturates and returns diminish.
                </p>
              </div>
            </div>
            <Separator />
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Label htmlFor="judge">LLM judge pre-ranking</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Advisory scores only — the final decision is always yours.
                  </p>
                </div>
                <Switch id="judge" checked={enableJudge} onCheckedChange={setEnableJudge} />
              </div>
              <div className="space-y-2">
                <Label>Facilitator model</Label>
                <ProviderModelSelect
                  providers={providers}
                  provider={facilitator.provider}
                  model={facilitator.model}
                  compact
                  onChange={(provider, model) => setFacilitator({ provider, model })}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {submitError && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Could not start the session</AlertTitle>
          <AlertDescription>{submitError}</AlertDescription>
        </Alert>
      )}

      {/* Sticky action bar */}
      <div className="fixed inset-x-0 bottom-0 border-t bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <p className="text-xs text-muted-foreground sm:text-sm">
            {cast.size} personas · {ideasPerAgent} ideas each · {discussionRounds} rounds ·{" "}
            <Badge variant="secondary" className="ml-1 font-mono">
              ~{estimatedCalls} calls
            </Badge>
          </p>
          <Button size="lg" disabled={!canSubmit} onClick={submit}>
            {submitting ? (
              <MoonStar className="animate-spin" />
            ) : (
              <Play />
            )}
            {submitting ? "Convening…" : "Start brainstorming"}
          </Button>
        </div>
      </div>
    </div>
  );
}

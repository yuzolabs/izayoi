import {
  AlertTriangle,
  Check,
  LoaderCircle,
  Play,
  RotateCcw,
  Scale,
  Shuffle,
  Users,
  X,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";

import { CouncilReadout } from "@/components/council-readout";
import { LunarSpine, type SpineStep } from "@/components/lunar-spine";
import { MoonIcon } from "@/components/moon";
import {
  availableProviders,
  ProviderModelSelect,
} from "@/components/provider-select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  api,
  ApiRequestError,
  formatApiValidationIssue,
  type AgentConfig,
  type ApiValidationIssue,
  type Persona,
  type ProviderInfo,
} from "@/lib/api";
import {
  clearCreateSessionDraft,
  readCreateSessionDraft,
  writeCreateSessionDraft,
  type CreateSessionDraft,
} from "@/lib/create-session-draft";
import { groupColorOf, PERSONA_GROUPS } from "@/lib/persona-meta";
import {
  scrollStepSectionIntoView,
  useActiveStepSection,
} from "@/lib/use-active-step-section";
import { cn } from "@/lib/utils";

import {
  SESSION_TEXT_FIELD_MAX_LENGTH,
  validateCreateSessionConstraints,
  validateCreateSessionTheme,
} from "./create-session-field-validation";

const STEP_TITLES = ["Theme", "Cast the council", "Assign models", "Parameters"] as const;
const CREATE_SESSION_THEME_HINT_ID = "theme-hint";
const CREATE_SESSION_THEME_COUNTER_ID = "theme-counter";
const CREATE_SESSION_THEME_ERROR_ID = "theme-error";
const CREATE_SESSION_CONSTRAINTS_HINT_ID = "constraints-hint";
const CREATE_SESSION_CONSTRAINTS_COUNTER_ID = "constraints-counter";
const CREATE_SESSION_CONSTRAINTS_ERROR_ID = "constraints-error";

type CreateSessionTextFieldName = "theme" | "constraints";

interface CreateSessionDraftViewFields {
  theme: string;
  constraints: string;
  cast: Map<string, AgentConfig>;
  balanceCount: number;
  ideasPerAgent: number;
  discussionRounds: number;
  enableJudge: boolean;
  facilitator: { provider: string; model: string };
}

function createSessionCastMapFromDraftAgents(
  agents: readonly AgentConfig[]
): Map<string, AgentConfig> {
  return new Map(agents.map((agent) => [agent.persona_type, { ...agent }]));
}

function createSessionDraftSnapshotFromViewFields(
  fields: CreateSessionDraftViewFields
): CreateSessionDraft {
  return {
    theme: fields.theme,
    constraints: fields.constraints,
    cast: [...fields.cast.values()].map((agent) => ({ ...agent })),
    balanceCount: fields.balanceCount,
    ideasPerAgent: fields.ideasPerAgent,
    discussionRounds: fields.discussionRounds,
    enableJudge: fields.enableJudge,
    facilitator: { ...fields.facilitator },
  };
}

interface CreateSessionFieldFocusRequest {
  field: CreateSessionTextFieldName;
  sequence: number;
}

interface CreateSessionServerValidationErrors {
  theme: string | null;
  constraints: string | null;
  general: string | null;
}

function mapCreateSessionApiValidationIssues(
  issues: readonly ApiValidationIssue[]
): CreateSessionServerValidationErrors {
  const themeMessages: string[] = [];
  const constraintsMessages: string[] = [];
  const generalMessages: string[] = [];

  for (const issue of issues) {
    if (issue.location.includes("theme")) {
      themeMessages.push(issue.message);
    } else if (issue.location.includes("constraints")) {
      constraintsMessages.push(issue.message);
    } else {
      generalMessages.push(formatApiValidationIssue(issue));
    }
  }

  return {
    theme: themeMessages.length > 0 ? themeMessages.join(" ") : null,
    constraints:
      constraintsMessages.length > 0 ? constraintsMessages.join(" ") : null,
    general: generalMessages.length > 0 ? generalMessages.join("; ") : null,
  };
}

/**
 * Setup phases wax like the moon: crescent → half → gibbous → full.
 * The moon phase IS the progress information (see docs/design-foundation.md).
 */
const SETUP_PHASES: SpineStep[] = [
  { id: "step-theme", label: "Theme", illumination: 0.25 },
  { id: "step-cast", label: "Cast", illumination: 0.5 },
  { id: "step-models", label: "Models", illumination: 0.75 },
  { id: "step-parameters", label: "Parameters", illumination: 1 },
];

/** Section header on the paper side: moon glyph + mono number + Fraunces title. */
function StepHeading({
  index,
  illumination,
  aside,
  children,
}: {
  index: number;
  illumination: number;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="create-section__header">
      <MoonIcon
        illumination={illumination}
        className="h-4 w-4 shrink-0 self-center text-primary"
      />
      <span className="font-mono text-xs font-semibold text-primary">
        {String(index + 1).padStart(2, "0")}
      </span>
      <h2 className="font-display text-xl font-semibold tracking-tight">{children}</h2>
      {aside && (
        <span className="ml-auto hidden pl-4 text-right text-xs text-muted-foreground sm:block">
          {aside}
        </span>
      )}
    </div>
  );
}

/**
 * html-level flag for the mobile keyboard focus safe-area contract in
 * index.css: while the fixed actionbar is on screen, the document scroller
 * reserves `4.5rem + safe-area` below focused targets so keyboard focus
 * never lands under the CTA. Searchable contract name — keep in sync with
 * the `html.izayoi-create-actionbar-visible` scroll-padding rule.
 */
const CREATE_ACTIONBAR_HTML_CLASS = "izayoi-create-actionbar-visible";

/**
 * Mount/unmount lifecycle for the html safe-area flag. Adding on mount and
 * removing in cleanup makes route-away, unmount, the loadError early return,
 * and StrictMode double-mount (cleanup runs, effect re-runs) all correct
 * without tracking who navigated where.
 */
function useCreateActionbarHtmlFlag(): void {
  useEffect(() => {
    document.documentElement.classList.add(CREATE_ACTIONBAR_HTML_CLASS);
    return () => {
      document.documentElement.classList.remove(CREATE_ACTIONBAR_HTML_CLASS);
    };
  }, []);
}

/**
 * Mobile action bar — start action only, above the safe area. Last in DOM
 * order so at short-viewport zoom (see the .create-actionbar CSS guard) it
 * flows naturally after the parameters step. Owning the html flag here (not
 * in CreateSession) means the bottom scroll inset exists exactly while this
 * bar is actually mounted.
 */
function CreateActionbar({ children }: { children: React.ReactNode }) {
  useCreateActionbarHtmlFlag();
  return (
    <div className="create-actionbar lg:hidden">
      <div className="create-actionbar__inner mx-auto max-w-6xl px-4 py-2 sm:px-6">
        {children}
      </div>
    </div>
  );
}

export function CreateSession() {
  const navigate = useNavigate();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [createSessionDraftSeed] = useState<CreateSessionDraft | null>(
    readCreateSessionDraft
  );
  const [theme, setTheme] = useState(createSessionDraftSeed?.theme ?? "");
  const [constraints, setConstraints] = useState(
    createSessionDraftSeed?.constraints ?? ""
  );
  const [themeClientError, setThemeClientError] = useState<string | null>(() =>
    createSessionDraftSeed === null
      ? null
      : validateCreateSessionTheme(createSessionDraftSeed.theme)
  );
  const [constraintsClientError, setConstraintsClientError] = useState<
    string | null
  >(() =>
    createSessionDraftSeed === null
      ? null
      : validateCreateSessionConstraints(createSessionDraftSeed.constraints)
  );
  const [themeServerError, setThemeServerError] = useState<string | null>(null);
  const [constraintsServerError, setConstraintsServerError] = useState<string | null>(null);
  const [fieldFocusRequest, setFieldFocusRequest] =
    useState<CreateSessionFieldFocusRequest | null>(null);
  const [cast, setCast] = useState<Map<string, AgentConfig>>(() =>
    createSessionCastMapFromDraftAgents(createSessionDraftSeed?.cast ?? [])
  );
  const [balanceCount, setBalanceCount] = useState(
    createSessionDraftSeed?.balanceCount ?? 4
  );
  const [ideasPerAgent, setIdeasPerAgent] = useState(
    createSessionDraftSeed?.ideasPerAgent ?? 3
  );
  const [discussionRounds, setDiscussionRounds] = useState(
    createSessionDraftSeed?.discussionRounds ?? 2
  );
  const [enableJudge, setEnableJudge] = useState(
    createSessionDraftSeed?.enableJudge ?? true
  );
  const [facilitator, setFacilitator] = useState(
    () => createSessionDraftSeed?.facilitator ?? { provider: "", model: "" }
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const themeFieldRef = useRef<HTMLTextAreaElement>(null);
  const constraintsFieldRef = useRef<HTMLInputElement>(null);
  const fieldFocusSequenceRef = useRef(0);
  const submitInFlightRef = useRef<number | null>(null);
  const submitGenerationRef = useRef(0);
  const createSessionViewMountedRef = useRef(false);
  // Once create succeeds, a CTA retry repeats start for that same session instead
  // of creating another server-side orphan.
  const createdSessionAwaitingStartRef = useRef<string | null>(null);
  const createSessionDraftRetainAfterStartRef = useRef(true);
  const createSessionDraftFieldsRef = useRef<CreateSessionDraftViewFields>({
    theme,
    constraints,
    cast,
    balanceCount,
    ideasPerAgent,
    discussionRounds,
    enableJudge,
    facilitator,
  });
  createSessionDraftFieldsRef.current = {
    theme,
    constraints,
    cast,
    balanceCount,
    ideasPerAgent,
    discussionRounds,
    enableJudge,
    facilitator,
  };

  const persistCreateSessionDraftNow = useCallback(
    (patch: Partial<CreateSessionDraftViewFields>) => {
      if (!createSessionDraftRetainAfterStartRef.current) return;
      const next = { ...createSessionDraftFieldsRef.current, ...patch };
      createSessionDraftFieldsRef.current = next;
      writeCreateSessionDraft(createSessionDraftSnapshotFromViewFields(next));
    },
    []
  );

  const loadMetadata = useCallback(() => {
    setLoadingMeta(true);
    setLoadError(null);
    Promise.all([api.providers(), api.personas()])
      .then(([p, s]) => {
        setProviders(p.providers);
        setPersonas(s.personas);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load metadata"))
      .finally(() => setLoadingMeta(false));
  }, []);

  useEffect(() => {
    createSessionViewMountedRef.current = true;
    return () => {
      createSessionViewMountedRef.current = false;
      submitGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => loadMetadata(), [loadMetadata]);

  useEffect(() => {
    if (facilitator.provider !== "") return;
    const usable = availableProviders(providers);
    if (usable.length === 0) return;
    const nextFacilitator = {
      provider: usable[0].id,
      model: usable[0].models[0],
    };
    setFacilitator(nextFacilitator);
    persistCreateSessionDraftNow({ facilitator: nextFacilitator });
  }, [facilitator.provider, persistCreateSessionDraftNow, providers]);

  useEffect(() => {
    if (fieldFocusRequest === null) return;
    const field =
      fieldFocusRequest.field === "theme"
        ? themeFieldRef.current
        : constraintsFieldRef.current;
    field?.focus();
  }, [fieldFocusRequest]);

  const requestCreateSessionFieldFocus = (field: CreateSessionTextFieldName) => {
    fieldFocusSequenceRef.current += 1;
    setFieldFocusRequest({ field, sequence: fieldFocusSequenceRef.current });
  };

  const updateCreateSessionTheme = (nextTheme: string) => {
    setTheme(nextTheme);
    persistCreateSessionDraftNow({ theme: nextTheme });
    setThemeClientError(null);
    setThemeServerError(null);
  };

  const updateCreateSessionConstraints = (nextConstraints: string) => {
    setConstraints(nextConstraints);
    persistCreateSessionDraftNow({ constraints: nextConstraints });
    setConstraintsClientError(null);
    setConstraintsServerError(null);
  };

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
      persistCreateSessionDraftNow({ cast: next });
      return next;
    });
  };

  const updateAgent = (type: string, patch: Partial<AgentConfig>) => {
    setCast((prev) => {
      const next = new Map(prev);
      const current = next.get(type);
      if (current) next.set(type, { ...current, ...patch });
      persistCreateSessionDraftNow({ cast: next });
      return next;
    });
  };

  const setDevil = (type: string) => {
    setCast((prev) => {
      const next = new Map(prev);
      for (const [key, agent] of next) {
        next.set(key, { ...agent, role: key === type ? "devils_advocate" : "participant" });
      }
      persistCreateSessionDraftNow({ cast: next });
      return next;
    });
  };

  const applyBalanced = async () => {
    try {
      const { types } = await api.balanced(balanceCount);
      const nextCast = assignRoundRobin(types);
      setCast(nextCast);
      persistCreateSessionDraftNow({ cast: nextCast });
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Balanced selection failed");
    }
  };

  const applyAll16 = () => {
    const nextCast = assignRoundRobin(personas.map((p) => p.type));
    setCast(nextCast);
    persistCreateSessionDraftNow({ cast: nextCast });
  };

  const updateCreateSessionBalanceCount = (nextBalanceCount: number) => {
    setBalanceCount(nextBalanceCount);
    persistCreateSessionDraftNow({ balanceCount: nextBalanceCount });
  };

  const updateCreateSessionIdeasPerAgent = (nextIdeasPerAgent: number) => {
    setIdeasPerAgent(nextIdeasPerAgent);
    persistCreateSessionDraftNow({ ideasPerAgent: nextIdeasPerAgent });
  };

  const updateCreateSessionDiscussionRounds = (nextDiscussionRounds: number) => {
    setDiscussionRounds(nextDiscussionRounds);
    persistCreateSessionDraftNow({ discussionRounds: nextDiscussionRounds });
  };

  const updateCreateSessionEnableJudge = (nextEnableJudge: boolean) => {
    setEnableJudge(nextEnableJudge);
    persistCreateSessionDraftNow({ enableJudge: nextEnableJudge });
  };

  const updateCreateSessionFacilitator = (provider: string, model: string) => {
    const nextFacilitator = { provider, model };
    setFacilitator(nextFacilitator);
    persistCreateSessionDraftNow({ facilitator: nextFacilitator });
  };

  const clearCreateSessionCast = () => {
    const nextCast = new Map<string, AgentConfig>();
    setCast(nextCast);
    persistCreateSessionDraftNow({ cast: nextCast });
  };

  const agents = [...cast.values()];
  const devilCount = agents.filter((a) => a.role === "devils_advocate").length;

  const themeValidationError = validateCreateSessionTheme(theme);
  const constraintsValidationError = validateCreateSessionConstraints(constraints);
  const themeInlineError = themeClientError ?? themeServerError;
  const constraintsInlineError = constraintsClientError ?? constraintsServerError;

  /** Why the start action is blocked, in plain words; null when ready to start. */
  const submitBlockReason = themeValidationError
    ?? constraintsValidationError
    ?? (agents.length === 0
      ? "Pick at least two personas — a balanced quartet is a strong start."
      : agents.length === 1
        ? "One more persona — a council needs at least two voices."
        : facilitator.provider === ""
          ? "Choose a facilitator model."
          : null);
  const isCreateSessionFormValid = submitBlockReason === null;
  // `submitting` only presents pending UI; submitInFlightRef owns mutual exclusion.
  const canSubmit = isCreateSessionFormValid && !submitting;
  const estimatedCalls =
    agents.length * (1 + discussionRounds) + 1 + (enableJudge ? agents.length : 0);

  const handleCreateSessionSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    // Validate before taking the single-flight lock. Programmatic state can
    // exceed native maxLength even though browser typing cannot.
    const nextThemeClientError = validateCreateSessionTheme(theme);
    const nextConstraintsClientError = validateCreateSessionConstraints(constraints);
    setThemeClientError(nextThemeClientError);
    setConstraintsClientError(nextConstraintsClientError);

    if (nextThemeClientError !== null || nextConstraintsClientError !== null) {
      setSubmitError(null);
      requestCreateSessionFieldFocus(
        nextThemeClientError !== null ? "theme" : "constraints"
      );
      return;
    }
    if (!isCreateSessionFormValid) return;
    if (submitInFlightRef.current !== null) return;

    const submissionGeneration = submitGenerationRef.current + 1;
    submitGenerationRef.current = submissionGeneration;
    submitInFlightRef.current = submissionGeneration;

    setSubmitting(true);
    setSubmitError(null);
    setThemeServerError(null);
    setConstraintsServerError(null);

    try {
      let sessionId = createdSessionAwaitingStartRef.current;
      if (sessionId === null) {
        const session = await api.createSession({
          theme: theme.trim(),
          constraints: constraints.trim(),
          ideas_per_agent: ideasPerAgent,
          discussion_rounds: discussionRounds,
          agents,
          facilitator,
          enable_judge: enableJudge,
        });
        sessionId = session.id;
        createdSessionAwaitingStartRef.current = sessionId;
      }

      // Do not short-circuit this chain after route-away: every successful
      // create must still receive exactly one start attempt.
      await api.startSession(sessionId);

      if (
        !createSessionViewMountedRef.current ||
        submitGenerationRef.current !== submissionGeneration ||
        submitInFlightRef.current !== submissionGeneration
      ) {
        return;
      }
      createSessionDraftRetainAfterStartRef.current = false;
      clearCreateSessionDraft();
      navigate(`/session/${sessionId}`);
    } catch (error) {
      // Only the generation that owns the lock may release it. A stale failure
      // must never clear a newer attempt's pending UI.
      if (submitInFlightRef.current !== submissionGeneration) return;
      submitInFlightRef.current = null;

      if (
        !createSessionViewMountedRef.current ||
        submitGenerationRef.current !== submissionGeneration
      ) {
        return;
      }

      if (error instanceof ApiRequestError && error.status === 422) {
        const validationErrors = mapCreateSessionApiValidationIssues(
          error.validationIssues
        );
        const hasFieldError =
          validationErrors.theme !== null || validationErrors.constraints !== null;
        setThemeServerError(validationErrors.theme);
        setConstraintsServerError(validationErrors.constraints);
        setSubmitError(
          validationErrors.general ?? (hasFieldError ? null : error.message)
        );

        if (validationErrors.theme !== null) {
          requestCreateSessionFieldFocus("theme");
        } else if (validationErrors.constraints !== null) {
          requestCreateSessionFieldFocus("constraints");
        }
      } else {
        setSubmitError(
          error instanceof Error ? error.message : "Failed to start the session"
        );
      }
      setSubmitting(false);
    }
  };

  // The models step only exists once a cast is picked.
  const steps = useMemo(
    () => SETUP_PHASES.filter((s) => s.id !== "step-models" || cast.size > 0),
    [cast.size]
  );
  const activeStepId = useActiveStepSection(steps.map((s) => s.id));

  if (loadError) {
    return (
      <div className="mx-auto max-w-xl space-y-4 py-8">
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Could not reach the backend</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
        <p className="text-sm text-muted-foreground">
          Start the backend on port 8787 —{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            python -m uvicorn backend.main:app --port 8787
          </code>{" "}
          — then retry.
        </p>
        <Button type="button" variant="outline" onClick={loadMetadata}>
          <RotateCcw />
          Retry
        </Button>
      </div>
    );
  }

  const startButton = (describedBy: string | undefined, buttonClassName?: string) => (
    <Button
      type="submit"
      size="lg"
      disabled={!canSubmit}
      aria-busy={submitting}
      aria-describedby={describedBy}
      className={buttonClassName}
    >
      {submitting ? (
        <LoaderCircle className="animate-spin" aria-hidden="true" />
      ) : (
        <Play aria-hidden="true" />
      )}
      {submitting ? "Convening the council…" : "Start brainstorming"}
    </Button>
  );

  return (
    <form
      className="lg:grid lg:grid-cols-[288px_minmax(0,1fr)] lg:gap-8 xl:gap-10"
      onSubmit={handleCreateSessionSubmit}
    >
      {/* Lunar spine — desktop rail: phase progress, session plan, start action. */}
      <LunarSpine
        variant="rail"
        steps={steps}
        activeId={activeStepId}
        onSelect={scrollStepSectionIntoView}
        className="hidden lg:sticky lg:top-20 lg:flex lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto"
      >
        <CouncilReadout
          variant="rail"
          personaCount={cast.size}
          ideasPerAgent={ideasPerAgent}
          discussionRounds={discussionRounds}
          enableJudge={enableJudge}
          estimatedCalls={estimatedCalls}
          minimumMet={cast.size >= 2}
        />
        <div className="space-y-1.5">
          {startButton(
            submitBlockReason ? "cta-reason-rail" : undefined,
            "w-full"
          )}
          {submitBlockReason && (
            <p id="cta-reason-rail" className="council-readout text-[0.7rem] leading-snug">
              {submitBlockReason}
            </p>
          )}
        </div>
        <p className="font-display text-xs italic leading-snug text-night-muted">
          The council waxes toward the sixteenth night.
        </p>
      </LunarSpine>

      <div className="min-w-0">
        {/* Lunar spine — mobile strip, sticky under the app header. */}
        <LunarSpine
          variant="strip"
          steps={steps}
          activeId={activeStepId}
          onSelect={scrollStepSectionIntoView}
          className="sticky top-14 z-30 lg:hidden"
        />

        {/* Night readout — session plan + start-block reason, parked under
            the strip (static) instead of riding above the safe area. */}
        <div className="lunar-spine mb-8 mt-2 space-y-0.5 px-4 py-3 lg:hidden">
          <CouncilReadout
            variant="bar"
            personaCount={cast.size}
            ideasPerAgent={ideasPerAgent}
            discussionRounds={discussionRounds}
            enableJudge={enableJudge}
            estimatedCalls={estimatedCalls}
            minimumMet={cast.size >= 2}
          />
          {submitBlockReason && (
            <p id="cta-reason-night" className="council-readout text-[0.7rem] leading-snug">
              {submitBlockReason}
            </p>
          )}
        </div>

        <div className="create-content space-y-10 pb-24 lg:pb-0">
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
          <section id="step-theme" className="space-y-4">
            <StepHeading index={0} illumination={0.25} aside="one clear question">
              {STEP_TITLES[0]}
            </StepHeading>
            <Card>
              <CardContent className="space-y-4 p-5">
                <div className="space-y-2">
                  <Label htmlFor="theme">What should the council brainstorm?</Label>
                  <Textarea
                    ref={themeFieldRef}
                    id="theme"
                    value={theme}
                    onInput={(event) =>
                      updateCreateSessionTheme(event.currentTarget.value)
                    }
                    onChange={(event) =>
                      updateCreateSessionTheme(event.currentTarget.value)
                    }
                    onBlur={(event) =>
                      setThemeClientError(
                        validateCreateSessionTheme(event.currentTarget.value)
                      )
                    }
                    placeholder="e.g. Find ten ways to grow a neighborhood repair café without paid advertising"
                    className="min-h-[96px]"
                    required
                    maxLength={SESSION_TEXT_FIELD_MAX_LENGTH}
                    aria-describedby={`${CREATE_SESSION_THEME_HINT_ID} ${CREATE_SESSION_THEME_COUNTER_ID}${themeInlineError === null ? "" : ` ${CREATE_SESSION_THEME_ERROR_ID}`}`}
                    aria-invalid={themeInlineError !== null}
                  />
                  <p
                    id={CREATE_SESSION_THEME_HINT_ID}
                    className="text-xs text-muted-foreground"
                  >
                    One clear question works better than a topic area.
                  </p>
                  <p
                    id={CREATE_SESSION_THEME_COUNTER_ID}
                    className="font-mono text-xs text-muted-foreground"
                  >
                    {theme.length} / {SESSION_TEXT_FIELD_MAX_LENGTH}
                  </p>
                  {themeInlineError !== null && (
                    <p
                      id={CREATE_SESSION_THEME_ERROR_ID}
                      className="text-xs text-destructive"
                    >
                      {themeInlineError}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="constraints">
                    Constraints <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    ref={constraintsFieldRef}
                    id="constraints"
                    value={constraints}
                    onInput={(event) =>
                      updateCreateSessionConstraints(event.currentTarget.value)
                    }
                    onChange={(event) =>
                      updateCreateSessionConstraints(event.currentTarget.value)
                    }
                    onBlur={(event) =>
                      setConstraintsClientError(
                        validateCreateSessionConstraints(event.currentTarget.value)
                      )
                    }
                    placeholder="e.g. No budget over $500, must work for non-technical members"
                    maxLength={SESSION_TEXT_FIELD_MAX_LENGTH}
                    aria-describedby={`${CREATE_SESSION_CONSTRAINTS_HINT_ID} ${CREATE_SESSION_CONSTRAINTS_COUNTER_ID}${constraintsInlineError === null ? "" : ` ${CREATE_SESSION_CONSTRAINTS_ERROR_ID}`}`}
                    aria-invalid={constraintsInlineError !== null}
                  />
                  <p
                    id={CREATE_SESSION_CONSTRAINTS_HINT_ID}
                    className="text-xs text-muted-foreground"
                  >
                    Add limits, exclusions, or context; leave blank if there are none.
                  </p>
                  <p
                    id={CREATE_SESSION_CONSTRAINTS_COUNTER_ID}
                    className="font-mono text-xs text-muted-foreground"
                  >
                    {constraints.length} / {SESSION_TEXT_FIELD_MAX_LENGTH}
                  </p>
                  {constraintsInlineError !== null && (
                    <p
                      id={CREATE_SESSION_CONSTRAINTS_ERROR_ID}
                      className="text-xs text-destructive"
                    >
                      {constraintsInlineError}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Step 2 — Cast */}
          <section id="step-cast" className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <StepHeading index={1} illumination={0.5} aside="4–6 diverse voices">
                {STEP_TITLES[1]}
              </StepHeading>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  aria-label="Balanced selection size"
                  value={String(balanceCount)}
                  onChange={(e) =>
                    updateCreateSessionBalanceCount(Number(e.target.value))
                  }
                  className="w-16"
                >
                  {[4, 5, 6].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
                <Button type="button" variant="outline" size="sm" onClick={applyBalanced}>
                  <Shuffle />
                  Balanced pick
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={applyAll16}
                  disabled={loadingMeta}
                >
                  <Users />
                  All 16
                </Button>
                {cast.size > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearCreateSessionCast}
                  >
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
                  {cast.size} agents × ({ideasPerAgent} ideas + {discussionRounds} discussion
                  rounds) means roughly {estimatedCalls} LLM calls before judging. All-16 mode
                  is powerful but expensive and slow.
                </AlertDescription>
              </Alert>
            )}

            {loadingMeta ? (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                {PERSONA_GROUPS.map((group) => (
                  <div key={group.id} className="space-y-2" aria-hidden="true">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: group.color }}
                      />
                      <span className="text-sm font-medium">{group.label}</span>
                    </div>
                    <div className="space-y-2">
                      {group.types.map((type) => (
                        <Skeleton key={type} className="h-[76px] rounded-md" />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
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
                            aria-pressed={selected}
                            style={
                              selected
                                ? {
                                    borderColor: groupColorOf(type),
                                    boxShadow: `0 0 0 1px ${groupColorOf(type)}`,
                                  }
                                : undefined
                            }
                            className={cn(
                              "w-full rounded-md border bg-card p-3 text-left transition-all",
                              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                              "hover:border-foreground/30",
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
                              {selected && (
                                <Check
                                  className="h-4 w-4"
                                  style={{ color: groupColorOf(type) }}
                                  aria-hidden="true"
                                />
                              )}
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
            )}
            <p className="text-xs text-muted-foreground">
              {cast.size} of 16 selected — a diverse quartet usually beats a uniform crowd.
            </p>
          </section>

          {/* Step 3 — Assign */}
          {cast.size > 0 && (
            <section id="step-models" className="space-y-4">
              <StepHeading index={2} illumination={0.75} aside="spread model families">
                {STEP_TITLES[2]}
              </StepHeading>
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
                      <div className="create-agent-row__persona flex w-40 shrink-0 items-center gap-2">
                        <span className="font-mono text-sm font-semibold">
                          {agent.persona_type}
                        </span>
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
                          labelPrefix={agent.persona_type}
                          onChange={(provider, model) =>
                            updateAgent(agent.persona_type, { provider, model })
                          }
                        />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant={agent.role === "devils_advocate" ? "default" : "outline"}
                        className="shrink-0"
                        title="Designate as devil's advocate"
                        aria-pressed={agent.role === "devils_advocate"}
                        aria-label={`${agent.persona_type} devil's advocate`}
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
          <section id="step-parameters" className="space-y-4">
            <StepHeading index={3} illumination={1} aside="saturation past 2–3 rounds">
              {STEP_TITLES[3]}
            </StepHeading>
            <Card>
              <CardContent className="space-y-6 p-5">
                <div className="grid gap-6 sm:grid-cols-2">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label id="ideas-per-persona-slider-label">Ideas per persona</Label>
                      <span className="font-mono text-sm">{ideasPerAgent}</span>
                    </div>
                    <Slider
                      min={1}
                      max={10}
                      step={1}
                      value={[ideasPerAgent]}
                      onValueChange={([v]) => updateCreateSessionIdeasPerAgent(v)}
                      aria-labelledby="ideas-per-persona-slider-label"
                      aria-describedby="ideas-per-persona-slider-description"
                      aria-valuetext={`${ideasPerAgent} ${ideasPerAgent === 1 ? "idea" : "ideas"} per persona`}
                    />
                    <p
                      id="ideas-per-persona-slider-description"
                      className="text-xs text-muted-foreground"
                    >
                      Generated in isolation, before anyone sees anyone else's work.
                    </p>
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label id="discussion-rounds-slider-label">Discussion rounds</Label>
                      <span className="font-mono text-sm">{discussionRounds}</span>
                    </div>
                    <Slider
                      min={0}
                      max={3}
                      step={1}
                      value={[discussionRounds]}
                      onValueChange={([v]) =>
                        updateCreateSessionDiscussionRounds(v)
                      }
                      aria-labelledby="discussion-rounds-slider-label"
                      aria-describedby="discussion-rounds-slider-description"
                      aria-valuetext={
                        discussionRounds === 0
                          ? "No discussion rounds"
                          : `${discussionRounds} discussion ${discussionRounds === 1 ? "round" : "rounds"}`
                      }
                    />
                    <p
                      id="discussion-rounds-slider-description"
                      className="text-xs text-muted-foreground"
                    >
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
                    <Switch
                      type="button"
                      id="judge"
                      checked={enableJudge}
                      onCheckedChange={updateCreateSessionEnableJudge}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Facilitator model</Label>
                    <ProviderModelSelect
                      providers={providers}
                      provider={facilitator.provider}
                      model={facilitator.model}
                      compact
                      labelPrefix="Facilitator"
                      onChange={updateCreateSessionFacilitator}
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
        </div>
      </div>

      {/* Mobile action bar — start action only, above the safe area. Last in
          DOM order so at short-viewport zoom (see .create-actionbar CSS guard)
          it flows naturally after the parameters step. Also owns the
          izayoi-create-actionbar-visible html flag for the bottom scroll
          inset while mounted. */}
      <CreateActionbar>
        {startButton(submitBlockReason ? "cta-reason-night" : undefined, "w-full")}
      </CreateActionbar>
    </form>
  );
}

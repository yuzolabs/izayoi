# izayoi — MBTI Persona Brainstorming (Cloud API Edition) — Specification

This document is the self-contained technical specification for **izayoi**, a local-only web
tool that runs brainstorming sessions between multiple LLM agents, each impersonating one of
the 16 MBTI personality types, in order to surface a diversity of ideas that a single model
cannot produce.

All product content (UI copy, persona definitions, mock responses, comments, documentation)
is written in **English**.

## 1. Hard constraints

| # | Constraint |
|---|-----------|
| C1 | Cloud LLM APIs only. OpenAI / Anthropic / Google / xAI / ZAI are called uniformly through LiteLLM. |
| C2 | No local LLM support (no Ollama or any other local inference / local embedding models). |
| C3 | No heavyweight ML dependencies (torch, sentence-transformers, ...). Anything that needs embeddings uses a cloud embedding API or pure Python (numpy only). |
| C4 | Local-only tool. Each provider's API key is read from the local machine's environment variables and is never stored in the DB, written to logs, or displayed in the UI. |
| C5 | The brainstorming design (§2) is a fixed specification and must be preserved. |

## 2. Brainstorming design (fixed)

### 2.1 Session structure — 4 phases

```
[Phase 0] Framing (facilitator)
  User theme -> structure the goal, constraints and evaluation axes.
  Osborn's "defer judgment" rule is announced to every agent.
      |
[Phase 1] Independent Divergence  * most important
  Each persona generates N ideas WITHOUT seeing the others' output
  (blocks production blocking). The pool is frozen immediately after
  generation and is never overwritten by later discussion.
      |
[Phase 2] Collaborative Discussion
  tit-for-tat intensity 1.0 (reply to the immediately previous speaker)
  x up to R rounds (default 2). Anonymous display (Persona A/B/...),
  initial scores hidden, one devil's advocate is designated.
  Early stop on stagnation (all messages short / agreement rate > 90%).
  Purpose is "refinement and new derivations" only. The independent pool is kept.
      |
[Phase 3] Convergence
  1. embedding dedup (cos >= 0.8)
  2. re-synthesis (facilitator LLM merges duplicate clusters, states tension axes)
  3. LLM judge pre-ranking (Novelty / Feasibility / Clarity, 1-10)
  4. the human makes the final selection and records adoption notes
```

### 2.2 Design rationale (excerpt)

| Decision | Rationale |
|---|---|
| Independent ideation precedes discussion | production blocking (Diehl & Stroebe 1987); a single LLM's continuous generation has low diversity (Lu et al. 2024) |
| Discussion capped at 2-3 rounds | saturation / negative effect beyond 3 rounds (Estornell & Liu, ICML 2024); tit-for-tat is a stable solution (Smit et al. 2023) |
| 4-6 diverse members | a heterogeneous pair beats 16 homogeneous agents (ahmia et al. 2025). All-16 mode is optional |
| Detailed personas + re-priming | empty MBTI labels hurt performance (Tseng et al. 2024); drift countermeasure (PersonaDrift, EACL 2026) |
| Judge is advisory | LLM grading agrees with humans only ~50% of the time. The final decision is human |

## 3. Persona design

### 3.1 Persona JSON (16 types)

`backend/personas/mbti_16.json` defines all 16 types. Each type has these 11 fields
(MBTI-in-Thoughts 7-section compliant):

```json
{
  "type": "INTJ",
  "name_ja": "Architect",
  "core_traits": "...",
  "strengths": "...",
  "weaknesses": "...",
  "cognitive_style": "...",
  "motivations": "...",
  "behavioral_tendencies": "...",
  "communication_style": "...",
  "scenario_hint": "... (concrete behavior instructions for brainstorming)",
  "output_format": "... (ideas as bullet points, 1-2 sentences each, one line of rationale)"
}
```

Note: the API field is named `name_ja` for contract compatibility, but its value is the
English persona name.

### 3.2 Prompt composition (re-injected at the top of every turn = re-priming)

1. Role declaration ("You are INTJ (Architect)" + 7-section summary)
2. Situational context (brainstorming, deferred-judgment rule)
3. Concrete scenario (session theme and constraints)
4. Behavioral instructions (per-phase task)
5. Output format
6. A few short examples (optional)

### 3.3 Selection logic

- Manual selection or "balanced selection" (minimizes bias on the E/I, T/F and J/P axes for 4-6 members)
- "All 16" mode is optional (the UI shows a cost warning)
- A different provider/model can be assigned to each persona (model-family diversity is the core diversity strategy)

## 4. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Backend | Python 3.11+, FastAPI, LiteLLM, SQLite (stdlib sqlite3) | SSE is hand-rolled (no sse-starlette) |
| LLM calls | LiteLLM `acompletion` (model strings: `openai/...`, `anthropic/...`, `gemini/...`, `xai/...`, `zai/...`) | **litellm is lazily imported inside functions** so Mock-only environments can still boot |
| Embeddings | 1. Cloud embedding API (LiteLLM `aembedding`, default `openai/text-embedding-3-small`) when a usable key exists. 2. Otherwise falls back to numpy-only character-bigram TF-IDF | **No torch at all (C3)** |
| Frontend | React 19 + Vite + TypeScript + Tailwind CSS v3 + shadcn/ui-style components | Built static files are served by FastAPI (SPA) |
| Packaging | requirements.txt / Dockerfile / README.md / .env.example | Docker image stays lightweight |

## 5. Providers, metrics, security

### 5.1 Providers and environment variables (cloud only)

| Provider | Env var | Example models |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | gpt-5.6-luna |
| Anthropic | `ANTHROPIC_API_KEY` | claude-sonnet-5, claude-haiku-4-5 |
| Google | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | gemini-3.6-flash |
| xAI | `XAI_API_KEY` | grok-4.5 |
| ZAI | `ZAI_API_KEY` | GLM-5.2 |
| **Mock** | none | for verification without keys (see §7.3) |

- On startup / per request the environment is inspected and the detected provider list is returned by the API.
- No local-inference entries (Ollama etc.) appear in the provider list.

### 5.2 Security

- Bind defaults to `127.0.0.1` (overridable via env var).
- CORS allows only `http://localhost:*` / `http://127.0.0.1:*`.
- API keys are referenced via env only. Never logged, never stored in the DB.
- Only one session may run at a time.

### 5.3 Metrics (implemented without torch)

- `dedup_ideas(texts, threshold=0.8)`:
  - If a usable cloud key exists, embeddings come from LiteLLM `aembedding` and clustering uses cosine similarity (model overridable with `EMBEDDING_MODEL`, default `openai/text-embedding-3-small`).
  - Without keys, falls back to **numpy-only character-bigram TF-IDF** cosine similarity (character n-grams also handle Japanese).
- `semantic_dispersion`: mean distance of embeddings from their centroid (same for TF-IDF).
- `non_duplicate_ratio` (NDR), `collapse_alert` (NDR < 0.5 or extremely small dispersion).

## 6. API contract (frozen — the basis for parallel front/back implementation)

### 6.1 Types (identical on both ends: TS interfaces / Pydantic models)

```ts
ProviderInfo = { id: string; label: string; available: boolean; env_var: string|null; models: string[] }
Persona = { type: string; name_ja: string; summary: string }
AgentConfig = { persona_type: string; provider: string; model: string; role: "participant" | "devils_advocate" }
SessionCreate = {
  theme: string; constraints: string;
  ideas_per_agent: number;      // 1..10, default 3
  discussion_rounds: number;    // 0..3, default 2
  agents: AgentConfig[];        // 2..16
  facilitator: { provider: string; model: string };
  enable_judge: boolean;        // default true
}
Session = {
  id: string; theme: string; constraints: string;
  status: "framing"|"divergence"|"discussion"|"convergence"|"done"|"error";
  phase_progress: string; agents: AgentConfig[]; created_at: string;
  metrics: SessionMetrics|null;
}
SessionMetrics = {
  total_ideas: number; unique_ideas: number;
  non_duplicate_ratio: number; semantic_dispersion: number; collapse_alert: boolean;
}
Idea = {
  id: string; session_id: string; persona_type: string;  // discussion-derived: "DISCUSSION:<TYPE>"
  phase: "divergence"|"discussion"; content: string;
  cluster_id: number|null; synthesized: string|null;
  scores: IdeaScores|null; decision: "pending"|"adopted"|"held"|"rejected"; note: string;
}
IdeaScores = { novelty: number; feasibility: number; clarity: number; total: number }
DecisionUpdate = { decision: "pending"|"adopted"|"held"|"rejected"; note?: string }
```

### 6.2 REST endpoints

| Method | Path | Input | Output | Description |
|---|---|---|---|---|
| GET | `/api/providers` | — | `{ providers: ProviderInfo[] }` | env-var detection result |
| GET | `/api/personas` | — | `{ personas: Persona[] }` | all 16 types |
| POST | `/api/sessions` | `SessionCreate` | `Session` (201) | create |
| POST | `/api/sessions/{id}/start` | — | 202 | start execution (async) |
| GET | `/api/sessions/{id}` | — | `Session` | state & metrics |
| GET | `/api/sessions/{id}/ideas` | — | `{ ideas: Idea[] }` | all ideas |
| PATCH | `/api/ideas/{id}/decision` | `DecisionUpdate` | `Idea` | human final decision |
| GET | `/api/sessions` | — | `{ sessions: Session[] }` | history |
| GET | `/api/sessions/{id}/export` | `?format=md|json` | file | export |

### 6.3 SSE stream

`GET /api/sessions/{id}/stream` — `text/event-stream`. Every event carries JSON data:

```jsonc
{ "type": "phase",       "phase": "divergence", "label": "Independent Divergence" }
{ "type": "agent_start", "agent": "INTJ", "round": 1, "task": "ideate" }
{ "type": "token",       "agent": "INTJ", "round": 1, "delta": "..." }
{ "type": "agent_done",  "agent": "INTJ", "round": 1 }
{ "type": "idea",        "idea": Idea }                    // sent twice: on creation + on convergence update
{ "type": "message",     "round": 2, "from": "Persona A", "content": "..." }
{ "type": "metrics",     "metrics": SessionMetrics }
{ "type": "phase",       "phase": "done" }
{ "type": "error",       "message": "..." }
```

- One connection per session. Ends on `done` / `error`.
- **Connecting to a completed session replays phase/ideas/messages/metrics from the DB** and then closes.
- A live session fans out to a per-subscriber queue seeded with the history (see P1 in §8).

### 6.4 DB schema (SQLite)

```sql
sessions(id TEXT PK, theme TEXT, constraints TEXT, config_json TEXT,
         status TEXT, phase_progress TEXT, metrics_json TEXT, created_at TEXT);
ideas(id TEXT PK, session_id TEXT, persona_type TEXT, phase TEXT, content TEXT,
      cluster_id INT, synthesized TEXT, scores_json TEXT, decision TEXT, note TEXT,
      created_at TEXT);
messages(id TEXT PK, session_id TEXT, round INT, anon_name TEXT, persona_type TEXT,
         content TEXT, created_at TEXT);
```

## 7. Frontend notes

### 7.1 Views (English UI, 4 views)

1. **Create session** `/`: theme/constraints inputs, 16-type persona grid (4 group color chips:
   Analysts `#88619a` / Diplomats `#33a474` / Sentinels `#4298b4` / Explorers `#e4ae3a`),
   balanced-selection button, all-16 mode (with cost warning), per-persona provider/model
   assignment (only available providers selectable; undetected ones grayed out with
   "env var XXX not set"), parameters (ideas_per_agent 1..10 default 3 /
   discussion_rounds 0..3 default 2 / enable_judge default ON / facilitator).
2. **Session live** `/session/:id`: phase stepper (5 stages), per-agent cards with per-token
   streaming, discussion log (anonymous names, rounds), confirmed ideas appended live,
   metric tiles, collapse warning banner.
3. **Results** `/session/:id/results`: cluster-grouped ideas, re-synthesized text, score
   badges + "LLM scores are advisory (~50% agreement with humans)" note,
   adopt/hold/reject + memo (PATCH), md/json export.
4. **History** `/history`: session list (theme, date, status, metrics summary).

### 7.2 Design direction

The functional beauty of a local work tool: low saturation, warm neutral base, generous
whitespace, no blue-purple gradients, shadcn/ui-style components.

### 7.3 Mock provider specification

- Always available. Model name `mock`.
- **Deterministic English dummy responses** incorporating the persona type, theme, idea
  number and round (idea texts must differ enough that dedup does not wipe them out).
- Splits output into tokens and yields them at 0.01 s intervals (to validate streaming).

## 8. Implementation pitfalls (must avoid)

| # | Pitfall | Countermeasure |
|---|---|---|
| P1 | A single shared SSE queue causes event contention/loss on multiple (re)connections and double-sends with DB replay | Keep a per-session history list + fan out to per-subscriber queues. A subscriber gets its own queue pre-seeded with the history. After completion, drop the history and switch to DB replay |
| P2 | The `idea` event is sent twice (creation + convergence update) | The frontend upserts by id (first adds, second updates cluster_id/scores) |
| P3 | SPA deep links (`/session/:id`) return 404 | The FastAPI StaticFiles fallback must catch `starlette.exceptions.HTTPException` (404) and return index.html (catching `fastapi.HTTPException` does not intercept starlette's) |
| P4 | Vite `base: './'` breaks asset resolution on deep routes (blank page) | Use `base: '/'` |
| P5 | On completed-session replay `phase=done` may arrive first while the frontend closes EventSource immediately on done, discarding later ideas/messages/metrics | On done/error only set a flag; never close — let the server close |
| P6 | Without litellm installed even Mock does not run | Import litellm lazily inside the calling functions |
| P7 | Re-viewing a completed session leaves agent cards stuck on "waiting" | When the phase is done, treat cards as "completed" and show a "no per-token replay" note |

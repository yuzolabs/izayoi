# izayoi — MBTI persona brainstorming

**izayoi** is a local-only web tool that convenes a council of LLM agents — each
impersonating one of the 16 MBTI personality types — to brainstorm a theme you
care about. Because every persona ideates in isolation before anyone sees
anyone else's work, and the debate that follows is anonymized with a
designated devil's advocate, the idea pool keeps a diversity that a single
model (or a classic group brainstorm) cannot reach.

The name comes from the moon of the sixteenth lunar night: the session's four
phases wax like the moon, and the work closes under the sixteenth-night moon.

```
Framing ──► Independent divergence ──► Collaborative discussion ──► Convergence
(facilitator)  (isolated, parallel)     (anonymous, tit-for-tat)     (dedup →
                                                                      synthesis →
                                                                      judge →
                                                                      YOU decide)
```

- **Cloud LLMs only** — OpenAI / Anthropic / Google / xAI / ZAI through LiteLLM.
  No local inference, no torch, no heavyweight ML dependencies.
- **Local-only** — binds `127.0.0.1`, CORS is localhost-only, API keys are read
  from environment variables and are never stored, logged, or displayed.
- **Mock provider included** — every feature works without any API key.

See [SPEC.md](SPEC.md) for the full technical specification and the design
rationale (production blocking, saturation after 2–3 rounds, persona
re-priming, why the LLM judge is advisory only).

## Quick start (local)

Requirements: Python 3.11+ and Node 18+ (or bun).

```bash
# 1. Backend dependencies (5 runtime packages)
pip install -r requirements.txt          # or: uv pip install -r requirements.txt

# 2. Build the frontend (one-time; output is served by FastAPI as a SPA)
cd frontend
bun install --frozen-lockfile            # npm install works too
bun run build                            # npm run build
cd ..

# 3. Run — opens on http://127.0.0.1:8787
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8787
```

With no API keys set, the **Mock** provider is auto-selected everywhere, so you
can run a full session immediately. Set one or more keys (below) and those
providers become selectable per persona.

### Frontend development mode

```bash
cd frontend && bun run dev    # Vite on :5173, proxies /api to 127.0.0.1:8787
```

## Environment variables

Copy `.env.example` for the annotated list. Keys are read from the process
environment only.

| Variable | Provider | Example models |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI | gpt-5.6-luna, gpt-5-mini, gpt-4.1 |
| `ANTHROPIC_API_KEY` | Anthropic | claude-sonnet-5, claude-haiku-4-5 |
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | Google | gemini-3.6-flash |
| `XAI_API_KEY` | xAI | grok-4.5 |
| `ZAI_API_KEY` | ZAI | GLM-5.2 |
| — | **Mock** (always available) | mock |

Optional overrides:

| Variable | Default | Purpose |
|---|---|---|
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | Embedding model for idea dedup. Without a usable key, a numpy-only character-bigram TF-IDF fallback is used instead |
| `IZAYOI_HOST` | `127.0.0.1` | Bind address |
| `IZAYOI_PORT` | `8787` | Port |
| `IZAYOI_DB_PATH` | `izayoi.db` | SQLite file location |
| `IZAYOI_FRONTEND_DIST` | `frontend/dist` | SPA directory served by FastAPI |

## Mock provider

The Mock provider is always available and produces deterministic English
responses that embed the persona type, theme, idea number and round, streamed
in small chunks. It exercises the complete pipeline — four phases, SSE
streaming, dedup, synthesis, judging, metrics — so tests and demos need no
keys and incur no cost.

## Docker

```bash
docker build -t izayoi .
docker run --rm -p 8787:8787 \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -v izayoi-data:/data \
  izayoi
# open http://127.0.0.1:8787
```

The image is a two-stage build (bun builds the SPA, `python:3.12-slim` serves
it). SQLite lives in the `/data` volume. Omit the `-e` flags to run Mock-only.

## Tests

The suite runs entirely on the Mock provider — no network, no litellm required.

```bash
pip install -r requirements-dev.txt
python -m pytest backend/tests -q
```

Covers: provider env detection, persona JSON completeness (16 types × 11
fields), balanced-selection axis bias, a full E2E session lifecycle
(create → start → done → decision → export), SSE fan-out to concurrent
subscribers plus DB replay, and the SPA deep-link fallback. A real-browser E2E
record with screenshots lives in [docs/e2e/CHECKLIST.md](docs/e2e/CHECKLIST.md).

## Project layout

```
backend/
  main.py          FastAPI app: REST + hand-rolled SSE + SPA hosting
  orchestrator.py  4-phase engine with per-subscriber SSE fan-out
  providers.py     env detection, lazy LiteLLM wrapper, Mock provider
  personas.py      persona registry, re-priming prompts, balanced selection
  metrics.py       cloud embeddings / numpy TF-IDF, dedup, dispersion, NDR
  db.py            SQLite (stdlib sqlite3)
  models.py        Pydantic models (frozen API contract)
  personas/mbti_16.json   16 detailed persona definitions
  tests/test_backend.py
frontend/          React 19 + Vite + TS + Tailwind v3, shadcn-style UI
SPEC.md            self-contained specification
Dockerfile         multi-stage: bun build → python:3.12-slim
```

## How a session works

1. **Framing** — the facilitator structures goal, constraints and evaluation
   axes and announces Osborn's deferred-judgment rule.
2. **Independent divergence** — each persona generates N ideas in parallel,
   seeing nobody else's output; the pool is frozen (production blocking is
   cut off at the root).
3. **Collaborative discussion** — anonymized (Persona A/B/…), tit-for-tat
   replies for up to R rounds (default 2; saturation sets in beyond 3), one
   devil's advocate, early stop on stagnation. New derivations join the pool
   as discussion ideas; the independent pool is never overwritten.
4. **Convergence** — embedding dedup (cos ≥ 0.8), facilitator re-synthesis of
   duplicate clusters with explicit tension axes, LLM judge pre-ranking
   (Novelty/Feasibility/Clarity — advisory only; agreement with humans is
   ~50%), then **you** adopt/hold/reject with memos and export to
   Markdown/JSON.

## Known limitations

- One session runs at a time (starting a second returns 409).
- LLM judge scores are advisory triage, not decisions.
- Per-token streaming is live-only; revisiting a finished session replays
  ideas, messages and metrics from the DB, not keystroke-by-keystroke output.
- Per-token replay fidelity of model failures: an agent that errors mid-run is
  skipped and noted in the log rather than retried.
- The TF-IDF dedup fallback is coarser than cloud embeddings; exact
  near-duplicates are caught, paraphrase-level duplicates may survive.

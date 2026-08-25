# izayoi — MBTI persona brainstorming

**izayoi** is a local-only Web and command-line tool that convenes a council of
LLM agents. Each agent impersonates one of the 16 MBTI personality types to
brainstorm a theme you care about. Every persona ideates in isolation before
seeing anyone else's work. The debate that follows is anonymous and appoints a
designated devil's advocate. This preserves more diversity than a single model
or classic group brainstorm.

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
- **Local-only** — binds `127.0.0.1`, and CORS is localhost-only. API keys are
  read from environment variables. They are never stored, logged or displayed.
- **Mock provider included** — every feature works without any API key.

See [SPEC.md](SPEC.md) for the full technical specification and the design
rationale (production blocking, saturation after 2–3 rounds, persona
re-priming, why the LLM judge is advisory only).

## Quick start (local)

Requirements: Python 3.12+ and Node 18+ (or bun).

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

## Command line

Install the checkout to make the `izayoi` command available:

```bash
python -m pip install .
```

`izayoi --version` or `izayoi -V` prints `izayoi <package version>` and exits.
These flags are top-level only; `izayoi run --version` is not accepted.

The shortest full run uses the deterministic Mock provider and writes JSON to
stdout:

```bash
izayoi run --theme "Improve onboarding"
```

Set a provider key to run the same session with a real provider:

```bash
OPENAI_API_KEY=... izayoi run \
  --theme "Improve onboarding" \
  --provider openai --model gpt-5-mini
```

Pass `--theme -` to read the complete theme from stdin. Select `json` or `md`
with `--format`, and use `--output PATH` instead of the default `-` to write a
UTF-8 file:

```bash
printf '%s\n' 'Improve onboarding' | izayoi run --theme -
izayoi run --theme "Improve onboarding" --format md
izayoi run --theme "Improve onboarding" --format json --output session.json
```

`izayoi run` waits at most `--timeout` seconds after the session starts
(default `900`; `--timeout 0` disables the limit). An unresponsive provider is
cancelled the same way as `SIGTERM`. The run records `Timed out after 900s`,
releases the run lock, and exits `1` without a traceback. `SIGINT` and
`SIGTERM` still take priority if they arrive before that deadline.

Every run is persisted, and its JSON result contains `session.id`. Export that
session later without rerunning it; export defaults to JSON on stdout:

```bash
izayoi export SESSION_ID
izayoi export SESSION_ID --format json --output session.json
izayoi export SESSION_ID --format md --output session.md
```

Both commands use `izayoi.db` by default. Set `IZAYOI_DB_PATH` to use another
SQLite file, and use the same value when running and exporting:

```bash
IZAYOI_DB_PATH="$HOME/.local/share/izayoi.db" \
  izayoi export SESSION_ID --format md
```

`izayoi export` writes a finished transcript only for a terminal `done` or
`error` session. A live-phase status is one of `framing`, `divergence`,
`discussion`, or `convergence`. Export does not write that in-progress session
as a finished transcript. It writes one stderr line such as
`izayoi: error: session '<id>' is still running (status=framing)`, then exits
`1` with empty stdout. An unknown status is also refused with exit `1` rather
than rendered as a completed transcript. Export does not take the run lock or
change session, idea, or message rows.

With `--output -`, stdout contains only the JSON or Markdown result. Run
progress and all errors go to stderr; a successful export to a file is quiet.
Exit status is `0` for success and `2` for invalid usage, including a missing
provider key or an unknown provider or model. Runtime failures
exit `1` and include missing sessions, write errors, a closed stdout pipe
during a result write, and an export of a session that is still running or has
an unknown status. A closed stderr progress pipe stops progress printing
and lets the run finish; the CLI does not die with CPython exit `120` or
install `SIGPIPE` `SIG_DFL`. `SIGINT` records
`Interrupted by user` and exits `130`. `SIGTERM` gracefully cancels an active
run, waits for provider and lock cleanup, and records `Terminated by SIGTERM`;
after cleanup it exits `143`. `SIGKILL` cannot run cleanup, so its orphan is
recovered by the next run. Expected failures do not print tracebacks.

## Environment variables

Copy `.env.example` for the annotated list. Keys are read from the process
environment only.

| Variable | Provider | Example models |
| --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI | gpt-5.6-luna, gpt-5-mini, gpt-4.1 |
| `ANTHROPIC_API_KEY` | Anthropic | claude-sonnet-5, claude-haiku-4-5 |
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | Google | gemini-3.6-flash |
| `XAI_API_KEY` | xAI | grok-4.5 |
| `ZAI_API_KEY` | ZAI | GLM-5.2 |
| — | **Mock** (always available) | mock |

`izayoi run` reuses this detection before it creates a session, acquires the
run lock, or calls a provider. If a cloud provider's key is unset, the command
exits `2` with one stderr line:

```text
izayoi: error: provider 'openai' requires OPENAI_API_KEY
```

Unknown provider names and unregistered models are rejected the same way.
The Mock provider needs no key and starts immediately. Authentication errors
that appear only after the run has started stay a session `error` and exit
`1`.

Optional overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | Embedding model for idea dedup. Without a usable key, a numpy-only character-bigram TF-IDF fallback is used instead |
| `IZAYOI_HOST` | `127.0.0.1` | Bind address |
| `IZAYOI_PORT` | `8787` | Port |
| `IZAYOI_DB_PATH` | `izayoi.db` | SQLite file location |
| `IZAYOI_FRONTEND_DIST` | `frontend/dist` | SPA directory served by FastAPI |

## Mock provider

The Mock provider is always available and streams deterministic English
responses in small chunks. Each response embeds the persona type, theme, idea
number and round. It exercises all four phases, including SSE streaming and
dedup. It also covers synthesis, judging and metrics, so tests and demos need
no keys and incur no cost.

## Docker

Build the Web and command-line distribution once, and create a named volume for
sessions:

```bash
docker build -t izayoi .
docker volume create izayoi-data
```

### Web interface

The default command starts the Web server on port 8787:

```bash
docker run --rm -p 8787:8787 \
  -v izayoi-data:/data \
  izayoi
# open http://127.0.0.1:8787
```

Add `-e OPENAI_API_KEY` (or another provider key) after `docker run` to use a
cloud provider. Without a key, the Mock provider remains available.

### Command line

Override the entry point to run the CLI. The following commands run a session,
read its ID, export it from a second container and verify that both JSON files
are identical:

```bash
docker run --rm \
  -v izayoi-data:/data \
  --entrypoint izayoi \
  izayoi run --theme "Improve onboarding" > session.json

SESSION_ID="$(
  python -c 'import json, sys; print(json.load(sys.stdin)["session"]["id"])' \
    < session.json
)"

docker run --rm \
  -v izayoi-data:/data \
  --entrypoint izayoi \
  izayoi export "$SESSION_ID" > exported-session.json
cmp session.json exported-session.json
```

The two-stage image builds the SPA with bun and serves it from
`python:3.12-slim`. Both interfaces run as non-root UID 10001 and use
`/data/izayoi.db`; the named volume preserves the database and run locks across
containers.

## Tests

The suite runs entirely on the Mock provider — no network, no litellm required.
Backend tests install through uv only. They do not need Node or the repository
`node_modules` tree. Development extras (`pytest`, `httpx`, `markdown-it-py`,
`prek`) live in `pyproject.toml` `[dependency-groups] dev`.

```bash
uv sync --group dev
uv run pytest backend/tests -q
```

The suite covers provider environment detection and persona JSON completeness
(16 types × 11 fields). It also covers balanced-selection axis bias and a full
E2E session lifecycle (create → start → done → decision → export). Other tests
exercise concurrent SSE fan-out, DB replay and the SPA deep-link fallback. A
real-browser E2E record with screenshots lives in
[docs/e2e/CHECKLIST.md](docs/e2e/CHECKLIST.md).

## Project layout

```
backend/
  cli.py           non-interactive run and persisted-session export commands
  main.py          FastAPI app: REST + hand-rolled SSE + SPA hosting
  orchestrator.py  4-phase engine with per-subscriber SSE fan-out
  session_export.py       shared Web/CLI JSON and Markdown renderers
  providers.py     env detection, lazy LiteLLM wrapper, Mock provider
  personas.py      persona registry, re-priming prompts, balanced selection
  metrics.py       cloud embeddings / numpy TF-IDF, dedup, dispersion, NDR
  db.py            SQLite (stdlib sqlite3)
  models.py        Pydantic models (frozen API contract)
  personas/mbti_16.json   16 detailed persona definitions
  tests/test_backend.py, tests/test_cli.py
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
4. **Convergence** — embedding dedup (cos ≥ 0.8) is followed by facilitator
   re-synthesis of duplicate clusters with explicit tension axes. The LLM judge
   then pre-ranks Novelty, Feasibility and Clarity. Its agreement with humans is
   only about 50%, so the ranking remains advisory. You adopt, hold or reject
   ideas with memos and export them to Markdown or JSON.

## Known limitations

- One session runs at a time (starting a second returns 409).
- LLM judge scores are advisory triage, not decisions.
- Per-token streaming is live-only; revisiting a finished session replays
  ideas, messages and metrics from the DB, not keystroke-by-keystroke output.
- Per-token replay fidelity of model failures: an agent that errors mid-run is
  skipped and noted in the log rather than retried.
- The TF-IDF dedup fallback is coarser than cloud embeddings; exact
  near-duplicates are caught, paraphrase-level duplicates may survive.

# E2E verification record — Mock provider, real browser (Chromium headless)

Date: 2026-08-04 · Server: `uvicorn backend.main:app` on 127.0.0.1:8787 serving
`frontend/dist` · Browser driven via `agent-browser` CLI.

| # | Checklist item | Result | Evidence |
|---|----------------|--------|----------|
| 1 | Create view: balanced pick → every agent assigned Mock → start | PASS | `01-create.png`, `02-balanced.png` — balanced pick selected ENFJ/ENFP/INTJ/INTP (axis-balanced), all provider selects read `mock`, session started and navigated to `/session/:id` |
| 2 | Live view: stepper progression, per-token streaming, anonymized discussion log, metrics display | PASS | `03-live-streaming.png` (round-1 discussion streaming with caret), `04-live-done.png` (5-phase moon stepper complete, 16 ideas / 12 unique / NDR 0.75 / dispersion 0.28) |
| 3 | Results view: clusters, facilitator synthesis, score badges, adopt/hold/reject + memo, export | PASS | `05-results-top.png` (12 clusters, synthesis callouts, N/F/C badges). Adopt + memo PATCH verified through the API (`decision=adopted`, note persisted). md/json exports downloaded and content-checked |
| 4 | History view lists finished sessions; revisiting replays from the DB correctly | PASS | `06-history.png` (2 sessions with metrics), `07-replay.png` (agent cards show "Completed — per-token replay is not stored", discussion log and all 16 ideas with clusters/scores replayed) |

Environment note: the machine had `ZAI_API_KEY` set, so the server was restarted
with that variable removed to keep the run Mock-only; provider detection
correctly reported every cloud provider unavailable and Mock available.

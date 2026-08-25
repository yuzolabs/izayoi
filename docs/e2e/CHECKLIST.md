# E2E verification record — Mock provider, real browser (Chromium headless)

Date: 2026-08-25 · Mock-only run in real headless Chromium at 1440×900, driven
via `agent-browser`.

- Frontend: built from this GUI worktree (`cd frontend && bun run build`)
- Backend: the CLI worktree (`izayoi.feat-brainstorm-cli`), started with `uvicorn backend.main:app` on 127.0.0.1:8891
- Storage: `IZAYOI_DB_PATH` on a throwaway SQLite file
- Static assets: `IZAYOI_FRONTEND_DIST` pointing at this worktree's `frontend/dist`

| # | Checklist item | Result | Evidence |
|---|----------------|--------|----------|
| 1 | Create view: balanced pick → every agent assigned Mock → start | PASS | `01-create.png` (lunar-spine setup rail with theme/constraints character counters and the council readout's estimated-calls cost line), `02-balanced.png` — balanced pick selected ENFJ/ENFP/INTJ/INTP (axis-balanced), all four agent provider selects plus the facilitator read `Mock (no key required)`, start navigated to `/session/:id` |
| 2 | Live view: 5-phase moon-rail stepper, per-token streaming, anonymized discussion log, metrics display | PASS | `03-live-streaming.png` — round-1 discussion with four agents mid-stream (DOM held 4 `stream-caret`s at capture). `04-live-done.png` — all five phases Framing → Independent divergence → Discussion → Convergence → Sixteenth night completed, metrics 16 ideas / 15 unique / non-duplicate ratio 0.94 / dispersion 0.29 |
| 3 | Results view: clusters, facilitator framing, score badges, adopt/hold/reject + memo, exports, decision index | PASS | `05-results-top.png` (15 clusters, facilitator framing callout, 16 N/F/C score badges, decision index chips All 16 / Pending 15 / Adopted 1 / Held 0 / Rejected 0). Adopt + memo PATCH verified through the API (`decision=adopted`, note persisted) and mirrored by the decision index counter. md/json exports fetched and downloaded; both files content-checked |
| 4 | History archive ledger lists finished sessions; replaying a finished session restores the record from the DB | PASS | `06-history.png` (archive ledger masthead: 2 sessions on record · 2 decided, per-session diversity metrics, Review decisions links), `07-replay.png` (revisited live view — agent cards read "Completed — per-token replay is not stored; see the ideas and log below", while rounds 1–2 of the anonymized discussion log and all 16 confirmed ideas re-upserted from the DB) |

Environment notes:

- every cloud provider env var was unset for the server, so detection reported all cloud providers unavailable and Mock available
- both sessions ran end-to-end on the Mock provider with the deterministic browser-demo theme

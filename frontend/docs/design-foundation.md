# izayoi visual foundation

Shared tokens, classes and constraints for the GUI pieces
(foundation/App shell/Create is piece 1; Live, Results, History follow).

## Concept — a quiet moonlit editing room

Warm paper desk for the work. ONE night element per screen, carrying the
lunar-phase information structure. Everything else stays quiet paper, ink
and brass. No gradients anywhere (product constraint), no new hues.

## Color tokens (`frontend/src/index.css`)

| Token | Value | Use |
| --- | --- | --- |
| `--background` | warm paper | page background |
| `--foreground` | warm ink | text on paper |
| `--primary` | muted brass | actions, accents, focus ring |
| `--night` | `hsl(240 18% 15%)` | night panels (lunar spine, mobile bars) — the ONLY dark surface |
| `--moonlight` | `hsl(46 35% 88%)` | text + lit moons on night |
| `--night-muted` | `hsl(240 12% 64%)` | secondary text on night |
| `--caution` | amber | cost warnings on paper |
| `--caution-night` | `hsl(43 92% 67%)` | cost warnings on night |
| `--success` | green | ready/adopted states |

Tailwind names: `night`, `night-foreground` (moonlight), `night-muted`,
`caution-night` — e.g. `bg-night text-night-foreground`.

Group colors (analysts/diplomats/sentinels/explorers) are fixed by the
product spec — never restyle them.

## Type roles

- **Fraunces Variable** (`font-display`): page + section titles only.
- **IBM Plex Sans** (`font-sans`): body, labels, descriptions.
- **IBM Plex Mono** (`font-mono`): instrument readout — persona codes,
  counts, model names, `~calls` estimates, phase labels.

## Reusable pieces

- `components/moon.tsx` → `MoonIcon({ illumination, waning, shadeClassName })`
  maps progress to a lunar phase. `shadeClassName` swaps the dark-disc fill
  (default `fill-secondary` on paper; use `fill-night` on night panels).
- `components/lunar-spine.tsx` → `LunarSpine` — steps-as-waxing-moons nav.
  `variant="rail"` (desktop, full-height night column) or `variant="strip"`
  (mobile, horizontal sticky strip). Reusable for the Live screen's four
  phases (framing → divergence → discussion → convergence).
- `components/council-readout.tsx` → `CouncilReadout` — mono session-plan
  summary (personas / ideas / rounds / judge / ~calls + cost warning).
  `variant="rail" | "bar"`. `aria-live="polite"` so cast changes announce.
- `lib/use-active-step-section.ts` → `useActiveStepSection(ids)` —
  IntersectionObserver scroll tracker for `aria-current="step"`.

## Constraints for later pieces

1. One night element per screen; never fill large content areas with night.
2. Keep `bg-card`/`border` paper surfaces for content; night is chrome only.
3. Focus ring is brass on paper; on night use `focus-visible:ring-white/80`.
4. Reduced motion: add any new animation to the disable list in `index.css`.
5. Sticky/fixed bars must add matching padding to `<main>` content and use
   `env(safe-area-inset-bottom)`; they must never overlay the last control.
6. Copy: plain verbs, sentence case, product voice ("council", "persona",
   "convene"); errors say what happened + how to fix, never apologize.

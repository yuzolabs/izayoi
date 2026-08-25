# Route bundle performance artifacts

`bun run build` is the required production-build entry point. It type-checks
and builds with Vite. It then runs
`scripts/check-route-bundle-performance.mjs`. The bundle budget is therefore
enforced by the same command used by the Docker/CI build rather than by an
optional follow-up command.

Vite writes two inspection inputs under `dist/.vite/`:

- `manifest.json` is Vite's generated route and chunk relationship manifest.
- `route-bundle-modules.json` is a versioned build artifact emitted by the
  local `emit-route-bundle-module-graph` plugin. It records Rollup's module IDs
  for each generated JavaScript chunk because the Vite manifest does not expose
  module-level attribution.

The checker uses the manifest for static and dynamic chunk relationships and
the module graph for source inclusion. It requires Create to remain eager.
Exactly History, Live, and Results must be dynamic route entries. The eager
graph excludes Results-journal modules, Live-only modules, and test modules.
Test-code checks use module IDs rather than text searches over minified bundles,
so ordinary product copy cannot trigger a false positive.

Both files are generated, ignored artifacts. Do not commit or hand-edit them.
A clean `bun run build` replaces `dist`, emits schema-compatible artifacts, and
checks compressed transfer budgets. Remove `dist` after one-off inspection when
no local preview is needed.

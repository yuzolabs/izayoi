import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  assertEntryModuleLayout,
  assertExpectedDynamicRoutes,
  assertFontAssetBudget,
  findForbiddenTestModules,
  findRemoteFontUrls,
  findStaticIbmPlexSansAssets,
} from "./check-route-bundle-performance.mjs";

const EXPECTED_DYNAMIC_ROUTES = [
  "src/views/history.tsx",
  "src/views/session-live.tsx",
  "src/views/session-results.tsx",
];

function createExpectedRouteManifest() {
  return Object.fromEntries([
    [
      "index.html",
      {
        isEntry: true,
        dynamicImports: EXPECTED_DYNAMIC_ROUTES,
      },
    ],
    ...EXPECTED_DYNAMIC_ROUTES.map((routeSource) => [
      routeSource,
      { isDynamicEntry: true },
    ]),
  ]);
}

describe("font payload budget contract", () => {
  test("accepts a variable-font-only payload within file and byte budgets", () => {
    const fontEntries = [
      { fileName: "assets/ibm-plex-sans-latin-wght-normal-abc.woff2", bytes: 45712 },
      { fileName: "assets/fraunces-latin-wght-normal-xyz.woff2", bytes: 64000 },
    ];

    assert.doesNotThrow(() => assertFontAssetBudget(fontEntries));
    assert.deepEqual(findStaticIbmPlexSansAssets(fontEntries.map((e) => e.fileName)), []);
  });

  test("rejects payloads over 45 files or 600 KiB", () => {
    const tooManyFiles = Array.from({ length: 46 }, (_, index) => ({
      fileName: `assets/fraunces-latin-wght-normal-${index}.woff2`,
      bytes: 1024,
    }));
    assert.throws(
      () => assertFontAssetBudget(tooManyFiles),
      /46 font files, over the 45 file budget/
    );

    const tooHeavy = [
      { fileName: "assets/fraunces-latin-wght-normal-x.woff2", bytes: 600 * 1024 + 1 },
    ];
    assert.throws(
      () => assertFontAssetBudget(tooHeavy),
      /over the 614400 B budget/
    );
  });

  test("rejects static IBM Plex Sans weight assets", () => {
    const staticSans = "assets/ibm-plex-sans-latin-400-normal-HASH.woff2";
    assert.deepEqual(findStaticIbmPlexSansAssets([staticSans]), [staticSans]);
    assert.throws(
      () =>
        assertFontAssetBudget([
          { fileName: staticSans, bytes: 12000 },
          { fileName: "assets/ibm-plex-sans-latin-700-normal-HASH.woff2", bytes: 12000 },
        ]),
      /static IBM Plex Sans weights \(use @fontsource-variable\/ibm-plex-sans\)/
    );

    // The variable package's wght-axis name must never match the static pattern.
    assert.deepEqual(
      findStaticIbmPlexSansAssets([
        "assets/ibm-plex-sans-latin-wght-normal-HASH.woff2",
        "assets/ibm-plex-sans-cyrillic-ext-wght-normal-HASH.woff2",
      ]),
      []
    );
  });

  test("flags remote font URLs in generated CSS but allows local asset urls", () => {
    const cssEntries = [
      {
        fileName: "assets/index-abc.css",
        source:
          "@font-face{font-family:X;src:url(/assets/fraunces-latin-wght-normal-x.woff2) format('woff2')}" +
          "@font-face{font-family:Y;src:url('https://fonts.gstatic.com/s/x.woff2') format('woff2')}",
      },
    ];

    assert.deepEqual(findRemoteFontUrls(cssEntries), [
      "assets/index-abc.css: https://fonts.gstatic.com/s/x.woff2",
    ]);
    assert.deepEqual(
      findRemoteFontUrls([
        {
          fileName: "assets/index-ok.css",
          source: "@font-face{src:url(./ibm-plex-sans-latin-wght-normal-x.woff2)}",
        },
      ]),
      []
    );
  });
});

describe("route bundle source graph contract", () => {
  test("accepts eager Create plus exactly three deferred route entries", () => {
    const manifest = createExpectedRouteManifest();

    assert.deepEqual(
      assertExpectedDynamicRoutes(manifest, new Set(["index.html"])),
      [...EXPECTED_DYNAMIC_ROUTES].sort()
    );
    assert.doesNotThrow(() =>
      assertEntryModuleLayout(
        new Set([
          "src/views/create-session.tsx",
          "src/content/testing-library-guide.ts",
          "src/features/happy-domestic-life.ts",
        ])
      )
    );
  });

  test("rejects missing Create, eager lazy routes, Live-only code, and the Results journal", () => {
    assert.throws(
      () => assertEntryModuleLayout(new Set()),
      /entry static graph is missing eager Create route/
    );

    for (const forbiddenModule of [
      "src/views/history.tsx",
      "src/components/agent-card.tsx",
      "src/lib/session-results-mutation-journal.ts",
    ]) {
      assert.throws(
        () =>
          assertEntryModuleLayout(
            new Set(["src/views/create-session.tsx", forbiddenModule])
          ),
        /entry static graph contains/
      );
    }
  });

  test("uses module IDs instead of incidental bundle text for test-code detection", () => {
    const harmlessProductionModules = [
      "src/content/testing-library-guide.ts",
      "src/features/happy-domestic-life.ts",
      "node_modules/example/globalregistrator.js",
    ];
    assert.deepEqual(findForbiddenTestModules(harmlessProductionModules), []);

    const testModules = [
      "src/components/app-shell.test.tsx",
      "src/lib/parser.spec.ts",
      "src/__tests__/route.ts",
      "src/test-support/happy-dom-test-environment.ts",
      "node_modules/@happy-dom/global-registrator/lib/index.js",
      "node_modules/@testing-library/dom/dist/index.js",
      "node_modules/happy-dom/lib/index.js",
      "bun:test",
      "node:test",
    ];
    assert.deepEqual(findForbiddenTestModules(testModules), testModules);
  });

  test("rejects an extra dynamic source or a non-dynamic route facade", () => {
    const extraDynamicManifest = createExpectedRouteManifest();
    extraDynamicManifest["index.html"].dynamicImports = [
      ...EXPECTED_DYNAMIC_ROUTES,
      "src/views/create-session.tsx",
    ];
    assert.throws(
      () =>
        assertExpectedDynamicRoutes(extraDynamicManifest, new Set(["index.html"])),
      /expected exactly three dynamic route imports/
    );

    const eagerHistoryManifest = createExpectedRouteManifest();
    eagerHistoryManifest["src/views/history.tsx"].isDynamicEntry = false;
    assert.throws(
      () =>
        assertExpectedDynamicRoutes(eagerHistoryManifest, new Set(["index.html"])),
      /src\/views\/history\.tsx is not a Vite dynamic entry/
    );
  });
});

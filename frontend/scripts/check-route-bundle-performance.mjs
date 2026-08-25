import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib";

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIRECTORY = resolve(FRONTEND_ROOT, "dist");
const VITE_MANIFEST_FILE = resolve(BUILD_DIRECTORY, ".vite/manifest.json");
const ROUTE_BUNDLE_MODULE_GRAPH_FILE = resolve(
  BUILD_DIRECTORY,
  ".vite/route-bundle-modules.json"
);

const ROUTE_BUNDLE_MODULE_GRAPH_SCHEMA_VERSION = 1;
const REQUIRED_EAGER_ROUTE_SOURCES = ["src/views/create-session.tsx"];
const EXPECTED_DYNAMIC_ROUTE_SOURCES = [
  "src/views/history.tsx",
  "src/views/session-live.tsx",
  "src/views/session-results.tsx",
];

const FORBIDDEN_ENTRY_MODULE_GROUPS = {
  "lazy route views": EXPECTED_DYNAMIC_ROUTE_SOURCES,
  "Results mutation journal": ["src/lib/session-results-mutation-journal.ts"],
  "Live-only implementation": [
    "src/components/agent-card.tsx",
    "src/components/confirmed-ideas-ledger.tsx",
    "src/components/live-masthead.tsx",
    "src/components/live-metrics-readout.tsx",
    "src/components/phase-stepper.tsx",
    "src/lib/session-agent-output.ts",
    "src/lib/session-live-phase.ts",
    "src/lib/use-session-live-follow.ts",
  ],
};

const FORBIDDEN_TEST_MODULE_ID_PATTERNS = [
  /(?:^|\/)[^/]+\.(?:spec|test)\.[^/]+$/,
  /(?:^|\/)__tests__(?:\/|$)/,
  /(?:^|\/)src\/test-support(?:\/|$)/,
  /(?:^|\/)node_modules\/@happy-dom\//,
  /(?:^|\/)node_modules\/@testing-library\//,
  /(?:^|\/)node_modules\/happy-dom\//,
  /^bun:test$/,
  /^node:test$/,
];

/*
 * Calibrated against the 2026-08-24 production build after route splitting:
 * entry static graph 106,218 B gzip / 91,518 B Brotli; all JS 136,968 B /
 * 118,914 B. Route-transfer measurements were History 5,853 B / 5,207 B,
 * Live 12,096 B / 10,754 B, and Results 18,381 B / 16,356 B. Rounded
 * budgets retain roughly 8–22% headroom without allowing the removed route
 * payload back into the eager entry.
 */
const ROUTE_BUNDLE_COMPRESSION_BUDGETS = {
  entryStaticGraph: { gzip: 112 * 1024, brotli: 97 * 1024 },
  allJavaScript: { gzip: 146 * 1024, brotli: 127 * 1024 },
  routeTransfers: {
    "src/views/history.tsx": { gzip: 7 * 1024, brotli: 6 * 1024 },
    "src/views/session-live.tsx": { gzip: 14 * 1024, brotli: 12 * 1024 },
    "src/views/session-results.tsx": { gzip: 21 * 1024, brotli: 19 * 1024 },
  },
};

function failRouteBundleCheck(message) {
  throw new Error(`Route bundle performance check failed: ${message}`);
}

function assertRouteBundleCondition(condition, message) {
  if (!condition) {
    failRouteBundleCheck(message);
  }
}

async function readJsonFile(filePath, purpose) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    failRouteBundleCheck(
      `cannot read ${purpose} at ${filePath}; run the production build first (${String(error)})`
    );
  }
}

function collectStaticManifestKeys(manifest, entryManifestKey) {
  const staticManifestKeys = new Set();

  function visitManifestKey(manifestKey) {
    if (staticManifestKeys.has(manifestKey)) {
      return;
    }

    const manifestChunk = manifest[manifestKey];
    assertRouteBundleCondition(
      manifestChunk !== undefined,
      `manifest import ${JSON.stringify(manifestKey)} is missing`
    );
    staticManifestKeys.add(manifestKey);

    for (const importedManifestKey of manifestChunk.imports ?? []) {
      visitManifestKey(importedManifestKey);
    }
  }

  visitManifestKey(entryManifestKey);
  return staticManifestKeys;
}

function collectStaticChunkFiles(chunkGraph, initialChunkFiles) {
  const staticChunkFiles = new Set();

  function visitChunkFile(chunkFile) {
    if (staticChunkFiles.has(chunkFile)) {
      return;
    }

    const chunk = chunkGraph[chunkFile];
    assertRouteBundleCondition(
      chunk !== undefined,
      `module graph import ${JSON.stringify(chunkFile)} is missing`
    );
    staticChunkFiles.add(chunkFile);

    for (const importedChunkFile of chunk.imports) {
      visitChunkFile(importedChunkFile);
    }
  }

  for (const initialChunkFile of initialChunkFiles) {
    visitChunkFile(initialChunkFile);
  }
  return staticChunkFiles;
}

/** Verifies that only the three deferred route sources are dynamic entries. */
export function assertExpectedDynamicRoutes(manifest, staticManifestKeys) {
  const dynamicRouteSources = new Set();
  for (const manifestKey of staticManifestKeys) {
    for (const dynamicImport of manifest[manifestKey].dynamicImports ?? []) {
      dynamicRouteSources.add(dynamicImport);
    }
  }

  const actualSources = [...dynamicRouteSources].sort();
  const expectedSources = [...EXPECTED_DYNAMIC_ROUTE_SOURCES].sort();
  assertRouteBundleCondition(
    JSON.stringify(actualSources) === JSON.stringify(expectedSources),
    `expected exactly three dynamic route imports ${JSON.stringify(
      expectedSources
    )}, received ${JSON.stringify(actualSources)}`
  );

  for (const routeSource of expectedSources) {
    const routeManifestChunk = manifest[routeSource];
    assertRouteBundleCondition(
      routeManifestChunk?.isDynamicEntry === true,
      `${routeSource} is not a Vite dynamic entry`
    );
  }

  return actualSources;
}

function collectChunkModules(chunkGraph, chunkFiles) {
  const modules = new Set();
  for (const chunkFile of chunkFiles) {
    for (const moduleId of chunkGraph[chunkFile].modules) {
      modules.add(moduleId);
    }
  }
  return modules;
}

/** Returns module IDs that identify test files, test support, or test dependencies. */
export function findForbiddenTestModules(moduleIds) {
  return [...moduleIds].filter((moduleId) =>
    FORBIDDEN_TEST_MODULE_ID_PATTERNS.some((pattern) => pattern.test(moduleId))
  );
}

/** Verifies the eager Create route and all entry-static module exclusions. */
export function assertEntryModuleLayout(entryModules) {
  const missingEagerRoutes = REQUIRED_EAGER_ROUTE_SOURCES.filter(
    (moduleId) => !entryModules.has(moduleId)
  );
  assertRouteBundleCondition(
    missingEagerRoutes.length === 0,
    `entry static graph is missing eager Create route: ${missingEagerRoutes.join(", ")}`
  );

  for (const [groupName, forbiddenModules] of Object.entries(
    FORBIDDEN_ENTRY_MODULE_GROUPS
  )) {
    const includedModules = forbiddenModules.filter((moduleId) =>
      entryModules.has(moduleId)
    );
    assertRouteBundleCondition(
      includedModules.length === 0,
      `entry static graph contains ${groupName}: ${includedModules.join(", ")}`
    );
  }

  const includedTestModules = findForbiddenTestModules(entryModules);
  assertRouteBundleCondition(
    includedTestModules.length === 0,
    `entry static graph contains test modules: ${includedTestModules.join(", ")}`
  );
}

async function assertGeneratedJavaScriptGraphExcludesTestDependencies(chunkGraph) {
  const generatedJavaScriptFiles = (await readdir(resolve(BUILD_DIRECTORY, "assets")))
    .filter((fileName) => fileName.endsWith(".js"))
    .map((fileName) => `assets/${fileName}`)
    .sort();
  const graphedJavaScriptFiles = Object.keys(chunkGraph).sort();

  assertRouteBundleCondition(
    JSON.stringify(generatedJavaScriptFiles) === JSON.stringify(graphedJavaScriptFiles),
    "route module graph does not describe every generated JavaScript bundle"
  );

  const generatedBundleModules = collectChunkModules(
    chunkGraph,
    generatedJavaScriptFiles
  );
  const includedTestModules = findForbiddenTestModules(generatedBundleModules);
  assertRouteBundleCondition(
    includedTestModules.length === 0,
    `generated JavaScript graph contains test modules: ${includedTestModules.join(", ")}`
  );

  return generatedJavaScriptFiles;
}

async function measureCompressedChunkFiles(chunkFiles) {
  const measurements = { raw: 0, gzip: 0, brotli: 0 };

  for (const chunkFile of chunkFiles) {
    const bundleBytes = await readFile(resolve(BUILD_DIRECTORY, chunkFile));
    measurements.raw += bundleBytes.byteLength;
    measurements.gzip += gzipSync(bundleBytes, { level: 9 }).byteLength;
    measurements.brotli += brotliCompressSync(bundleBytes, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      },
    }).byteLength;
  }

  return measurements;
}

function assertCompressionBudget(label, measurement, budget) {
  for (const encoding of ["gzip", "brotli"]) {
    assertRouteBundleCondition(
      measurement[encoding] <= budget[encoding],
      `${label} ${encoding} is ${measurement[encoding]} B, over ${budget[encoding]} B budget`
    );
  }
}

function formatKilobytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/*
 * Typography payload budget — the offline GUI self-hosts every face via
 * Fontsource, so the whole font payload must stay small and local:
 * ≤45 font files, ≤600 KiB total, IBM Plex Sans only through the variable
 * (wght-axis) package, and no remote font URLs that would leak requests.
 */
const FONT_PAYLOAD_BUDGET = {
  maxFontCount: 45,
  maxTotalBytes: 600 * 1024,
};
const FONT_FILE_EXTENSION_PATTERN = /\.woff2?$/i;
/* Static IBM Plex Sans assets use numeric-weight filenames
 * (ibm-plex-sans-latin-400-normal.woff2); the variable package ships
 * wght-axis files (ibm-plex-sans-latin-wght-normal.woff2). */
const STATIC_IBM_PLEX_SANS_ASSET_PATTERN =
  /ibm-plex-sans[^/]*-\d{3,4}-normal(?:-[A-Za-z0-9_-]+)?\.woff2?$/i;
const REMOTE_FONT_URL_PATTERN = /url\(\s*["']?https?:\/\//i;

/** Lists font asset entries ({ fileName, bytes }) from a dist asset directory listing. */
export function findStaticIbmPlexSansAssets(fileNames) {
  return fileNames.filter((fileName) =>
    STATIC_IBM_PLEX_SANS_ASSET_PATTERN.test(fileName)
  );
}

/** Verifies the shipped font payload against count/byte/no-static-Sans budgets. */
export function assertFontAssetBudget(fontEntries) {
  assertRouteBundleCondition(
    fontEntries.length <= FONT_PAYLOAD_BUDGET.maxFontCount,
    `font payload has ${fontEntries.length} font files, over the ${FONT_PAYLOAD_BUDGET.maxFontCount} file budget`
  );

  const totalFontBytes = fontEntries.reduce(
    (sum, entry) => sum + entry.bytes,
    0
  );
  assertRouteBundleCondition(
    totalFontBytes <= FONT_PAYLOAD_BUDGET.maxTotalBytes,
    `font payload is ${totalFontBytes} B, over the ${FONT_PAYLOAD_BUDGET.maxTotalBytes} B budget`
  );

  const staticSansAssets = findStaticIbmPlexSansAssets(
    fontEntries.map((entry) => entry.fileName)
  );
  assertRouteBundleCondition(
    staticSansAssets.length === 0,
    `font payload contains static IBM Plex Sans weights (use @fontsource-variable/ibm-plex-sans): ${staticSansAssets.join(
      ", "
    )}`
  );

  return { fontCount: fontEntries.length, totalFontBytes };
}

/** Returns any generated CSS url() references that point at remote font hosts. */
export function findRemoteFontUrls(cssEntries) {
  const remoteUrls = [];
  for (const { fileName, source } of cssEntries) {
    for (const match of source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      if (REMOTE_FONT_URL_PATTERN.test(match[0])) {
        remoteUrls.push(`${fileName}: ${match[1]}`);
      }
    }
  }
  return remoteUrls;
}

/** Reads the built font payload and CSS, then enforces the font budgets. */
async function checkFontPayloadBudget() {
  const assetFileNames = await readdir(resolve(BUILD_DIRECTORY, "assets"));
  const fontEntries = [];
  for (const fileName of assetFileNames) {
    if (!FONT_FILE_EXTENSION_PATTERN.test(fileName)) {
      continue;
    }
    const bytes = await readFile(
      resolve(BUILD_DIRECTORY, "assets", fileName)
    );
    fontEntries.push({ fileName: `assets/${fileName}`, bytes: bytes.byteLength });
  }
  const fontBudget = assertFontAssetBudget(fontEntries);

  const cssEntries = [];
  for (const fileName of assetFileNames.filter((name) =>
    name.endsWith(".css")
  )) {
    const source = await readFile(
      resolve(BUILD_DIRECTORY, "assets", fileName),
      "utf8"
    );
    cssEntries.push({ fileName: `assets/${fileName}`, source });
  }
  const remoteFontUrls = findRemoteFontUrls(cssEntries);
  assertRouteBundleCondition(
    remoteFontUrls.length === 0,
    `generated CSS references remote font URLs (fonts must be self-hosted): ${remoteFontUrls.join(
      ", "
    )}`
  );

  console.log(
    `Font payload budget check passed: ${fontBudget.fontCount} files, ` +
      `${formatKilobytes(fontBudget.totalFontBytes)} total, no static Sans assets, no remote font URLs.`
  );
}

/** Checks generated route artifacts and enforces source-layout and transfer budgets. */
export async function checkRouteBundlePerformance() {
  const viteManifest = await readJsonFile(VITE_MANIFEST_FILE, "Vite manifest");
  const routeBundleModuleGraph = await readJsonFile(
    ROUTE_BUNDLE_MODULE_GRAPH_FILE,
    "route bundle module graph"
  );
  assertRouteBundleCondition(
    routeBundleModuleGraph.schemaVersion ===
      ROUTE_BUNDLE_MODULE_GRAPH_SCHEMA_VERSION,
    `expected route module graph schema ${ROUTE_BUNDLE_MODULE_GRAPH_SCHEMA_VERSION}, received ${JSON.stringify(
      routeBundleModuleGraph.schemaVersion
    )}`
  );
  const chunkGraph = routeBundleModuleGraph.chunks;
  assertRouteBundleCondition(
    typeof chunkGraph === "object" && chunkGraph !== null,
    "route module graph has no chunks object"
  );

  const entryManifestRecords = Object.entries(viteManifest).filter(
    ([, manifestChunk]) => manifestChunk.isEntry === true
  );
  assertRouteBundleCondition(
    entryManifestRecords.length === 1,
    `expected one Vite entry, received ${entryManifestRecords.length}`
  );
  const [entryManifestKey, entryManifestChunk] = entryManifestRecords[0];
  const staticManifestKeys = collectStaticManifestKeys(
    viteManifest,
    entryManifestKey
  );
  const dynamicRouteSources = assertExpectedDynamicRoutes(
    viteManifest,
    staticManifestKeys
  );

  const entryStaticChunkFiles = collectStaticChunkFiles(chunkGraph, [
    entryManifestChunk.file,
  ]);
  const entryModules = collectChunkModules(chunkGraph, entryStaticChunkFiles);
  assertEntryModuleLayout(entryModules);

  const generatedJavaScriptFiles =
    await assertGeneratedJavaScriptGraphExcludesTestDependencies(chunkGraph);
  const entryMeasurements = await measureCompressedChunkFiles(
    entryStaticChunkFiles
  );
  const allJavaScriptMeasurements = await measureCompressedChunkFiles(
    generatedJavaScriptFiles
  );
  assertCompressionBudget(
    "entry static graph",
    entryMeasurements,
    ROUTE_BUNDLE_COMPRESSION_BUDGETS.entryStaticGraph
  );
  assertCompressionBudget(
    "all JavaScript",
    allJavaScriptMeasurements,
    ROUTE_BUNDLE_COMPRESSION_BUDGETS.allJavaScript
  );

  const routeMeasurementRows = [];
  for (const routeSource of dynamicRouteSources) {
    const routeChunkFiles = collectStaticChunkFiles(chunkGraph, [
      viteManifest[routeSource].file,
    ]);
    for (const entryChunkFile of entryStaticChunkFiles) {
      routeChunkFiles.delete(entryChunkFile);
    }

    const routeMeasurements = await measureCompressedChunkFiles(routeChunkFiles);
    assertCompressionBudget(
      `${routeSource} transfer`,
      routeMeasurements,
      ROUTE_BUNDLE_COMPRESSION_BUDGETS.routeTransfers[routeSource]
    );
    routeMeasurementRows.push({
      route: routeSource,
      chunks: routeChunkFiles.size,
      gzip: formatKilobytes(routeMeasurements.gzip),
      brotli: formatKilobytes(routeMeasurements.brotli),
    });
  }

  console.log("Route bundle performance check passed.");
  console.log(
    `Dynamic route imports (${dynamicRouteSources.length}): ${dynamicRouteSources.join(", ")}`
  );
  console.log(
    `Entry static graph (${entryStaticChunkFiles.size} chunk, ${entryModules.size} modules): ` +
      `${formatKilobytes(entryMeasurements.gzip)} gzip / ` +
      `${formatKilobytes(entryMeasurements.brotli)} Brotli`
  );
  console.log(
    `All JavaScript (${generatedJavaScriptFiles.length} chunks): ` +
      `${formatKilobytes(allJavaScriptMeasurements.gzip)} gzip / ` +
      `${formatKilobytes(allJavaScriptMeasurements.brotli)} Brotli`
  );
  console.table(routeMeasurementRows);
  await checkFontPayloadBudget();
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  await checkRouteBundlePerformance();
}

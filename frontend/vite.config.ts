import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const FRONTEND_ROOT = fileURLToPath(new URL(".", import.meta.url));
const ROUTE_BUNDLE_MODULE_GRAPH_FILE = ".vite/route-bundle-modules.json";
const ROUTE_BUNDLE_MODULE_GRAPH_SCHEMA_VERSION = 1;

function normalizeBundleModuleId(moduleId: string): string {
  const cleanModuleId = moduleId.replaceAll("\0", "").split("?", 1)[0];
  if (!isAbsolute(cleanModuleId)) {
    return cleanModuleId;
  }

  const frontendRelativeId = relative(FRONTEND_ROOT, cleanModuleId)
    .split(sep)
    .join("/");
  return frontendRelativeId.startsWith("../")
    ? cleanModuleId.split(sep).join("/")
    : frontendRelativeId;
}

function emitRouteBundleModuleGraph(): Plugin {
  return {
    name: "emit-route-bundle-module-graph",
    apply: "build",
    generateBundle(_outputOptions, outputBundle) {
      const chunks = Object.fromEntries(
        Object.values(outputBundle)
          .filter((output) => output.type === "chunk")
          .map(
            (chunk) =>
              [
                chunk.fileName,
                {
                  dynamicImports: chunk.dynamicImports,
                  facadeModuleId:
                    chunk.facadeModuleId === null
                      ? null
                      : normalizeBundleModuleId(chunk.facadeModuleId),
                  imports: chunk.imports,
                  isDynamicEntry: chunk.isDynamicEntry,
                  isEntry: chunk.isEntry,
                  modules: Object.keys(chunk.modules)
                    .map(normalizeBundleModuleId)
                    .sort(),
                },
              ] as const
          )
          .sort(([leftFileName], [rightFileName]) =>
            leftFileName.localeCompare(rightFileName)
          )
      );

      this.emitFile({
        type: "asset",
        fileName: ROUTE_BUNDLE_MODULE_GRAPH_FILE,
        source: `${JSON.stringify(
          {
            schemaVersion: ROUTE_BUNDLE_MODULE_GRAPH_SCHEMA_VERSION,
            chunks,
          },
          null,
          2
        )}\n`,
      });
    },
  };
}

/** Builds the offline GUI and emits inspectable route chunk metadata. */
export default defineConfig({
  // P4: base must be "/" so asset URLs resolve on deep SPA routes.
  plugins: [react(), emitRouteBundleModuleGraph()],
  base: "/",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Dev-only proxy to the FastAPI backend (SPEC 8.2 in the source plan).
      "/api": "http://127.0.0.1:8787",
    },
  },
  build: {
    manifest: true,
    outDir: "dist",
    sourcemap: false,
  },
});

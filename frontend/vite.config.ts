import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// P4: base must be "/" so asset URLs resolve on deep SPA routes.
export default defineConfig({
  plugins: [react()],
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
    outDir: "dist",
    sourcemap: false,
  },
});

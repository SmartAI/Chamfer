/// <reference types="vitest/config" />
import path from "node:path";
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

const apiPort = process.env.PORT ? Number(process.env.PORT) : 8787;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: process.env.CLIENT_PORT ? Number(process.env.CLIENT_PORT) : 5173,
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/vitest.setup.ts"],
    // The *.integration.test.ts bench meta-tests run a real multi-minute
    // build123d bench through Pyodide and fetch Pyodide packages from a CDN, so
    // they are too slow and network-dependent for the blocking unit lane. Run
    // them on demand with `npm run test:integration`; their determinism and
    // identity-pinning properties are also exercised by the release bench path.
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
});

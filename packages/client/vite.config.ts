/// <reference types="vitest/config" />
import path from "node:path";
import { defineConfig } from "vite";
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
  test: { environment: "jsdom", setupFiles: ["./src/vitest.setup.ts"] },
});

import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

// This worktree runs its dev stack on non-default ports so it does not
// collide with another checkout's `npm run dev` on the standard 5173/8787.
const CLIENT_PORT = process.env.CLIENT_PORT ?? "5273";
const API_PORT = process.env.PORT ?? "8887";
const FUSION_FAKE_PORT = process.env.FUSION_FAKE_PORT ?? "8997";
const EXTERNAL_FUSION_ENDPOINT = process.env.CHAMFER_FUSION_EVAL_EXTERNAL_ENDPOINT;

export default defineConfig({
  testDir: ".",
  timeout: 600_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: [
    ...(!EXTERNAL_FUSION_ENDPOINT ? [{
      command: "npx tsx e2e/fakeFusionMcp.ts",
      cwd: "..",
      url: `http://127.0.0.1:${FUSION_FAKE_PORT}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    }] : []),
    {
      command: "npm run dev:server",
      cwd: "..",
      env: {
        PORT: API_PORT,
        CHAMFER_FAKE_LLM: process.env.CHAMFER_FAKE_LLM,
        // The server walks up to the repo's .env/.env.local, so a developer's
        // CHAMFER_MODEL would otherwise leak into the scripted stack and trip
        // the Fusion action model-identity gate (recovery specs probe with the
        // fake model identity). A non-empty shell value masks the dotenv one;
        // envSettings then ignores it as unknown, leaving no configured model -
        // the hermetic default the fake stack has always assumed.
        ...(process.env.CHAMFER_FAKE_LLM ? { CHAMFER_MODEL: "chamfer-fake", CHAMFER_PROVIDER: "anthropic" } : {}),
        CHAMFER_DATA_DIR: process.env.CHAMFER_DATA_DIR,
        CHAMFER_EXPERIMENTAL_FUSION: "1",
        CHAMFER_FUSION_MCP_ENDPOINT: EXTERNAL_FUSION_ENDPOINT ?? `http://127.0.0.1:${FUSION_FAKE_PORT}/mcp`,
        CHAMFER_FUSION_INTEGRITY_REPORT: process.env.CHAMFER_FUSION_INTEGRITY_REPORT ?? resolve("e2e/fixtures/fusion-integrity-go.json"),
      },
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "npm run dev:client",
      cwd: "..",
      env: { CLIENT_PORT, PORT: API_PORT },
      url: `http://localhost:${CLIENT_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

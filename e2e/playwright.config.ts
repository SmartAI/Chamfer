import { defineConfig, devices } from "@playwright/test";

// This worktree runs its dev stack on non-default ports so it does not
// collide with another checkout's `npm run dev` on the standard 5173/8787.
const CLIENT_PORT = process.env.CLIENT_PORT ?? "5273";
const API_PORT = process.env.PORT ?? "8887";

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
  webServer: {
    command: "npm run dev",
    cwd: "..",
    env: { CLIENT_PORT, PORT: API_PORT },
    url: `http://localhost:${CLIENT_PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

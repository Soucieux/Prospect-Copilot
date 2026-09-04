import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;

/**
 * End-to-end configuration. The suite builds and serves the production app and
 * intercepts /api/chat in every spec, so no test contacts a model provider
 * or fetches a third-party page.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    // The production build, not `next dev`: the suite then exercises the same
    // bundle that ships, and no dev-only origin guard or HMR socket is in play.
    command: `npm run build && npx next start --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});

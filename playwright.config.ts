import { defineConfig, devices } from "@playwright/test";

// End-to-end suite. Runs against a STAGING deploy (E2E_BASE_URL) where the
// provider calendar write is stubbed (E2E_STUB_CALENDAR=true on that deploy),
// so booking/reschedule/cancel exercise the real UI → API → DB → agent path
// without touching any real calendar or emailing real people. Never point this
// at production. Executed on a GitHub Actions cron (.github/workflows/e2e-staging.yml)
// and locally via `npm run e2e`.
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "on",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

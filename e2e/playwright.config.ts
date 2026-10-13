import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // One worker: files run sequentially, each with its own servers
  // and temp DB. Tests are short, so this stays fast without
  // port/DB races.
  fullyParallel: false,
  workers: 1,
  // No static baseURL: the fixture starts the API + web on random
  // free ports per test file and exposes them as fixtures.
  use: {
    ...devices["Desktop Chrome"],
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 30_000,
  // No webServer: the fixture starts everything itself.
});

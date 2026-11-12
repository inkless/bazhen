import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "scenarios",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "out/test-results",
  use: { baseURL: "http://127.0.0.1:7681", ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
  webServer: { command: "node server.ts", url: "http://127.0.0.1:7681/api/stats", reuseExistingServer: false, gracefulShutdown: { signal: "SIGTERM", timeout: 5000 } },
});

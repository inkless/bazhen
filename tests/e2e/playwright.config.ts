import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const daemonPort = 7921;
const webPort = 5183;
const env = {
  BAZHEN_HOME: mkdtempSync(join(tmpdir(), "bz-e2e-home-")),
  BAZHEN_PORT: String(daemonPort),
  BAZHEN_WEB_PORT: String(webPort),
  BAZHEN_TMUX_SOCKET: `bz-e2e-${process.pid}`,
};

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${webPort}` },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node ../../apps/daemon/src/main.ts",
      port: daemonPort,
      env,
      reuseExistingServer: false,
    },
    {
      command: "pnpm --filter @bazhen/web exec vite",
      url: `http://127.0.0.1:${webPort}`,
      env,
      reuseExistingServer: false,
    },
  ],
});

import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Free ports and a per-run home and tmux server, so parallel worktrees can run e2e at once.
// Playwright re-evaluates this file in its workers; they inherit the values through the
// environment instead of choosing new ones.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

process.env["BZ_E2E_DAEMON_PORT"] ??= String(await freePort());
process.env["BZ_E2E_WEB_PORT"] ??= String(await freePort());
process.env["BZ_E2E_HOME"] ??= mkdtempSync(join(tmpdir(), "bz-e2e-home-"));
process.env["BZ_E2E_SOCKET"] ??= `bz-e2e-${process.pid}`;

const daemonPort = Number(process.env["BZ_E2E_DAEMON_PORT"]);
const webPort = Number(process.env["BZ_E2E_WEB_PORT"]);
const env = {
  BAZHEN_HOME: process.env["BZ_E2E_HOME"],
  BAZHEN_PORT: String(daemonPort),
  BAZHEN_WEB_PORT: String(webPort),
  BAZHEN_TMUX_SOCKET: process.env["BZ_E2E_SOCKET"],
};

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  reporter: "list",
  globalTeardown: "./global-teardown.ts",
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

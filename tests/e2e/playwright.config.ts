import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { agentHomes, loginEnv } from "../support/agent-env.ts";
import { requireDisposableHost } from "../support/disposable-host.ts";
import { storageState } from "./pairing.ts";

requireDisposableHost();

// Free ports and a per-run home and tmux server, so parallel worktrees can run e2e at once.
// Playwright re-evaluates this file in its workers; they inherit the values through the
// environment instead of choosing new ones.

function listen(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// Every listener stays open until all ports are known, so the OS can't hand out one port twice.
async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(Array.from({ length: count }, listen));
  const ports = servers.map((server) => {
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no port");
    return address.port;
  });
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  return ports;
}

if (!process.env["BZ_E2E_DAEMON_PORT"] || !process.env["BZ_E2E_WEB_PORT"]) {
  const [daemon, web] = await freePorts(2);
  process.env["BZ_E2E_DAEMON_PORT"] ??= String(daemon);
  process.env["BZ_E2E_WEB_PORT"] ??= String(web);
}
process.env["BZ_E2E_HOME"] ??= mkdtempSync(join(tmpdir(), "bz-e2e-home-"));
// The daemon and teardown name their server by path. Any other tmux command of the run, an agent's
// say, lands in a socket directory of its own, outside any tmux client. Short, under /tmp, for
// sun_path's limit; the config is loaded more than once per run, and keeps the first one.
process.env["BZ_E2E_TMUX_TMPDIR"] ||= mkdtempSync("/tmp/bz-tmux-");
process.env["TMUX_TMPDIR"] = process.env["BZ_E2E_TMUX_TMPDIR"];
delete process.env["TMUX"];
delete process.env["TMUX_PANE"];
// Where the page launches agents: the real Claude Code, pinned in this package, started with no
// prompt and no way to reach a model.
const work = join(process.env["BZ_E2E_HOME"], "work");
mkdirSync(work, { recursive: true });
process.env["BZ_E2E_WORK"] = realpathSync(work);
const claudeBin = fileURLToPath(new URL("node_modules/.bin", import.meta.url));

const daemonPort = Number(process.env["BZ_E2E_DAEMON_PORT"]);
const webPort = Number(process.env["BZ_E2E_WEB_PORT"]);
const env: Record<string, string> = {
  ...loginEnv(),
  BAZHEN_HOME: process.env["BZ_E2E_HOME"],
  BAZHEN_PORT: String(daemonPort),
  BAZHEN_WEB_PORT: String(webPort),
  // With no external origin, "auto" asks no browser to pair; the suite pairs, as a phone would.
  BAZHEN_PAIRING: "always",
  PATH: `${claudeBin}:${process.env["PATH"] ?? ""}`,
  ...agentHomes(process.env["BZ_E2E_HOME"], process.env["BZ_E2E_WORK"]),
};

/**
 * Playwright starts its web servers with its own whole environment merged in, so each command
 * runs under `env -i` with exactly `env`: no real model credential or provider switch reaches the
 * daemon or the agents it launches.
 */
const clean = (command: string) =>
  `env -i ${Object.entries(env)
    .map(([k, v]) => `${k}='${v.replaceAll("'", "'\\''")}'`)
    .join(" ")} ${command}`;

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  reporter: "list",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  use: { baseURL: `http://127.0.0.1:${webPort}`, storageState: storageState() },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: clean("node ../../apps/daemon/src/main.ts"),
      port: daemonPort,
      reuseExistingServer: false,
    },
    {
      command: clean("pnpm --filter @bazhen/web exec vite"),
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
    },
  ],
});

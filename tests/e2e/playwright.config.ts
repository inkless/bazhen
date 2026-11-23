import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { agentHomes, loginEnv } from "../support/agent-env.ts";
import { programsOnPath } from "../support/programs.ts";
import { requireDisposableHost } from "../support/disposable-host.ts";
import { testDaemonBin } from "../support/test-daemon.ts";
import {
  e2eDaemons,
  portVariable,
  RUNTIME_AGNOSTIC_SPECS,
  RUNTIMES,
  runRoot,
  webOrigin,
  type E2eDaemon,
} from "./daemons.ts";
import type { DaemonOptions } from "./page.ts";
import { storageState } from "./pairing.ts";

requireDisposableHost();

// Free ports and a per-run directory, so parallel worktrees can run e2e at once. Playwright
// re-evaluates this file in its workers; they inherit the values through the environment
// instead of choosing new ones.

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

const unchosen = RUNTIMES.flatMap((runtime) => [
  portVariable(runtime, "DAEMON"),
  portVariable(runtime, "WEB"),
]).filter((name) => !process.env[name]);
if (unchosen.length > 0) {
  const ports = await freePorts(unchosen.length);
  unchosen.forEach((name, i) => (process.env[name] = String(ports[i])));
}
process.env["BZ_E2E_ROOT"] ??= mkdtempSync(join(tmpdir(), "bz-e2e-"));
// The daemons and teardown name their servers by path. Any other tmux command of the run, an
// agent's say, lands in a socket directory of its own, outside any tmux client. Short, under /tmp,
// for sun_path's limit; the config is loaded more than once per run, and keeps the first one.
process.env["BZ_E2E_TMUX_TMPDIR"] ||= mkdtempSync("/tmp/bz-tmux-");
process.env["TMUX_TMPDIR"] = process.env["BZ_E2E_TMUX_TMPDIR"];
delete process.env["TMUX"];
delete process.env["TMUX_PANE"];
// Where the page launches agents: the real Claude Code, pinned in this package, started with no
// prompt and no way to reach a model. Both daemons launch them here, one project after the other.
const work = join(runRoot(), "work");
mkdirSync(work, { recursive: true });
process.env["BZ_E2E_WORK"] = realpathSync(work);
const claudeBin = fileURLToPath(new URL("node_modules/.bin", import.meta.url));

/**
 * What one daemon and its dev proxy run with. Its config names its runtime, so neither daemon
 * depends on which one is the default.
 */
function daemonEnv({ runtime, home, daemonPort, webPort }: E2eDaemon): Record<string, string> {
  // Private: tmux's guard refuses a socket under a home other users can open.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "config.toml"), `[runtime]\ndefault = "${runtime}"\n`);
  return {
    ...loginEnv(),
    BAZHEN_HOME: home,
    BAZHEN_PORT: String(daemonPort),
    BAZHEN_WEB_PORT: String(webPort),
    // With no external origin, "auto" asks no browser to pair; the suite pairs, as a phone would.
    BAZHEN_PAIRING: "always",
    // A `claude` that runs a program a spec queued as the next agent, or else Claude Code.
    PATH: `${programsOnPath(home, join(claudeBin, "claude"))}:${claudeBin}:${process.env["PATH"] ?? ""}`,
    ...agentHomes(home, String(process.env["BZ_E2E_WORK"])),
  };
}

/**
 * Playwright starts its web servers with its own whole environment merged in, so each command
 * runs under `env -i` with exactly `env`: no real model credential or provider switch reaches the
 * daemon or the agents it launches.
 */
const clean = (env: Record<string, string>, command: string) =>
  `env -i ${Object.entries(env)
    .map(([k, v]) => `${k}='${v.replaceAll("'", "'\\''")}'`)
    .join(" ")} ${command}`;

/**
 * The daemon each web server runs: `BAZHEN_TEST_DAEMON_BIN`, the Rust daemon's binary, while both
 * daemons are built, else the TypeScript one. The selector goes at the cutover.
 */
const daemonBin = testDaemonBin();
const daemonCommand =
  daemonBin === undefined
    ? "node ../../apps/daemon/src/main.ts"
    : `'${daemonBin.replaceAll("'", "'\\''")}'`;

// Playwright matches each name anywhere under the test directory, so a misspelt one would match
// nothing and drop its spec from the holder project without a word.
const missing = RUNTIME_AGNOSTIC_SPECS.filter(
  (spec) => !existsSync(new URL(spec, import.meta.url)),
);
if (missing.length > 0)
  throw new Error(`RUNTIME_AGNOSTIC_SPECS names no such spec: ${missing.join(", ")}`);

const daemons = e2eDaemons();

export default defineConfig<object, DaemonOptions>({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  // Ends a hung run, setup and teardown included, with a report, 5 minutes inside the CI job's cap.
  globalTimeout: 15 * 60_000,
  // `list` streams each test as it starts and ends; the report and traces are what CI uploads.
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  // Each project is named for its runtime, which is how a spec finds its daemon.
  projects: daemons.map((daemon) => ({
    name: daemon.runtime,
    // A *.holder.spec.ts reads what only a holder's view shows: its bytes, as the program wrote them.
    ...(daemon.runtime === "tmux"
      ? { testIgnore: "*.holder.spec.ts" }
      : { testMatch: [...RUNTIME_AGNOSTIC_SPECS, "*.holder.spec.ts"] }),
    use: {
      ...devices["Desktop Chrome"],
      trace: "retain-on-failure",
      screenshot: "only-on-failure",
      baseURL: webOrigin(daemon),
      storageState: storageState(daemon.home),
      home: daemon.home,
    },
  })),
  webServer: daemons.flatMap((daemon) => {
    const env = daemonEnv(daemon);
    return [
      {
        command: clean(env, daemonCommand),
        port: daemon.daemonPort,
        reuseExistingServer: false,
      },
      {
        // The web package's dev script, which runs vite with V8's fast API calls off: on Node 26 a
        // multi-MB module's response can abort vite in Buffer.byteLength (nodejs/node#66870). The
        // flag goes once the Node pin carries the fix, nodejs/node#67136.
        command: clean(env, "moon run web:dev"),
        url: webOrigin(daemon),
        reuseExistingServer: false,
      },
    ];
  }),
});

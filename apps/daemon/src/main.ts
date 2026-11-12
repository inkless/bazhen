import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { filterEnv } from "@bazhen/core";
import { LocalEnvironment } from "@bazhen/env-local";
import { ClaudeCodeHarness } from "@bazhen/harness-claude-code";
import { TmuxRuntime } from "@bazhen/runtime-tmux";
import { launchAgent, localEnvironmentId } from "./agents/launch.ts";
import { TerminalHub } from "./stream/hub.ts";
import { endOpenAttachments, storeLog } from "./stream/log.ts";
import { streamUpgrades } from "./stream/server.ts";
import { currentInputs, resolvePaths } from "./config/paths.ts";
import { ensurePrivateDir } from "./config/private-dir.ts";
import { createApp } from "./http/app.ts";
import { nodePtySpawner } from "./pty/node-pty.ts";
import { Store } from "./store/store.ts";

const APP_VERSION = "0.1.0";
const HOSTNAME = "127.0.0.1";
const port = Number(process.env.BAZHEN_PORT ?? 7900);
const DEFAULT_SIZE = { cols: 120, rows: 40 };

const inputs = currentInputs();
const paths = resolvePaths(inputs);
for (const dir of [paths.config, paths.data, paths.bank, paths.state, paths.cache])
  mkdirSync(dir, { recursive: true });
ensurePrivateDir(paths.run, inputs.uid);

// Captured once: agents get what a new terminal tab would, minus Bazhen's and the launching
// session's internals (foundation-design §9.5).
const hostEnv = filterEnv(process.env).env;
const store = Store.open(join(paths.data, "bazhen.db"));
endOpenAttachments(store);
const runtime = new TmuxRuntime({
  socket: paths.tmuxSocket,
  pty: nodePtySpawner,
  configFile: join(paths.run, "tmux.conf"),
  env: hostEnv,
});
const environment = new LocalEnvironment({
  id: localEnvironmentId(store),
  runtime,
  harnesses: [new ClaudeCodeHarness(randomUUID)],
  socket: paths.socket,
});
const allowedHosts = [`${HOSTNAME}:${port}`, `localhost:${port}`];
// The web dev server proxies to the daemon, and the browser's requests keep its origin. It is
// allowed only when the dev scripts name its port; a built daemon serves the client itself.
const webPort = process.env.BAZHEN_WEB_PORT;
const webDevHosts = webPort ? [`${HOSTNAME}:${webPort}`, `localhost:${webPort}`] : [];
const allow = {
  hosts: allowedHosts,
  origins: [...allowedHosts, ...webDevHosts].map((host) => `http://${host}`),
};
const app = createApp({
  appVersion: APP_VERSION,
  schemaVersion: () => store.schemaVersion(),
  runtime,
  allow,
  state: () => store.snapshot(),
  launch: (req) => launchAgent({ store, environment, size: DEFAULT_SIZE }, req),
});

const hub = new TerminalHub(runtime, storeLog(store));
const server = serve({ fetch: app.fetch, hostname: HOSTNAME, port }, (info) => {
  console.log(`bazhen daemon listening on http://${HOSTNAME}:${info.port} (data: ${paths.data})`);
});
server.on("upgrade", streamUpgrades({ allow, hub, runtimeRef: (id) => store.runtimeRef(id) }));

function shutdown() {
  server.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

import { mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { filterEnv } from "@bazhen/core";
import { TmuxRuntime } from "@bazhen/runtime-tmux";
import { currentPaths } from "./config/paths.ts";
import { ensurePrivateDir } from "./config/private-dir.ts";
import { createApp } from "./http/app.ts";
import { nodePtySpawner } from "./pty/node-pty.ts";
import { Store } from "./store/store.ts";

const APP_VERSION = "0.1.0";
const HOSTNAME = "127.0.0.1";
const port = Number(process.env.BAZHEN_PORT ?? 7900);

const paths = currentPaths();
for (const dir of [paths.config, paths.data, paths.bank, paths.state, paths.cache])
  mkdirSync(dir, { recursive: true });
ensurePrivateDir(paths.run, userInfo().uid);

// Captured once: agents get what a new terminal tab would, minus Bazhen's and the launching
// session's internals (foundation-design §9.5).
const hostEnv = filterEnv(process.env).env;
const store = Store.open(join(paths.data, "bazhen.db"));
const runtime = new TmuxRuntime({
  socket: paths.tmuxSocket,
  pty: nodePtySpawner,
  configFile: join(paths.run, "tmux.conf"),
  env: hostEnv,
});
const app = createApp({
  appVersion: APP_VERSION,
  schemaVersion: () => store.schemaVersion(),
  runtime,
  allowedHosts: [`${HOSTNAME}:${port}`, `localhost:${port}`],
});

const server = serve({ fetch: app.fetch, hostname: HOSTNAME, port }, (info) => {
  console.log(`bazhen daemon listening on http://${HOSTNAME}:${info.port} (data: ${paths.data})`);
});

function shutdown() {
  server.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { TmuxRuntime } from "@bazhen/runtime-tmux";
import { currentPaths } from "./config/paths.ts";
import { createApp } from "./http/app.ts";
import { nodePtySpawner } from "./pty/node-pty.ts";
import { Store } from "./store/store.ts";

const APP_VERSION = "0.1.0";
const HOSTNAME = "127.0.0.1";
const port = Number(process.env.BAZHEN_PORT ?? 7900);

const paths = currentPaths();
for (const dir of [paths.config, paths.data, paths.bank, paths.state, paths.cache])
  mkdirSync(dir, { recursive: true });
mkdirSync(paths.run, { recursive: true, mode: 0o700 });

const store = Store.open(join(paths.data, "bazhen.db"));
const runtime = new TmuxRuntime({
  socket: process.env.BAZHEN_TMUX_SOCKET ?? "bazhen",
  pty: nodePtySpawner,
  configFile: join(paths.run, "tmux.conf"),
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

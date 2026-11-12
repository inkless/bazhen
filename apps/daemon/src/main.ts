import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestListener, serve } from "@hono/node-server";
import { filterEnv } from "@bazhen/core";
import { LocalEnvironment } from "@bazhen/env-local";
import { ClaudeCodeHarness } from "@bazhen/harness-claude-code";
import { TmuxRuntime } from "@bazhen/runtime-tmux";
import { launchAgent, localEnvironmentId } from "./agents/launch.ts";
import { TerminalHub } from "./stream/hub.ts";
import { endOpenAttachments, storeLog } from "./stream/log.ts";
import { streamUpgrades } from "./stream/server.ts";
import { Approvals } from "./mailbox/approvals.ts";
import { hookCommand } from "./mailbox/hook-command.ts";
import { hookApp } from "./mailbox/ingress.ts";
import { Mailbox } from "./mailbox/mailbox.ts";
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
const mailbox = new Mailbox(store);
const approvals = new Approvals(store);
endOpenAttachments(store);
const runtime = new TmuxRuntime({
  socket: paths.tmuxSocket,
  pty: nodePtySpawner,
  configFile: join(paths.run, "tmux.conf"),
  env: hostEnv,
});
const hookClient = fileURLToPath(new URL("mailbox/hook-client.ts", import.meta.url));
const environment = new LocalEnvironment({
  id: localEnvironmentId(store),
  runtime,
  harnesses: [
    new ClaudeCodeHarness({
      newSessionId: randomUUID,
      hookCommand: hookCommand(process.execPath, hookClient),
      // A mode every agent starts in, overriding the user's settings; unset by default.
      ...(process.env.BAZHEN_CLAUDE_PERMISSION_MODE
        ? { permissionMode: process.env.BAZHEN_CLAUDE_PERMISSION_MODE }
        : {}),
    }),
  ],
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
  send: (agentId, req) => mailbox.send(agentId, req),
  answer: (attentionId, req) => approvals.answer(attentionId, req),
});

const hub = new TerminalHub(runtime, storeLog(store));
const server = serve({ fetch: app.fetch, hostname: HOSTNAME, port }, (info) => {
  console.log(`bazhen daemon listening on http://${HOSTNAME}:${info.port} (data: ${paths.data})`);
});
server.on("upgrade", streamUpgrades({ allow, hub, runtimeRef: (id) => store.runtimeRef(id) }));

// Hook ingress: the 0600 socket in the private runtime directory, whose permission is the
// authentication. A waiter holds its request for hours, so requests have no time limit.
const hookListener = getRequestListener(
  hookApp({
    mailbox,
    approvals,
    knows: (agentId) => store.agent(agentId) !== undefined,
  }).fetch,
);
const hooks = createServer((req, res) => void hookListener(req, res));
hooks.requestTimeout = 0;
rmSync(paths.socket, { force: true });
hooks.listen(paths.socket, () => chmodSync(paths.socket, 0o600));

function shutdown() {
  server.close();
  hooks.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

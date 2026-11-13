import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { hostname } from "node:os";
import { getRequestListener, serve } from "@hono/node-server";
import { LocalEnvironment } from "@bazhen/env-local";
import { ClaudeCodeHarness } from "@bazhen/harness-claude-code";
import { CodexHarness, DAEMON_START_ARGS } from "@bazhen/harness-codex";
import { filterEnv } from "@bazhen/core";
import { TmuxServer } from "@bazhen/host-guard";
import { PROTOCOL_VERSION } from "@bazhen/protocol";
import { TmuxRuntime } from "@bazhen/runtime-tmux";
import { launchAgent, localEnvironmentId } from "./agents/launch.ts";
import { Lifecycle } from "./agents/lifecycle.ts";
import { reconcile } from "./agents/reconcile.ts";
import { codexApprovals } from "./codex/approvals.ts";
import {
  allOf,
  appServerAddress,
  CodexChannel,
  codexCli,
  codexCliVersion,
  codexHomeOf,
} from "./codex/channel.ts";
import { CodexMail } from "./codex/mail.ts";
import { recordCodexVersion } from "./codex/version.ts";
import { retire } from "./events/retention.ts";
import { eventRoute } from "./events/server.ts";
import { TerminalHub } from "./stream/hub.ts";
import { endOpenAttachments, storeLog } from "./stream/log.ts";
import { streamRoute } from "./stream/server.ts";
import { Approvals } from "./mailbox/approvals.ts";
import { HOOK_SCRIPT, hookClient, hookCommand } from "./mailbox/hook-command.ts";
import { hookApp } from "./mailbox/ingress.ts";
import { Mailbox } from "./mailbox/mailbox.ts";
import { InvalidConfig, loadSettings } from "./config/config.ts";
import { capture } from "./env/capture.ts";
import { answers } from "./socket/client.ts";
import { currentInputs } from "./config/paths.ts";
import { ensurePrivateDir } from "./config/private-dir.ts";
import { createApp, type AppDeps } from "./http/app.ts";
import { upgrades } from "./http/upgrades.ts";
import { socketApp } from "./socket/routes.ts";
import { nodePtySpawner } from "./pty/node-pty.ts";
import { Store, type SnapshotView } from "./store/store.ts";

const APP_VERSION = "0.1.0";
const HOSTNAME = "127.0.0.1";
const DEFAULT_SIZE = { cols: 120, rows: 40 };

const inputs = currentInputs();
const { paths, config, configFile } = settingsOrExit();
const { port } = config;
for (const dir of [paths.config, paths.data, paths.bank, paths.state, paths.cache])
  mkdirSync(dir, { recursive: true });
ensurePrivateDir(paths.run, inputs.uid);
// Its socket is about to be replaced; a daemon still answering on it would be orphaned, with its
// store and tmux server shared. (A lock that also covers two starts racing comes later.)
if (await answers(paths.socket)) {
  console.error(`bazhen is already running on ${paths.socket}`);
  process.exit(1);
}
// Captured once: agents get what a new terminal tab would, minus Bazhen's and the launching
// session's internals (foundation-design §9.5).
let captured = { ...capture(process.env, config.envRules), source: "start" as "start" | "refresh" };
const hostEnv = captured.env;
const store = Store.open(join(paths.data, "bazhen.db"));
const codexHome = codexHomeOf(hostEnv, inputs.home);
// The Codex CLI, in the environment the agents get, which names their Codex home.
const codexCommand = codexCli(hostEnv);
// Read ahead of doctor, which waits on it, and again for each refreshed environment.
let codexCliRead = codexCliVersion(hostEnv);
const codexMail = new CodexMail({
  store,
  remote: appServerAddress(codexHome),
  codex: codexCommand,
});
const mailbox = new Mailbox(store, { codex: (id, agentId) => void codexMail.deliver(id, agentId) });
const approvals = new Approvals(store);
// What the daemon was holding when it last stopped is gone with its sockets (§7 step 2).
endOpenAttachments(store);
mailbox.requeueInFlight();
approvals.closeAbandoned();
const runtime = new TmuxRuntime({
  server: TmuxServer.at(paths.tmuxSocket, {
    root: paths.run,
    config: join(paths.run, "tmux.conf"),
  }),
  pty: nodePtySpawner,
  env: hostEnv,
});
const hookRunner = hookClient();
if (hookRunner === HOOK_SCRIPT) console.warn(`bazhen-hook is not built; hooks use ${HOOK_SCRIPT}`);
const localId = localEnvironmentId(store);
// Agents use the user's own Codex home and its managed app-server, connected on first use.
const codex = new CodexChannel({
  codexHome,
  startDaemon: () => codexCommand(DAEMON_START_ARGS),
  boundThreads: () => store.codexThreads(),
  listener: allOf(
    codexApprovals(approvals, (threadId) => store.codexAgent(threadId)),
    codexMail.listener,
  ),
  connectedTo: (version) => recordCodexVersion(store, localId, version),
});
const environment = new LocalEnvironment({
  id: localId,
  runtime,
  harnesses: [
    new ClaudeCodeHarness({
      newSessionId: randomUUID,
      hookCommand: hookCommand(hookRunner),
      // A mode every agent starts in, overriding the user's settings; unset by default.
      ...(process.env.BAZHEN_CLAUDE_PERMISSION_MODE
        ? { permissionMode: process.env.BAZHEN_CLAUDE_PERMISSION_MODE }
        : {}),
    }),
    new CodexHarness(codex, codex.address),
  ],
  socket: paths.socket,
  ...(config.loginShell === undefined ? {} : { loginShell: config.loginShell }),
});
await reconcile(store, environment);
// The Codex agents' threads lost their subscriber with the last daemon (§7 step 4).
codex.keepConnected();
const lifecycle = new Lifecycle(store, environment);
lifecycle.watch();
const allowedHosts = [`${HOSTNAME}:${port}`, `localhost:${port}`];
// The web dev server proxies to the daemon, and the browser's requests keep its origin. It is
// allowed only when the dev scripts name its port; a built daemon serves the client itself.
const webPort = process.env.BAZHEN_WEB_PORT;
const webDevHosts = webPort ? [`${HOSTNAME}:${webPort}`, `localhost:${webPort}`] : [];
const allow = {
  hosts: allowedHosts,
  origins: [...allowedHosts, ...webDevHosts].map((host) => `http://${host}`),
};
const snapshotView: SnapshotView = {
  host: (kind) => (kind === "local" ? hostname() : ""),
  attachCommand: (ref) => runtime.attachCommand(ref),
  resumable: environment.resumable,
};
const commands = {
  appVersion: APP_VERSION,
  schemaVersion: () => store.schemaVersion(),
  runtime,
  state: () => store.snapshot(snapshotView),
  launch: (req) => launchAgent({ store, environment, size: DEFAULT_SIZE, home: inputs.home }, req),
  send: (agentId, req) => mailbox.send(agentId, req),
  answer: (attentionId, req) => approvals.answer(attentionId, req),
  close: (agentId, req) => lifecycle.close(agentId, req),
  respawn: (agentId, req) => lifecycle.respawn(agentId, req),
  signal: (agentId, req) => lifecycle.signal(agentId, req),
} satisfies Omit<AppDeps, "allow">;
const app = createApp({ ...commands, allow });

const hub = new TerminalHub(runtime, storeLog(store));
const server = serve({ fetch: app.fetch, hostname: HOSTNAME, port }, (info) => {
  console.log(`bazhen daemon listening on http://${HOSTNAME}:${info.port} (data: ${paths.data})`);
});
server.on(
  "upgrade",
  upgrades(allow, [
    streamRoute({ hub, runtimeRef: (id) => store.runtimeRef(id) }),
    eventRoute(store),
  ]),
);

const RETIRE_EVERY_MS = 60 * 60 * 1000;
const shuttingDown = new AbortController();
const retireOld = () =>
  retire(store, new Date(), shuttingDown.signal).catch((err: unknown) =>
    console.error("event retention failed", err),
  );
void retireOld();
const retention = setInterval(() => void retireOld(), RETIRE_EVERY_MS);

// The CLI's commands and hook ingress (socketApp). A waiter holds its request for hours, so
// requests have no time limit.
const socketListener = getRequestListener(
  socketApp({
    commands: createApp({ ...commands, allow: null }),
    hooks: hookApp({
      mailbox,
      approvals,
      knows: (agentId) => store.agent(agentId) !== undefined,
    }),
    stop: shutdown,
    refreshEnv: async (env) => {
      const next = filterEnv(env, config.envRules);
      const { refused } = await runtime.replaceEnv(next.env);
      captured = { ...next, at: new Date().toISOString(), source: "refresh" };
      codexCliRead = codexCliVersion(next.env);
      const running = store.snapshot(snapshotView).agents.filter((a) => a.state === "running");
      return {
        capturedAt: captured.at,
        kept: Object.keys(next.env).length,
        removed: next.removed,
        refused,
        unchanged: running.map((a) => a.id),
      };
    },
    doctor: async () => {
      const runtimeHealth = await runtime.health();
      return {
        appVersion: APP_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        runtime: { state: runtimeHealth.state, version: runtimeHealth.version },
        hookClient: { path: hookRunner, fallback: hookRunner === HOOK_SCRIPT },
        config: configFile,
        agents: {
          shell: config.loginShell === undefined ? "direct" : "login",
          loginShell: config.loginShell ?? null,
        },
        codex: { daemon: codex.version, cli: await codexCliRead },
        env: {
          capturedAt: captured.at,
          source: captured.source,
          kept: Object.keys(captured.env).length,
          removed: captured.removed,
        },
      };
    },
  }).fetch,
);
const socketServer = createServer((req, res) => void socketListener(req, res));
socketServer.requestTimeout = 0;
rmSync(paths.socket, { force: true });
socketServer.listen(paths.socket, () => chmodSync(paths.socket, 0o600));

function shutdown() {
  shuttingDown.abort();
  clearInterval(retention);
  server.close();
  socketServer.close();
  codex.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/** A config error ends start-up with its message, which names the file and the key. */
function settingsOrExit(): ReturnType<typeof loadSettings> {
  try {
    return loadSettings(inputs);
  } catch (err) {
    if (!(err instanceof InvalidConfig)) throw err;
    console.error(err.message);
    return process.exit(1);
  }
}

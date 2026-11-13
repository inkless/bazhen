import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { hostname } from "node:os";
import { getRequestListener, serve } from "@hono/node-server";
import { LocalEnvironment } from "@bazhen/env-local";
import { ClaudeCodeHarness } from "@bazhen/harness-claude-code";
import { CodexHarness, DAEMON_START_ARGS } from "@bazhen/harness-codex";
import { filterEnv } from "@bazhen/core";
import { TmuxServer, findNotifySend } from "@bazhen/host-guard";
import { PROTOCOL_VERSION } from "@bazhen/protocol";
import { TmuxRuntime } from "@bazhen/runtime-tmux";
import { launchAgent, localEnvironmentId } from "./agents/launch.ts";
import { Lifecycle } from "./agents/lifecycle.ts";
import { AgentQueue } from "./agents/queue.ts";
import { reconcile } from "./agents/reconcile.ts";
import { ServerWatch } from "./agents/server-watch.ts";
import { statusLineChoice } from "./agents/status-line.ts";
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
import { codexSignals } from "./codex/signals.ts";
import { CodexThreads, paneTitleCommand } from "./codex/threads.ts";
import { retire } from "./events/retention.ts";
import { eventRoute } from "./events/server.ts";
import { TerminalHub } from "./stream/hub.ts";
import { endOpenAttachments, storeLog } from "./stream/log.ts";
import { ShellLifecycle } from "./shells/lifecycle.ts";
import { reconcileShells } from "./shells/reconcile.ts";
import { ForegroundWatch } from "./shells/foreground.ts";
import { streamRoute } from "./stream/server.ts";
import { Approvals } from "./mailbox/approvals.ts";
import { Inbox } from "./attention/inbox.ts";
import { MAC_APP, desktopNotifier, hostNotifier, notifyOnAttention } from "./notify/desktop.ts";
import { Presence } from "./notify/presence.ts";
import { HOOK_SCRIPT, hookClient, hookCommand } from "./mailbox/hook-command.ts";
import { ActivityTracker } from "./mailbox/activity.ts";
import { SessionBinding, psTable } from "./mailbox/binding.ts";
import { hookApp } from "./mailbox/ingress.ts";
import { Mailbox } from "./mailbox/mailbox.ts";
import { InvalidConfig, loadSettings } from "./config/config.ts";
import { capture } from "./env/capture.ts";
import { answers } from "./socket/client.ts";
import { currentInputs } from "./config/paths.ts";
import { ensurePrivateDir } from "./config/private-dir.ts";
import { createApp, type AppDeps, type TaskCommands } from "./http/app.ts";
import { allowlists } from "./http/guard.ts";
import { upgrades } from "./http/upgrades.ts";
import { DeviceAuth } from "./auth/devices.ts";
import { PairingCodes } from "./auth/pairing.ts";
import { socketApp } from "./socket/routes.ts";
import { Tasks } from "./tasks/tasks.ts";
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
  // A TUI about to show another thread: its mail waits for the move.
  held: (agentId) => codexThreads.held(agentId),
});
const mailbox = new Mailbox(store, { codex: (id, agentId) => void codexMail.deliver(id, agentId) });
const approvals = new Approvals(store);
const inbox = new Inbox(store, approvals, (agentId, req) => mailbox.send(agentId, req));
inbox.follow();
const taskService = new Tasks(store, mailbox, (raised) => inbox.raise(raised), {
  launch: (req, launchedBy) =>
    launchAgent(
      { store, environment, size: DEFAULT_SIZE, home: inputs.home, queue },
      req,
      launchedBy,
    ),
  ...config.launchLimits,
});
taskService.watch();
const tasks: TaskCommands = {
  create: (caller, req) => taskService.create(caller, req),
  show: (taskId) => store.taskDetail(taskId),
  assign: (caller, taskId, req) => taskService.assign(caller, taskId, req),
  unassign: (caller, taskId, req) => taskService.unassign(caller, taskId, req),
  finish: (caller, taskId, req) => taskService.finish(caller, taskId, req),
  delegate: async (caller, req) => taskService.launchAndDelegate(caller, req),
  escalate: (caller, req) => taskService.escalate(caller, req),
};
const presence = new Presence();
// Found once, at start: a notifier installed or built later is picked up by a restart.
const notifiers = {
  notifySend: findNotifySend(),
  macApp: existsSync(MAC_APP) ? MAC_APP : null,
};
const show = config.desktopNotifications ? hostNotifier(process.platform, notifiers, port) : null;
const desktop = show === null ? null : desktopNotifier(show);
if (desktop !== null) notifyOnAttention(store, presence, desktop);
// What the daemon was holding when it last stopped is gone with its sockets (§7 step 2).
endOpenAttachments(store);
mailbox.requeueInFlight();
approvals.closeAbandoned();
const hookRunner = hookClient();
if (hookRunner === HOOK_SCRIPT) console.warn(`bazhen-hook is not built; hooks use ${HOOK_SCRIPT}`);
const runtime = new TmuxRuntime({
  server: TmuxServer.at(paths.tmuxSocket, {
    root: paths.run,
    config: join(paths.run, "tmux.conf"),
  }),
  pty: nodePtySpawner,
  env: hostEnv,
  // Codex TUIs title their panes with their thread; the script client has no pane-title command.
  ...(hookRunner === HOOK_SCRIPT
    ? {}
    : { onPaneTitle: paneTitleCommand(hookRunner, paths.socket) }),
});
// Follows Codex TUIs from thread to thread, by their panes' titles (§5.8).
const codexThreads = new CodexThreads({
  store,
  runtime,
  channel: {
    request: (method, params) => codex.request(method, params),
    resume: (threadId) => codex.resume(threadId),
  },
  released: (agentId) => codexMail.deliverQueued(agentId),
});
const localId = localEnvironmentId(store);
// Agents use the user's own Codex home and its managed app-server, connected on first use.
const codex = new CodexChannel({
  codexHome,
  startDaemon: () => codexCommand(DAEMON_START_ARGS),
  boundThreads: () => store.codexThreads(),
  listener: allOf(
    codexApprovals(
      approvals,
      (threadId) => store.codexAgent(threadId),
      (agentId) => store.codexThread(agentId) !== undefined,
    ),
    codexMail.listener,
    codexSignals({
      agentOf: (threadId) => store.codexAgent(threadId),
      record: (agentId, activity) => void store.recordActivity(agentId, activity),
      resume: (threadId) => codex.resume(threadId),
      turns: {
        started: (agentId) => inbox.turnStarted(agentId),
        failed: (agentId, error) => inbox.turnFailed(agentId, error),
      },
    }),
    codexThreads.listener,
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
      exists: existsSync,
      statusLine: (cwd) =>
        statusLineChoice(cwd, hostEnv["CLAUDE_CONFIG_DIR"] ?? join(inputs.home, ".claude")),
      // A mode every agent starts in, overriding the user's settings; unset by default.
      ...(process.env.BAZHEN_CLAUDE_PERMISSION_MODE
        ? { permissionMode: process.env.BAZHEN_CLAUDE_PERMISSION_MODE }
        : {}),
    }),
    new CodexHarness(codex, codex.address),
  ],
  socket: paths.socket,
  ...(config.loginShell === undefined ? {} : { loginShell: config.loginShell }),
  // The shell a new terminal tab would run; a relative or missing SHELL falls back to /bin/sh.
  ...(hostEnv.SHELL?.startsWith("/") === true && { shell: hostEnv.SHELL }),
});
await reconcile(store, environment);
// What a Claude Code agent was doing went with the last daemon's memory (foundation-design §4.6).
const activity = new ActivityTracker((agentId, a) => store.recordActivity(agentId, a));
const queue = new AgentQueue();
const shells = new ShellLifecycle({
  store,
  environment,
  queue,
  size: DEFAULT_SIZE,
  home: inputs.home,
});
await reconcileShells(store, environment, shells);
await shells.settleOrphans();
const foreground = new ForegroundWatch({ store, environment });
// A title that changed while the daemon was down, or a move it was waiting on, is read again;
// until it has been, those agents' mail waits, so none goes to a thread the TUI has left.
codexThreads.followAll();
// The Codex agents' threads lost their subscriber with the last daemon (§7 step 4).
codex.keepConnected();
const lifecycle = new Lifecycle(store, environment, queue, {
  size: DEFAULT_SIZE,
  replaced: (agentId) => {
    mailbox.sessionStarted(agentId);
    activity.replaced(agentId);
    approvals.supersede(agentId);
  },
});
lifecycle.watch();
const serverWatch = new ServerWatch({
  store,
  environment,
  queue,
  alsoEachTick: async () => {
    await shells.settleOrphans();
    await foreground.refresh();
  },
});
serverWatch.start();
shells.watch();
const allow = allowlists({
  port,
  webPort: process.env.BAZHEN_WEB_PORT || undefined,
  externalOrigins: config.externalOrigins,
});
if (config.externalOriginsFrom !== null) {
  console.log(
    `bazhen: admitting external origins from ${config.externalOriginsFrom}: ` +
      config.externalOrigins.join(", "),
  );
}
console.log(
  config.pairingRequired
    ? `bazhen: pairing required on every origin (web.pairing = "${config.pairing}")`
    : 'bazhen: pairing not required on loopback (web.pairing = "auto", no external origins); ' +
        "a request forwarded from another machine must still pair",
);
const pairing = new PairingCodes();
const devices = new DeviceAuth(store);
// Pairing as configured, and for any request a proxy forwarded from another machine regardless.
const gate = { devices, always: config.pairingRequired };
const snapshotView: SnapshotView = {
  host: (kind) => (kind === "local" ? hostname() : ""),
  attachCommand: (ref) => runtime.attachCommand(ref),
  resumes: environment.resumes,
  themes: (harness) => environment.themes[harness] ?? [],
  attentionActions: (item) => inbox.actions(item),
};
for (const a of store.snapshot(snapshotView).agents) {
  if (a.harness === "claude-code" && a.state === "running") activity.restarted(a.id);
}
const commands = {
  appVersion: APP_VERSION,
  schemaVersion: () => store.schemaVersion(),
  runtime,
  state: () => store.snapshot(snapshotView),
  launch: (req) =>
    launchAgent({ store, environment, size: DEFAULT_SIZE, home: inputs.home, queue }, req),
  send: (agentId, req) => mailbox.send(agentId, req),
  answer: (attentionId, req) => approvals.answer(attentionId, req),
  reply: (attentionId, req) => inbox.reply(attentionId, req),
  dismiss: (attentionId, req) => inbox.dismiss(attentionId, req),
  resend: (attentionId, req) => inbox.resend(attentionId, req),
  close: (agentId, req) => shells.closeAgent(agentId, req, (r) => lifecycle.close(agentId, r)),
  respawn: (agentId, req) => lifecycle.respawn(agentId, req),
  relaunch: (agentId, req) => lifecycle.relaunch(agentId, req),
  signal: (agentId, req) => lifecycle.signal(agentId, req),
  openShell: (req) => shells.open(req),
  closeShell: (terminalId, req) => shells.close(terminalId, req),
  restartShell: (terminalId, req) => shells.restart(terminalId, req),
  renameShell: (terminalId, req) => shells.rename(terminalId, req),
  unlinkShell: (terminalId, req) => shells.unlink(terminalId, req),
  tasks,
} satisfies Omit<AppDeps, "allow">;
const app = createApp({
  ...commands,
  allow,
  pairing: { codes: pairing, devices },
  gate,
});

const attachments = storeLog(store);
const hub = new TerminalHub(runtime, {
  ...attachments,
  // A view that opens a shell sees what runs in it now, not as of the last tick (§4.8).
  started: (attachment, terminalId, mode) => {
    attachments.started(attachment, terminalId, mode);
    if (store.shell(terminalId) !== undefined) void foreground.refresh();
  },
});
const server = serve({ fetch: app.fetch, hostname: HOSTNAME, port }, (info) => {
  console.log(`bazhen daemon listening on http://${HOSTNAME}:${info.port} (data: ${paths.data})`);
});
server.on(
  "upgrade",
  upgrades(
    allow,
    [streamRoute({ hub, runtimeRef: (id) => store.runtimeRef(id) }), eventRoute(store, presence)],
    gate,
  ),
);

const RETIRE_EVERY_MS = 60 * 60 * 1000;
const shuttingDown = new AbortController();
const retireOld = () =>
  retire(store, new Date(), shuttingDown.signal).catch((err: unknown) =>
    console.error("event retention failed", err),
  );
void retireOld();
const retention = setInterval(() => void retireOld(), RETIRE_EVERY_MS);
// A device that lapses while it watches loses its views within a minute, as a revoked one does
// at once.
const SWEEP_DEVICES_EVERY_MS = 60 * 1000;
const deviceSweep = setInterval(() => devices.sweep(), SWEEP_DEVICES_EVERY_MS);

// The CLI's commands and hook ingress (socketApp). A waiter holds its request for hours, so
// requests have no time limit.
const socketListener = getRequestListener(
  socketApp({
    commands: createApp({ ...commands, allow: null }),
    hooks: hookApp({
      mailbox,
      approvals,
      turns: {
        started: (agentId) => inbox.turnStarted(agentId),
        failed: (agentId, error) => inbox.turnFailed(agentId, error),
      },
      knows: (agentId) => store.agent(agentId) !== undefined,
      binding: new SessionBinding(store, psTable),
      activity,
      recordUsage: (agentId, usage) => store.recordUsage(agentId, usage),
    }),
    stop: shutdown,
    pairing,
    devices,
    externalOrigins: config.externalOrigins,
    paneTitleChanged: (pane) => void codexThreads.paneTitleChanged(pane),
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
        web: {
          externalOrigins: [...config.externalOrigins],
          from: config.externalOriginsFrom,
          allowInsecureOrigins: config.allowInsecureOrigins,
          pairing: { mode: config.pairing, required: config.pairingRequired },
        },
        notifications: {
          desktop: desktop !== null,
          notifier: process.platform === "darwin" ? notifiers.macApp : notifiers.notifySend,
        },
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
  clearInterval(deviceSweep);
  serverWatch.stop();
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

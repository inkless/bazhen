// Runs the daemon as a separate process and reaches it only as a client would: over HTTP,
// WebSocket and tmux. Nothing here imports the daemon's code, so the same tests can certify a
// daemon written in another language.

import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { hostname } from "node:os";
import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { GENERATION_OPTION, signalOwnChild, signalPane, TmuxServer } from "@bazhen/host-guard";
import {
  encodeHolderRequest,
  HOLDER_PROTOCOL_VERSION,
  holderReplyDecoder,
  type HolderReply,
  type HolderRequest,
} from "@bazhen/protocol";
import {
  EventFrame,
  ExternalRef,
  type HolderSignal,
  LaunchAgentResponse,
  StreamServerFrame,
  PairingCodeResponse,
  ShellCommandResponse,
  StateSnapshot,
  TerminalScreen,
} from "@bazhen/protocol/web";
import { protocolId } from "@bazhen/protocol/id";
import { agentHomes, codexDaemonStarted, loginEnv } from "../support/agent-env.ts";
import { closeHolderAt, closeHoldersUnder, leftBehind } from "../support/holder-close.ts";
import { giveTranscript } from "../support/transcript.ts";
import { LogTail } from "../support/log-tail.ts";
import {
  programShell,
  programsOnPath,
  runAsNextAgent,
  runAsNextShell,
} from "../support/programs.ts";
import { replay } from "./fixtures/browser.ts";
import { testDaemonBin } from "../support/test-daemon.ts";

const run = promisify(execFile);

/** What each harness's TUI shows once it has started. */
export const BANNER = { "claude-code": "Claude Code", codex: "OpenAI Codex" } as const;

/** How much of each agent's debug log `explanation` shows: its hook lines, and its last lines. */
const EXPLAINED_HOOK_LINES = 200;
/** How much of the daemon's log is kept: a soak's one daemon may write for days. */
const LOG_KEPT = 4 * 1024 * 1024;
const EXPLAINED_TAIL_LINES = 60;

/** The size the daemon gives every agent's terminal. */
const SIZE = { cols: 120, rows: 40 };

const repo = fileURLToPath(new URL("../..", import.meta.url));
const bin = fileURLToPath(new URL("node_modules/.bin", import.meta.url));
/** A stand-in login shell for `agents.shell = "login"`. */
export const LOGIN_SHELL = fileURLToPath(new URL("fixtures/login-shell.sh", import.meta.url));

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

let programs = 0;

/**
 * An agent, by its id, or a terminal, by an object naming it, as `program` and `shellProgram`
 * answer one.
 */
export type ScreenOf = string | { readonly terminalId: string };

/** The shell a login session's `$SHELL` names, as the daemon would run it: `/bin/sh` if none. */
const loginShell = () => {
  const shell = loginEnv()["SHELL"];
  return shell?.startsWith("/") === true ? shell : "/bin/sh";
};

/** One HTTP request over a daemon's Unix socket, as the CLI and the hook client make them. */
export function overSocket(
  socket: string,
  method: "GET" | "POST",
  path: string,
  init: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        method,
        path,
        headers: { "content-type": "application/json", ...init.headers },
      },
      (res) => {
        let text = "";
        res.on("data", (d: Buffer) => (text += d.toString()));
        // A body that isn't JSON, as a daemon's plain 404, comes back as its text, for the test to
        // judge, rather than throwing where nothing awaits it.
        res.on("end", () => {
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end(init.body === undefined ? undefined : JSON.stringify(init.body));
  });
}

/**
 * One GET over a daemon's socket from under a `codex app-server`, by a child of its own, as Codex
 * runs a tool call, presenting nothing. The server is a shell named `codex`; its `exit` keeps it
 * from exec'ing the child in its place.
 */
export function overSocketUnderCodex(socket: string, path: string): unknown {
  return underCodex({ socketPath: socket, path });
}

/** `overSocketUnderCodex`, over the daemon's loopback HTTP at `url`, to the host it serves. */
export function overHttpUnderCodex(url: string, path: string): unknown {
  const served = new URL(url);
  return underCodex({ host: served.hostname, port: Number(served.port), path });
}

function underCodex(to: Record<string, string | number>): unknown {
  const ask = `import { request } from "node:http";
const req = request({ ...${JSON.stringify(to)}, method: "GET" }, (res) => {
  let text = "";
  res.on("data", (d) => (text += d));
  res.on("end", () => console.log(JSON.stringify({ status: res.statusCode, body: JSON.parse(text) })));
});
req.end();
`;
  const asked = spawnSync(
    "/bin/sh",
    ["-c", '"$BZ_NODE" --input-type=module -e "$BZ_ASK"; exit $?', "app-server"],
    {
      argv0: "codex",
      env: { ...process.env, BZ_NODE: process.execPath, BZ_ASK: ask },
      encoding: "utf8",
    },
  );
  if (asked.status !== 0) throw new Error(`the fake codex app-server failed: ${asked.stderr}`);
  const reply: unknown = JSON.parse(asked.stdout);
  return reply;
}

/** This checkout's CLI, which `make test-api` builds. */
const CLI = join(repo, "target/release/bazhen");

/** How a process exited: its code, or the signal that ended it. */
export interface ExitStatus {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Runs `bazhen <args>` with `env`, and resolves with how it exited and what it printed. */
export function bazhen(
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(CLI, args, { env, timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({ code: err === null ? 0 : Number(err.code ?? 1), out: stdout + stderr }),
    );
  });
}

/** `bazhen events follow` against `daemon`, left running: what it printed, and how it ended. */
export function followEvents(daemon: Daemon) {
  const child = spawn(CLI, ["events", "follow"], { env: daemon.env });
  let printed = "";
  child.stdout.on("data", (chunk: Buffer) => (printed += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (printed += chunk.toString("utf8")));
  const exited = new Promise<ExitStatus>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return { child, printed: () => printed, exited };
}

/**
 * A directory under `home` holding a `bazhen` that runs this checkout's CLI, so an agent finds
 * the command by name, as it would where Bazhen is installed.
 */
function cliOnPath(home: string): string {
  const dir = join(home, "cli");
  mkdirSync(dir, { recursive: true });
  rmSync(join(dir, "bazhen"), { force: true });
  symlinkSync(CLI, join(dir, "bazhen"));
  return dir;
}

/** A directory under `home` holding a `tmux` that runs nothing, and records each command line. */
function absentTmux(home: string): string {
  const dir = join(home, "no-tmux");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ran"), "");
  writeFileSync(join(dir, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${dir}/ran'\nexit 127\n`);
  chmodSync(join(dir, "tmux"), 0o755);
  return dir;
}

/**
 * The Rust daemon's binary, when the run names one: `BAZHEN_TEST_DAEMON_BIN` swaps it in for the
 * TypeScript daemon everywhere a test starts one, while both are built. It goes at the cutover.
 */
const daemonBin = testDaemonBin();

/** The command that runs the daemon under test in the foreground: its program, then its args. */
function daemonCommand(): [string, ...string[]] {
  return daemonBin === undefined
    ? [process.execPath, join(repo, "apps/daemon/src/main.ts")]
    : [daemonBin];
}

/**
 * A daemon's environment on `home`: the login session's, and nothing of the test run's but the
 * daemon to run, which `bazhen start` reads too.
 */
export function homeEnv(home: string): Record<string, string> {
  return {
    ...loginEnv(),
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    BAZHEN_HOME: home,
    ...(daemonBin !== undefined && { BAZHEN_TEST_DAEMON_BIN: daemonBin }),
  };
}

/**
 * A fresh home and port for the CLI to start a daemon of its own in, and the cleanup that ends
 * whatever it started there.
 */
export async function cliHome() {
  const home = realpathSync(mkdtempSync("/tmp/bz-cli-"));
  const env = { ...homeEnv(home), BAZHEN_PORT: String(await freePort()) };
  const cleanup = async () => {
    await bazhen(["stop"], env);
    TmuxServer.at(join(home, "run", "tmux.sock"), { root: home }).killServer();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { env, cleanup };
}

/** Waits for a condition outside a test, where `expect.poll` can't run. */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 20_000,
) {
  for (const start = Date.now(); Date.now() - start < timeoutMs;) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A shell Bazhen can integrate with, by the name of its snippet. */
export type IntegratedShell = "zsh" | "bash" | "fish";

/**
 * Whether the integration types a line back into `kind` as installed here: into every zsh and bash,
 * and into fish 3.7 and 4.0 only, as `apps/daemon/src/shells/integration/fish` checks.
 */
export function typesBack(kind: IntegratedShell): boolean {
  if (kind !== "fish") return true;
  fishVersion ??= spawnSync("fish", ["--version"], { encoding: "utf8" }).stdout ?? "";
  return /^fish, version (3\.7|4\.0)\./.test(fishVersion);
}
let fishVersion: string | undefined;

/**
 * A `$SHELL` that starts `kind` with an rc file holding only `rcLine`, in a directory of its own
 * that `cleanup` removes: these tests keep the real HOME, and its rc files with it. Given a
 * function, the rc is what it makes of the path `mark` creates, so a shell started after `mark`
 * can be told from one started before.
 */
export function shellWithRc(kind: IntegratedShell, rcLine: string | ((marked: string) => string)) {
  const dir = mkdtempSync("/tmp/bz-rc-");
  const marked = join(dir, "marked");
  const rc = join(dir, kind === "zsh" ? ".zshrc" : `${kind}rc`);
  writeFileSync(rc, `${typeof rcLine === "string" ? rcLine : rcLine(marked)}\n`);
  // As bash's --rcfile does, zsh skips the host's global rc files, which can stop a shell to ask
  // something first: a CI runner's runs compinit, which asks about insecure directories and takes
  // the first keys typed as the answer.
  if (kind === "zsh") writeFileSync(join(dir, ".zshenv"), "unsetopt GLOBAL_RCS\n");
  const start: Record<IntegratedShell, string> = {
    zsh: `ZDOTDIR='${dir}' exec zsh -i`,
    bash: `exec bash --rcfile '${rc}' -i`,
    fish: `exec fish -i -C "source '${rc}'"`,
  };
  const shell = join(dir, `${kind}-shell`);
  writeFileSync(shell, `#!/bin/sh\n${start[kind]}\n`);
  chmodSync(shell, 0o755);
  return {
    shell,
    mark: () => writeFileSync(marked, ""),
    unmark: () => rmSync(marked, { force: true }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface DaemonOptions {
  /** The fake Anthropic API's base URL, for Claude Code. */
  readonly modelUrl?: string;
  /** The fake Responses API's base URL, for Codex. */
  readonly responsesUrl?: string;
  /** More of the daemon's environment, such as a setting's variable. */
  readonly env?: Record<string, string>;
  /** The daemon's config.toml. */
  readonly config?: string;
  /**
   * The runtime it makes new terminals on, written into its config.toml as `runtime.default`:
   * unset, the daemon's own default. The helpers that read tmux refuse unless this is tmux.
   */
  readonly runtime?: RuntimeKind;
  /**
   * Whether each Claude Code agent writes its debug log, for `explained` to show. Off unless asked
   * for, since a TUI in debug mode says so on its screen.
   */
  readonly claudeDebugLog?: boolean;
  /**
   * Puts a `tmux` first on its PATH that fails as a missing one would and records every command
   * it was given, for `tmuxRan`, as on a machine without tmux.
   */
  readonly withoutTmux?: boolean;
}

export type RuntimeKind = "tmux" | "holder";

/**
 * Whether a socket is still bound at `path`, from /proc (Linux only): a holder that unlinked its
 * socket's file but still runs keeps it bound, so a terminal it holds isn't ended.
 */
function listeningAt(path: string): boolean {
  return readFileSync("/proc/net/unix", "utf8")
    .split("\n")
    .some((line) => line.endsWith(` ${path}`));
}

/** A process's environment, from /proc (Linux only). */
function processEnv(pid: number): Record<string, string> {
  const environ = readFileSync(`/proc/${pid}/environ`, "utf8");
  return Object.fromEntries(
    environ
      .split("\0")
      .filter((entry) => entry.includes("="))
      .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
  );
}

export class Daemon {
  readonly home: string;
  readonly work: string;
  readonly #tmuxServer: TmuxServer;
  #runtime: RuntimeKind | undefined;
  #config = "";
  /** What the daemon runs with; the CLI reaches this daemon with it too. */
  readonly env: Record<string, string>;
  /** The `$SHELL` that runs what `shellProgram` queues. */
  readonly #programShell: string;
  private port = 0;
  private process: ChildProcess | undefined;
  #exited: Promise<ExitStatus> | undefined;
  #log = new LogTail(LOG_KEPT);

  private constructor(home: string, opts: DaemonOptions) {
    this.home = home;
    this.work = join(home, "work");
    this.#tmuxServer = TmuxServer.at(join(home, "run", "tmux.sock"), { root: home });
    this.#runtime = opts.runtime;
    mkdirSync(this.work, { recursive: true });
    if (opts.config !== undefined || opts.runtime !== undefined)
      this.writeConfig(opts.config ?? "");

    const first = [
      cliOnPath(home),
      programsOnPath(home, join(bin, "claude")),
      ...(opts.withoutTmux === true ? [absentTmux(home)] : []),
    ];
    this.#programShell = programShell(home, loginShell());
    this.env = {
      ...homeEnv(home),
      SHELL: this.#programShell,
      PATH: `${first.join(":")}:${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      ...agentHomes(home, this.work, { anthropic: opts.modelUrl, responses: opts.responsesUrl }),
      ...(opts.claudeDebugLog === true && { DEBUG: "1" }),
      ...opts.env,
    };
  }

  /** A daemon on a fresh home. Short paths keep its socket under sun_path's limit. */
  static async start(opts: DaemonOptions = {}): Promise<Daemon> {
    const daemon = new Daemon(realpathSync(mkdtempSync("/tmp/bz-api-")), opts);
    await daemon.spawn();
    return daemon;
  }

  /**
   * Two daemons on one fresh home, started at once from their entry point, each on a port of its
   * own, so that they share only the home. Their config.toml is a FIFO until both have opened it,
   * so both read it, and go on to start up, at the same moment, before either can bind; then it is
   * gone again. Linux only, as the api suite is: it sees what each has open in `/proc/<pid>/fd`.
   * Resolves once one of them has exited, with how it exited and what it printed, and the other
   * once it answers. `exited` is null if both still run after `withinMs`; `both` are to be stopped
   * either way.
   */
  static async startTwoAtOnce(withinMs = 20_000): Promise<{
    exited: (ExitStatus & { readonly out: string }) | null;
    serving: Daemon;
    both: readonly [Daemon, Daemon];
  }> {
    const home = realpathSync(mkdtempSync("/tmp/bz-api-"));
    const both = [new Daemon(home, {}), new Daemon(home, {})] as const;
    const config = join(home, "config", "config.toml");
    mkdirSync(join(home, "config"), { recursive: true });
    const made = spawnSync("mkfifo", ["-m", "600", config]);
    if (made.status !== 0) throw new Error(`mkfifo ${config}: ${made.stderr.toString()}`);
    // Open for writing too, so each daemon's open of it doesn't wait, and its read waits for this.
    const gate = openSync(config, constants.O_RDWR);
    try {
      await Promise.all(both.map((d) => d.launchProcess()));
      await waitUntil(
        () => both.every((d) => d.holdsOpen(config)),
        "both to open their config",
        withinMs,
      );
    } finally {
      closeSync(gate);
    }
    rmSync(config);
    const first = await Promise.race([
      ...both.map((d) => d.exited.then((status) => ({ d, status }))),
      new Promise<null>((r) => setTimeout(() => r(null), withinMs)),
    ]);
    if (first === null) return { exited: null, serving: both[0], both };
    const serving = first.d === both[0] ? both[1] : both[0];
    await serving.answering();
    return { exited: { ...first.status, out: first.d.#log.text() }, serving, both };
  }

  /**
   * A daemon started as a user starts it: `bazhen start`, from a shell whose environment adds
   * `env`, with `config` as its config.toml. `stop` ends it with `bazhen stop`.
   */
  static async startWithCli(
    config: string,
    env: Record<string, string>,
    runtime?: RuntimeKind,
  ): Promise<Daemon> {
    const daemon = new Daemon(realpathSync(mkdtempSync("/tmp/bz-api-")), {
      config,
      ...(runtime !== undefined && { runtime }),
    });
    daemon.port = await freePort();
    Object.assign(daemon.env, { BAZHEN_PORT: String(daemon.port) });
    const started = await bazhen(["start"], { ...daemon.env, ...env });
    if (started.code !== 0) {
      await daemon.stop();
      throw new Error(`bazhen start failed:\n${started.out}`);
    }
    return daemon;
  }

  /** Each command line a daemon started `withoutTmux` gave tmux, in order. */
  tmuxRan(): string[] {
    return readFileSync(join(this.home, "no-tmux", "ran"), "utf8")
      .split("\n")
      .filter(Boolean);
  }

  /** Writes a role file of the user's, which the daemon reads at its next use of the roles. */
  writeRole(key: string, text: string): void {
    mkdirSync(join(this.home, "config", "roles"), { recursive: true });
    writeFileSync(join(this.home, "config", "roles", `${key}.md`), text);
  }

  /**
   * Replaces its config.toml, which the daemon reads when it next starts. The runtime it was
   * given stays in it, as a table after `toml`, so `toml`'s top-level keys stay top-level.
   */
  writeConfig(toml: string): void {
    this.#config = toml;
    const runtime =
      this.#runtime === undefined ? "" : `\n[runtime]\ndefault = "${this.#runtime}"\n`;
    mkdirSync(join(this.home, "config"), { recursive: true });
    writeFileSync(join(this.home, "config", "config.toml"), toml + runtime);
  }

  /** Makes new terminals on `runtime` from its next start, keeping the rest of its config. */
  useRuntime(runtime: RuntimeKind): void {
    this.#runtime = runtime;
    this.writeConfig(this.#config);
  }

  /** The daemon's private tmux server, `<home>/run/tmux.sock`, for a test of tmux terminals. */
  get tmuxServer(): TmuxServer {
    if (this.#runtime !== "tmux") {
      throw new Error(
        `this daemon makes its terminals on ${this.#runtime ?? "its default runtime"}, and a ` +
          `helper that reads tmux would find none there: start it with runtime: "tmux"`,
      );
    }
    return this.#tmuxServer;
  }

  /**
   * The line the daemon keeps for a shell to type back, read from its database: no client is
   * shown it, so a test that the right line was kept can only look there.
   */
  keptShellLine(terminalId: string): string | null {
    const row = this.#read((db) =>
      db.prepare("SELECT last_command FROM terminals WHERE id = ?").get(terminalId),
    );
    return typeof row?.last_command === "string" ? row.last_command : null;
  }

  /** What the daemon has printed since it last started. */
  log(): string {
    return this.#log.text();
  }

  /**
   * Runs `work`, and when it throws, as a wait that times out does, prints what would explain it
   * first: the daemon's log, and each Claude Code agent's debug log, if `claudeDebugLog` was on.
   */
  async explained<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      // Whatever goes wrong in explaining it, the failure itself is what the test reports.
      try {
        console.error(this.explanation());
      } catch (unexplained) {
        console.error(`couldn't explain the failure: ${String(unexplained)}`);
      }
      throw err;
    }
  }

  /**
   * The daemon's log, then from each Claude Code agent's debug log the hooks it ran and its last
   * lines. A hook missing from the debug log never ran; for one there that the daemon didn't act
   * on, the daemon's log says why it dropped it.
   */
  explanation(): string {
    const parts = [`---- the daemon's log\n${this.#log.text()}`];
    const debug = join(this.home, "claude", "debug");
    for (const [agentId, session] of this.claudeSessions()) {
      const file = join(debug, `${session}.txt`);
      if (!existsSync(file)) {
        parts.push(`---- agent ${agentId} (session ${session}) wrote no debug log`);
        continue;
      }
      const lines = readFileSync(file, "utf8").split("\n");
      const hooks = lines.filter((l) => /hook/i.test(l)).slice(-EXPLAINED_HOOK_LINES);
      parts.push(
        `---- agent ${agentId} (session ${session}), the hooks in its debug log\n${hooks.join("\n")}`,
        `---- agent ${agentId}, the end of its debug log\n${lines.slice(-EXPLAINED_TAIL_LINES).join("\n")}`,
      );
    }
    return parts.join("\n");
  }

  /** Each Claude Code agent's id and the session it is bound to, as the daemon recorded them. */
  private claudeSessions(): [string, string][] {
    return this.#read((db) =>
      db
        .prepare(`SELECT id, external_ref FROM agent_sessions WHERE external_ref IS NOT NULL`)
        .all()
        .flatMap((row): [string, string][] => {
          const ref = ExternalRef.parse(JSON.parse(String(row.external_ref)));
          return ref.kind === "claude-session" ? [[String(row.id), ref.id]] : [];
        }),
    );
  }

  /**
   * What the transcript the agent's Claude Code hooks last named holds, as the daemon recorded
   * the path: nothing while there is no path or no file.
   */
  transcript(agentId: string): string {
    const path = this.transcriptPath(agentId);
    return path === null || !existsSync(path) ? "" : readFileSync(path, "utf8");
  }

  /** Replaces what the agent's recorded transcript holds, as Claude Code would write it. */
  rewriteTranscript(agentId: string, text: string): void {
    const path = this.transcriptPath(agentId);
    if (path === null) throw new Error(`no transcript recorded for ${agentId}`);
    writeFileSync(path, text);
  }

  private transcriptPath(agentId: string): string | null {
    const row = this.#read((db) =>
      db.prepare(`SELECT transcript FROM agent_sessions WHERE id = ?`).get(agentId),
    );
    return typeof row?.transcript === "string" ? row.transcript : null;
  }

  /** A new directory beside the work directory, which no harness has been told to trust. */
  untrustedDirectory(name: string): string {
    const dir = join(this.home, name);
    mkdirSync(dir);
    return dir;
  }

  /** Launches an agent in the work directory, keyed by `key`. */
  async launch(
    key: string,
    harness: "claude-code" | "codex" = "claude-code",
    role?: string,
  ): Promise<LaunchAgentResponse> {
    const res = await this.request("/v1/agents", {
      method: "POST",
      body: {
        idempotencyKey: key,
        harness,
        cwd: this.work,
        ...(role === undefined ? {} : { role }),
      },
    });
    if (res.status !== 200) {
      throw new Error(`launching ${key} answered ${res.status}: ${JSON.stringify(res.body)}`);
    }
    return LaunchAgentResponse.parse(res.body);
  }

  /**
   * Submits a prompt in an agent's TUI through a view, as a person would. Until a TUI draws the
   * text it may still hold it as a paste and take an Enter for a newline in it, so Enter waits
   * for one more copy of `text` on the cursor's row, where the TUI takes input. A copy on another
   * row, such as a startup tip naming the same slash command, never counts, and history moving
   * can't hold the count down. `text` must fit on one row.
   */
  async prompt(launched: { agentId: string; terminalId: string | null }, text: string) {
    const view = await this.view(String(launched.terminalId), "interactive");
    await view.drive();
    const atCursor = async () => (await this.cursorRow(launched.agentId)).split(text).length - 1;
    const before = await atCursor();
    view.type(text);
    await waitUntil(
      async () => (await atCursor()) > before,
      "the typed prompt on the cursor's row",
    );
    view.type("\r");
    view.close();
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The daemon process's pid, while this helper runs one. */
  get pid(): number | undefined {
    const child = this.process;
    return child === undefined || child.exitCode !== null || child.signalCode !== null
      ? undefined
      : child.pid;
  }

  /** How the daemon process this helper last started exits, once it has. */
  get exited(): Promise<ExitStatus> {
    if (this.#exited === undefined) throw new Error("no daemon was started");
    return this.#exited;
  }

  /** The daemon's Unix socket, beside its tmux server. */
  get socket(): string {
    return join(this.home, "run", "bazhen.sock");
  }

  private async spawn(): Promise<void> {
    await this.launchProcess();
    await this.answering();
  }

  /** Whether the daemon's process has `path` open. */
  private holdsOpen(path: string): boolean {
    const fds = `/proc/${this.process?.pid}/fd`;
    try {
      return readdirSync(fds).some((fd) => readlinkSync(join(fds, fd)) === path);
    } catch {
      return false;
    }
  }

  /** The daemon's process, started on a port of its own, not yet waited on. */
  private async launchProcess(): Promise<void> {
    this.port = await freePort();
    const [program, ...args] = daemonCommand();
    const child = spawn(program, args, {
      env: { ...this.env, BAZHEN_PORT: String(this.port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    this.#exited = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    const log = new LogTail(LOG_KEPT);
    this.#log = log;
    child.stdout.on("data", (d: Buffer) => log.append(d.toString()));
    child.stderr.on("data", (d: Buffer) => log.append(d.toString()));
  }

  /** Waits for the launched daemon to answer, and stops it if it never does. */
  private async answering(): Promise<void> {
    const child = this.process;
    if (child === undefined) throw new Error("no daemon was launched");
    for (let i = 0; i < 100 && child.exitCode === null; i++) {
      // An unpaired caller is answered 401, which is answer enough that the daemon is up.
      if (
        await fetch(`${this.url}/v1/health`).then(
          (r) => r.ok || r.status === 401,
          () => false,
        )
      ) {
        // The daemon keeps its tmux server beside its own socket. Were its runtime directory
        // ever moved (a home too long for a socket path), every tmux command here would miss it.
        if (existsSync(this.socket)) return;
        await this.stop();
        throw new Error(`the daemon's runtime directory is not ${join(this.home, "run")}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.stop();
    throw new Error(`the daemon did not start:\n${this.#log.text()}`);
  }

  /**
   * The cookie of the browser this daemon's requests and streams come from, paired through
   * `bazhen devices pair`'s route on first use. The device outlives a restart, as a browser's does.
   */
  async cookie(): Promise<string> {
    this.device ??= this.pairBrowser();
    return this.device;
  }

  private device: Promise<string> | undefined;

  /**
   * Pairs a new browser on `origin`: a code over the socket, traded over HTTP for the device
   * cookie. One on an HTTPS origin gets the cookie a request from elsewhere needs.
   */
  async pairBrowser(name = "api test", origin = this.url): Promise<string> {
    const issued = await overSocket(this.socket, "POST", "/v1/pairing/codes");
    const { code } = PairingCodeResponse.parse(issued.body);
    const res = await fetch(`${this.url}/v1/pairing`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ code, name }),
    });
    if (!res.ok) throw new Error(`pairing failed: ${res.status} ${await res.text()}`);
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }

  /**
   * A request as the paired browser makes it, from the daemon's own origin when it acts.
   * `cookie: null` sends it as a browser that never paired.
   */
  async request(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      origin?: string;
      cookie?: string | null;
      headers?: Record<string, string>;
    } = {},
  ) {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...init.headers,
    };
    const origin = init.origin ?? (method === "GET" ? undefined : this.url);
    if (origin !== undefined) headers["origin"] = origin;
    const cookie = init.cookie === undefined ? await this.cookie() : init.cookie;
    if (cookie !== null) headers["cookie"] = cookie;
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    // A route that doesn't exist answers with plain text, not JSON.
    const text = await res.text();
    const body: unknown = res.headers.get("content-type")?.includes("json")
      ? JSON.parse(text)
      : text;
    return { status: res.status, body };
  }

  /** Opens a view of a terminal as a browser would, from the daemon's own origin by default. */
  async view(
    terminalId: string,
    mode: "observe" | "interactive",
    origin = this.url,
    size = { cols: 100, rows: 30 },
    cookie?: string,
  ): Promise<View> {
    return openView(this.url, terminalId, mode, {
      origin,
      size,
      cookie: cookie ?? (await this.cookie()),
    });
  }

  /** Opens a view of a terminal over the daemon's socket, as `bazhen terminals attach` does. */
  async socketView(terminalId: string, mode: "observe" | "interactive"): Promise<View> {
    const ws = new WebSocket(`ws+unix://${this.socket}:/v1/terminals/${terminalId}/stream`);
    const view = new View(ws);
    await opened(ws);
    view.frame({ type: "hello", protocolId: await protocolId(), mode, cols: 100, rows: 30 });
    return view;
  }

  /** Opens the event stream as a browser would, resuming after `cursor`. */
  async events(
    cursor: { epoch: string; eventId: number },
    opts: { origin?: string; host?: string; path?: string; cookie?: string } = {},
  ): Promise<EventClient> {
    const query = new URLSearchParams({
      epoch: cursor.epoch,
      after: String(cursor.eventId),
    });
    const ws = new WebSocket(
      `${this.url.replace("http", "ws")}${opts.path ?? "/v1/events"}?${query}`,
      {
        headers: {
          origin: opts.origin ?? this.url,
          cookie: opts.cookie ?? (await this.cookie()),
          ...(opts.host === undefined ? {} : { host: opts.host }),
        },
      },
    );
    const client = new EventClient(ws, cursor.eventId);
    await opened(ws);
    return client;
  }

  /** Opens the event stream over the daemon's socket, as `bazhen events` does, resuming after `cursor`. */
  async socketEvents(
    cursor: { epoch: string; eventId: number },
    opts: { path?: string } = {},
  ): Promise<EventClient> {
    const query = new URLSearchParams({ epoch: cursor.epoch, after: String(cursor.eventId) });
    const ws = new WebSocket(`ws+unix://${this.socket}:${opts.path ?? "/v1/events"}?${query}`);
    const client = new EventClient(ws, cursor.eventId);
    await opened(ws);
    return client;
  }

  /**
   * Resolves once `stream` has delivered every event the store holds now. The store goes on
   * recording (agents report as they start, a stream's next page waits on its last write), so a
   * stream is never compared with a snapshot at one instant: it is waited for to reach one.
   */
  async caughtUp(stream: EventClient): Promise<void> {
    const { eventId } = StateSnapshot.parse(
      (await overSocket(this.socket, "GET", "/v1/state")).body,
    );
    try {
      await waitUntil(() => stream.last() >= eventId, "the event stream");
    } catch (cause) {
      throw new Error(`the event stream reached event ${stream.last()}, not ${eventId}`, { cause });
    }
  }

  /** Adds `settings` to the user's own Claude Code settings, read at each agent's launch. */
  claudeSettings(settings: Record<string, unknown>): void {
    const file = join(this.home, "claude", "settings.json");
    const current: unknown = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...Object(current), ...settings }));
  }

  /** Whether a file exists in the agents' work directory. */
  hasFile(name: string): boolean {
    return existsSync(join(this.work, name));
  }

  tmux(...args: string[]): string {
    return this.tmuxServer.runSync(args);
  }

  /** The terminal's tmux session, found by the tag Bazhen wrote on it. */
  private session(terminalId: string): string | undefined {
    return this.paneFact(terminalId, "session_name");
  }

  /** The terminal's tmux session; an empty target would let tmux pick one of its own. */
  private requireSession(terminalId: string): string {
    const session = this.session(terminalId);
    if (session === undefined) throw new Error(`no tmux session for ${terminalId}`);
    return session;
  }

  /** A tmux format value of the terminal's pane, found by the tag Bazhen wrote on it. */
  paneFact(terminalId: string, format: string): string | undefined {
    const panes = this.tmux("list-panes", "-a", "-F", `#{@bazhen_terminal_id} #{${format}}`);
    return panes
      .split("\n")
      .find((l) => l.startsWith(`${terminalId} `))
      ?.split(" ")[1];
  }

  /** Reads the daemon's database, which no client is shown, for what only it records. */
  #read<T>(query: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(join(this.home, "data", "bazhen.db"), {
      readOnly: true,
      timeout: 5_000,
    });
    try {
      return query(db);
    } finally {
      db.close();
    }
  }

  /** The agent's terminal, as the daemon recorded it; none before it has one. */
  terminalOf(agentId: string): string | undefined {
    const row = this.#read((db) =>
      db.prepare(`SELECT terminal_id FROM agent_sessions WHERE id = ?`).get(agentId),
    );
    return typeof row?.terminal_id === "string" ? row.terminal_id : undefined;
  }

  private requireTerminal(agentId: string): string {
    const terminalId = this.terminalOf(agentId);
    if (terminalId === undefined) throw new Error(`no terminal for ${agentId}`);
    return terminalId;
  }

  /**
   * The socket of the holder the terminal runs on; none for one on tmux. A terminal the daemon no
   * longer records, as a closed one, is taken to be on the runtime it makes new terminals on.
   */
  holderAt(terminalId: string): string | undefined {
    const row = this.#read((db) =>
      db.prepare(`SELECT runtime FROM terminals WHERE id = ?`).get(terminalId),
    );
    const runtime = row?.runtime ?? this.#runtime ?? "holder";
    return runtime === "holder" ? this.holderSocket(terminalId) : undefined;
  }

  private holderSocket(terminalId: string): string {
    return join(this.home, "run", "holders", `${terminalId}.sock`);
  }

  /** The socket of the holder the agent's terminal runs on; none for one on tmux, or none yet. */
  holderOf(agentId: string): string | undefined {
    const terminalId = this.terminalOf(agentId);
    return terminalId === undefined ? undefined : this.holderAt(terminalId);
  }

  /** Whether the terminal is still open: its holder answers, or its tmux session is there. */
  async terminalOpen(terminalId: string): Promise<boolean> {
    const holder = this.holderAt(terminalId);
    if (holder === undefined) return this.session(terminalId) !== undefined;
    try {
      await askHolder(holder);
      return true;
    } catch (error) {
      if (!leftBehind(error)) throw error;
      // A holder that is ending may unlink its socket's file a moment before it lets the socket go.
      for (const start = Date.now(); Date.now() - start < 2_000;) {
        if (!listeningAt(holder)) return false;
        await new Promise((r) => setTimeout(r, 50));
      }
      return true;
    }
  }

  /** Whether the agent's terminal is still open. */
  async hasTerminal(agentId: string): Promise<boolean> {
    const terminalId = this.terminalOf(agentId);
    return terminalId !== undefined && (await this.terminalOpen(terminalId));
  }

  /** The agent a shell terminal is linked to, by the tag Bazhen wrote on it; none if unlinked. */
  async linkedAgentOf(terminalId: string): Promise<string | undefined> {
    if (this.holderAt(terminalId) === undefined)
      return this.paneFact(terminalId, "@bazhen_linked_agent_id") || undefined;
    return (await this.holderTags(terminalId))["linkedAgentId"];
  }

  /** The tags the terminal's holder carries, as the daemon set them. */
  async holderTags(terminalId: string): Promise<Readonly<Record<string, string>>> {
    const holder = this.holderAt(terminalId);
    if (holder === undefined) throw new Error(`terminal ${terminalId} is on no holder`);
    return (await askHolder(holder)).hello.tags;
  }

  /** The terminal's process: its holder's child, or its tmux pane's (Linux only for what reads it). */
  async terminalPid(terminalId: string): Promise<number> {
    const holder = this.holderAt(terminalId);
    const pid =
      holder === undefined
        ? Number(this.paneFact(terminalId, "pane_pid"))
        : (await askHolder(holder)).hello.childPid;
    if (!Number.isInteger(pid) || pid <= 1) throw new Error(`no process for ${terminalId}`);
    return pid;
  }

  /** The agent's process, as the agent's own tools would find it. */
  agentPid(agentId: string): Promise<number> {
    return this.terminalPid(this.requireTerminal(agentId));
  }

  /** The directory the terminal's process is in now (Linux only). */
  async terminalCwd(terminalId: string): Promise<string> {
    return readlinkSync(`/proc/${await this.terminalPid(terminalId)}/cwd`);
  }

  /**
   * The environment the terminal's process runs with (Linux only). A process in the middle of an
   * exec, as the agent's `claude` shim is, briefly shows an empty one, which no terminal's process
   * has once it runs: every runtime sets its TERM.
   */
  async terminalEnv(terminalId: string): Promise<Record<string, string>> {
    const pid = await this.terminalPid(terminalId);
    for (const start = Date.now(); Date.now() - start < 5_000;) {
      const env = processEnv(pid);
      if (Object.keys(env).length > 0) return env;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`process ${pid} of ${terminalId} shows no environment`);
  }

  /**
   * What the terminal shows, after up to `history` rows above it, as the daemon reads it for a
   * client; nothing once the daemon no longer has it.
   */
  async terminalScreen(terminalId: string, history = 0): Promise<string> {
    if (this.holderAt(terminalId) === undefined) {
      const session = this.session(terminalId);
      return session === undefined
        ? ""
        : this.tmux("capture-pane", "-p", "-t", session, "-S", `-${history}`);
    }
    const res = await this.request(`/v1/terminals/${terminalId}/screen?history=${history}`);
    if (res.status === 404) return "";
    if (res.status !== 200) {
      throw new Error(
        `reading ${terminalId}'s screen answered ${res.status}: ${JSON.stringify(res.body)}`,
      );
    }
    return TerminalScreen.parse(res.body).text;
  }

  /**
   * The agent's screen with its colours and attributes as escape sequences: the snapshot a view
   * of its terminal is opened on.
   */
  async styledScreen(agentId: string): Promise<string> {
    const view = await this.view(this.requireTerminal(agentId), "observe");
    try {
      await waitUntil(() => view.hasSnapshot(), "the view's snapshot");
      return view.snapshot().toString("utf8");
    } finally {
      view.close();
    }
  }

  /** What the terminal shows, after up to `history` rows above it; nothing before it has one. */
  async screen(of: ScreenOf, history = 0): Promise<string> {
    const terminalId = typeof of === "string" ? this.terminalOf(of) : of.terminalId;
    return terminalId === undefined ? "" : this.terminalScreen(terminalId, history);
  }

  /** The agent's lifecycle state, as the daemon's state shows it now. */
  async agentState(agentId: string): Promise<string | undefined> {
    const state = StateSnapshot.parse((await this.request("/v1/state")).body);
    return state.agents.find((a) => a.id === agentId)?.state;
  }

  /** Waits until the agent's harness has shown its first sign of life, which makes it running. */
  async running(agentId: string, timeoutMs = 30_000): Promise<void> {
    await waitUntil(
      async () => (await this.agentState(agentId)) === "running",
      `agent ${agentId}'s harness to come up`,
      timeoutMs,
    );
  }

  /** The title the agent's TUI set, from its holder or its tmux pane. */
  async title(agentId: string): Promise<string> {
    const terminalId = this.requireTerminal(agentId);
    const holder = this.holderAt(terminalId);
    return holder === undefined
      ? (this.paneFact(terminalId, "pane_title") ?? "")
      : (await holderLook(holder)).title;
  }

  /** Where the terminal's program has its cursor: column and row on the screen, from zero. */
  async cursor(of: ScreenOf): Promise<[number, number]> {
    const terminalId = typeof of === "string" ? this.requireTerminal(of) : of.terminalId;
    const holder = this.holderAt(terminalId);
    if (holder !== undefined) return (await holderLook(holder)).cursor;
    const out = this.tmux(
      "display-message",
      "-p",
      "-t",
      this.requireSession(terminalId),
      "#{cursor_x} #{cursor_y}",
    );
    const [x = 0, y = 0] = out.trim().split(" ").map(Number);
    return [x, y];
  }

  /** The screen row the agent's program has its cursor on. */
  async cursorRow(agentId: string): Promise<string> {
    const terminalId = this.requireTerminal(agentId);
    const holder = this.holderAt(terminalId);
    if (holder !== undefined) return (await holderLook(holder)).cursorRow;
    const [, row] = await this.cursor(agentId);
    const session = this.requireSession(terminalId);
    return this.tmux("capture-pane", "-p", "-t", session, "-S", `${row}`, "-E", `${row}`);
  }

  /** The environment the agent's process runs with, as its own tools see it (Linux only). */
  async agentEnv(agentId: string): Promise<Record<string, string>> {
    return this.terminalEnv(this.requireTerminal(agentId));
  }

  /**
   * The file holding the agent's token, on either runtime, for an agent this daemon started once:
   * each start mints a file of its own.
   */
  tokenFile(agentId: string): string {
    const dir = join(this.home, "run", "agents");
    const files = readdirSync(dir).filter(
      (f) => f.startsWith(`${agentId}.`) && f.endsWith(".token"),
    );
    if (files.length !== 1) throw new Error(`agent ${agentId} has ${files.length} token files`);
    return join(dir, String(files[0]));
  }

  /** The agent's token, from `tokenFile`, on either runtime. */
  tokenOf(agentId: string): string {
    return readFileSync(this.tokenFile(agentId), "utf8").trim();
  }

  /** The token the agent's process presents, from the file its environment names (Linux only). */
  async agentToken(agentId: string): Promise<string> {
    const file = (await this.agentEnv(agentId))["BAZHEN_AGENT_AUTH_FILE"];
    if (file === undefined) throw new Error(`agent ${agentId} runs with no token file`);
    return readFileSync(file, "utf8").trim();
  }

  /** The environment Codex's managed app-server on this daemon's Codex home runs with (Linux only). */
  codexServerEnv(): Record<string, string> {
    const file = join(this.home, "codex", "app-server-daemon", "daemon.pid");
    const pid: unknown = Reflect.get(Object(JSON.parse(readFileSync(file, "utf8"))), "pid");
    return processEnv(Number(pid));
  }

  /** What a file in the work directory holds, or null when there is none. */
  workFile(name: string): string | null {
    const path = join(this.work, name);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  /**
   * The `bazhen-hook shell-prompt` copies still waiting on the shell `pid` for its line editor,
   * from /proc (Linux only).
   */
  static promptWaiters(pid: number): number {
    return readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .filter((name) => {
        try {
          const argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
          const at = argv.indexOf("--shell");
          return (
            argv.includes("shell-prompt") &&
            argv.includes("--detached") &&
            argv[at + 1] === String(pid)
          );
        } catch {
          return false;
        }
      }).length;
  }

  /**
   * Runs a second daemon on this home, straight from its entry point rather than through
   * `bazhen start`'s own check, and resolves with how it exited and what it printed.
   */
  startAnother(): Promise<{ code: number; out: string }> {
    const [program, ...args] = daemonCommand();
    return new Promise((resolve) => {
      execFile(
        program,
        args,
        { env: { ...this.env, BAZHEN_PORT: String(this.port) }, timeout: 30_000 },
        (err, stdout, stderr) =>
          resolve({ code: err === null ? 0 : Number(err.code ?? 1), out: stdout + stderr }),
      );
    });
  }

  /**
   * The working directory of the daemon serving this home, found by its environment rather than
   * as a child, since `bazhen start` detaches it (Linux only).
   */
  daemonCwd(): string {
    // The TypeScript daemon's entry point, or the Rust daemon's binary, is the last word.
    const entry = daemonCommand().at(-1) ?? "";
    for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
        if (cmdline.includes(entry) && environ.includes(`BAZHEN_HOME=${this.home}`))
          return readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        // The process ended, or isn't ours to read.
      }
    }
    throw new Error(`no daemon for ${this.home}`);
  }

  /** The file the hook link runs, every link resolved. */
  hookClient(): string {
    return realpathSync(join(this.home, "state", "hook", "bazhen-hook"));
  }

  /** The command line of the agent's process (Linux only). */
  async agentCommand(agentId: string): Promise<string[]> {
    return readFileSync(`/proc/${await this.agentPid(agentId)}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean);
  }

  /**
   * Signals the agent's process group from outside the daemon, as a user's `kill` would. A holder
   * sends it through its own guard, to the child it started; tmux's is reached by host-guard only
   * once the private server confirms the pane still runs that process.
   */
  async signalAgent(agentId: string, signal: HolderSignal): Promise<void> {
    const terminalId = this.requireTerminal(agentId);
    const holder = this.holderAt(terminalId);
    if (holder !== undefined) {
      await askHolder(holder, (_, id) => ({ type: "signal", id, body: { signal } }));
      return;
    }
    const pane = this.paneFact(terminalId, "pane_id") ?? "";
    const expected = {
      pid: this.paneFact(terminalId, "pane_pid") ?? "",
      generation: this.paneFact(terminalId, GENERATION_OPTION) ?? "",
    };
    signalPane(await this.tmuxServer.paneGroup(pane, expected), signal);
  }

  /**
   * Starts `argv` on the agent's holder once its process has exited, as a new generation the
   * daemon didn't ask for: what a terminal looks like to a daemon that was down while its program
   * was replaced.
   */
  async respawnOnHolder(agentId: string, argv: readonly string[]): Promise<void> {
    const holder = this.holderOf(agentId);
    if (holder === undefined) throw new Error(`agent ${agentId}'s terminal is on no holder`);
    await waitUntil(
      async () => (await askHolder(holder)).hello.exit !== null,
      `agent ${agentId}'s process to exit`,
    );
    await askHolder(holder, (hello, id) => ({
      type: "respawn",
      id,
      body: { argv: [...argv], cwd: this.work, env: {}, generation: hello.generation + 1 },
    }));
  }

  /** Gives the agent's bound Claude Code session a conversation to resume (`giveTranscript`). */
  giveTranscript(agentId: string, sessionId: string): Promise<void> {
    return giveTranscript(this.home, agentId, sessionId);
  }

  /**
   * A terminal running `argv` as an agent's process, on either runtime: the agent's launch runs
   * the `claude` on the daemon's PATH, which runs `argv` instead of Claude Code. The terminal is
   * one the daemon knows and streams, and `argv` is the process it records.
   */
  async program(argv: readonly string[]): Promise<{ agentId: string; terminalId: string }> {
    let terminalId = "";
    const agentId = await runAsNextAgent(
      this.home,
      argv,
      async () => {
        const launched = await this.launch(`program-${++programs}`);
        terminalId = String(launched.terminalId);
        return launched.agentId;
      },
      waitUntil,
    );
    return { agentId, terminalId };
  }

  /**
   * A shell terminal running `argv` in place of the shell, on either runtime: the shell the daemon
   * opens is its `$SHELL`, which runs `argv` instead of the login shell. The terminal is one the
   * daemon knows and streams, with no agent, so it works on a daemon that launches none.
   */
  async shellProgram(argv: readonly string[]): Promise<{ terminalId: string }> {
    if (this.env["SHELL"] !== this.#programShell) {
      throw new Error("this daemon's $SHELL isn't the one that runs a queued program");
    }
    const terminalId = await runAsNextShell(
      this.home,
      argv,
      async () => {
        const shell = await this.request("/v1/shells", {
          method: "POST",
          body: { idempotencyKey: `shell-program-${++programs}`, cwd: this.work },
        });
        return ShellCommandResponse.parse(shell.body).terminalId;
      },
      waitUntil,
    );
    return { terminalId };
  }

  /**
   * Runs another program in a tmux agent's pane, killing its own: the terminal Bazhen knows stays
   * the same, but the process in it isn't the one the daemon recorded.
   */
  runInTerminal(agentId: string, argv: readonly string[]): void {
    const session = this.session(this.requireTerminal(agentId));
    if (session === undefined) throw new Error(`no tmux session for ${agentId}`);
    this.tmux("respawn-pane", "-k", "-t", `${session}:0`, ...argv);
  }

  /**
   * Makes the daemon's tmux server unreachable, as a socket it may not connect to would, until the
   * returned function puts it back. The server and its agents keep running.
   */
  blockTmux(): () => void {
    const socket = this.tmux("display-message", "-p", "#{socket_path}").trim();
    const mode = statSync(socket).mode;
    chmodSync(socket, 0);
    return () => chmodSync(socket, mode);
  }

  /**
   * Makes the holder running `terminalId` unreachable, as a socket it may not connect to would,
   * until the returned function puts it back. The holder and its terminal keep running.
   */
  blockHolder(terminalId: string): () => void {
    const socket = this.holderSocket(terminalId);
    const mode = statSync(socket).mode;
    chmodSync(socket, 0);
    return () => chmodSync(socket, mode);
  }

  /** Deletes the private server's socket under it, as a temp cleaner would; the server runs on. */
  tmuxSocketExists(): boolean {
    return existsSync(this.tmuxServer.socket);
  }

  deleteTmuxSocket(): void {
    rmSync(this.tmuxServer.socket);
  }

  /**
   * Ends the terminal from outside the daemon, as a user would by hand: its holder closed by its
   * own protocol, or its tmux session killed.
   */
  async endTerminal(of: ScreenOf): Promise<void> {
    const terminalId = typeof of === "string" ? this.requireTerminal(of) : of.terminalId;
    const holder = this.holderAt(terminalId);
    if (holder !== undefined) return closeHolderAt(holder);
    const session = this.session(terminalId);
    if (session === undefined) throw new Error(`no tmux session for ${terminalId}`);
    this.tmux("kill-session", "-t", session);
  }

  /** Rewrites the Codex home's config.toml as its user would edit it; returns what it held. */
  editCodexConfig(edit: (config: string) => string): string {
    const file = join(this.home, "codex", "config.toml");
    const before = readFileSync(file, "utf8");
    writeFileSync(file, edit(before));
    return before;
  }

  /**
   * Runs the Codex CLI on this daemon's Codex home, as its user would: without Bazhen's settings,
   * as the daemon runs it, since an app-server it starts would hand them to every command it runs.
   */
  async codex(...args: string[]): Promise<void> {
    await this.codexWith({}, ...args);
  }

  /**
   * The Codex CLI as `codex()` runs it, with `extra` in its environment, as a command run inside
   * an agent's terminal would have its variables.
   */
  async codexWith(extra: Readonly<Record<string, string>>, ...args: string[]): Promise<void> {
    const env = {
      ...Object.fromEntries(
        Object.entries(this.env).filter(([name]) => !name.startsWith("BAZHEN_")),
      ),
      ...extra,
    };
    await run("codex", args, { env, timeout: 90_000 });
  }

  /**
   * One request to Codex's managed app-server on this daemon's Codex home, as a client of its
   * own: it initializes, asks and disconnects.
   */
  async codexRequest(method: string, params: unknown): Promise<unknown> {
    const socket = join(this.home, "codex", "app-server-control", "app-server-control.sock");
    const ws = new WebSocket(`ws+unix://${socket}:/`);
    await once(ws, "open");
    const replies = new Map<number, unknown>();
    ws.on("message", (data: Buffer) => {
      const m: unknown = JSON.parse(data.toString("utf8"));
      if (typeof m === "object" && m !== null && "id" in m && typeof m.id === "number") {
        replies.set(m.id, m);
      }
    });
    const ask = async (id: number, m: string, p: unknown) => {
      ws.send(JSON.stringify({ id, method: m, params: p }));
      await waitUntil(() => replies.has(id), `the app-server's reply to ${m}`);
      return replies.get(id);
    };
    await ask(0, "initialize", { clientInfo: { name: "bazhen-test", version: "0" } });
    ws.send(JSON.stringify({ method: "initialized" }));
    const reply = await ask(1, method, params);
    ws.close();
    return reply;
  }

  /** Kills the daemon outright, as a crash would; its agents keep running in tmux. */
  async crash(): Promise<void> {
    await this.exit("SIGKILL");
  }

  /** Starts the daemon again on the same home, as `bazhen start` would after a crash. */
  async restart(): Promise<void> {
    await this.spawn();
  }

  private async exit(signal: NodeJS.Signals): Promise<void> {
    const child = this.process;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => {
      child.once("exit", resolve);
      signalOwnChild(child, signal);
    });
  }

  /**
   * PTY handles the daemon process holds, from /proc: these suites run only on Linux, in CI or
   * the `make test-real` container.
   */
  ptyHandles(): number {
    const pid = this.process?.pid;
    if (pid === undefined) throw new Error("the daemon is not running");
    const fds = `/proc/${pid}/fd`;
    return readdirSync(fds).filter((fd) => {
      try {
        return readlinkSync(join(fds, fd)).includes("ptmx");
      } catch {
        // Closed between the listing and the read.
        return false;
      }
    }).length;
  }

  /**
   * Counts the sockets the terminal's holder has open, from /proc: the one it listens on and each
   * connection to it. Asks the holder for its pid once, so a count makes no connection of its own.
   */
  async holderSocketCounter(terminalId: string): Promise<() => number> {
    const holder = this.holderAt(terminalId);
    if (holder === undefined) throw new Error(`terminal ${terminalId} is on no holder`);
    const fds = `/proc/${(await askHolder(holder)).hello.holderPid}/fd`;
    return () =>
      readdirSync(fds).filter((fd) => {
        try {
          return readlinkSync(join(fds, fd)).startsWith("socket:");
        } catch {
          // Closed between the listing and the read.
          return false;
        }
      }).length;
  }

  /** Detaches every tmux client from the agent's terminal, as if the client's tmux link broke. */
  detachClients(agentId: string): void {
    this.tmux("detach-client", "-s", this.requireSession(this.requireTerminal(agentId)));
  }

  /** Stops the daemon, its tmux server, its holders and every file under its home. */
  async stop(): Promise<void> {
    await this.exit("SIGTERM");
    // A daemon `bazhen start` detached is not this process's child.
    await bazhen(["stop"], this.env);
    // Codex's managed daemon outlives its clients; only its own stop ends it.
    const codexStopped = codexDaemonStarted(this.home)
      ? run("codex", ["app-server", "daemon", "stop"], { env: this.env, timeout: 90_000 })
      : undefined;
    this.#tmuxServer.killServer();
    try {
      await closeHoldersUnder(this.home);
    } finally {
      await codexStopped;
      // The agents' processes may still be writing their state as the server goes down.
      rmSync(this.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}

/**
 * Replaces the program on the holder at `socket` with `argv`, from outside the daemon and over the
 * holder's own protocol, as any client of its socket can: asks the holder to end its child, then
 * to start `argv` at the next generation. Resolves with what the holder says it started.
 */
export async function replaceHolderChild(
  socket: string,
  argv: string[],
): Promise<{ generation: number; childPid: number }> {
  const connection = createConnection(socket);
  connection.on("error", () => {});
  const decoder = holderReplyDecoder();
  const send = (frame: Parameters<typeof encodeHolderRequest>[0]) =>
    connection.write(encodeHolderRequest(frame));
  const respawned = new Promise<{ generation: number; childPid: number }>((resolve, reject) => {
    connection.on("data", (chunk: Buffer) => {
      const { frames, malformed } = decoder.push(new Uint8Array(chunk));
      for (const frame of frames) {
        if (frame.type === "hello") send({ type: "signal", id: 2, body: { signal: "SIGKILL" } });
        if (frame.type === "exited") {
          const generation = frame.body.generation + 1;
          send({ type: "respawn", id: 3, body: { argv, cwd: "/", env: {}, generation } });
        }
        if (frame.type === "respawned") resolve(frame.body);
        if (frame.type === "error") reject(new Error(`${socket} refused: ${frame.body.message}`));
      }
      if (malformed !== null) reject(new Error(`${socket} sent ${malformed}`));
    });
    connection.on("close", () => reject(new Error(`${socket} hung up before respawning`)));
  });
  send({ type: "hello", id: 1, body: { protocol: [HOLDER_PROTOCOL_VERSION] } });
  const timer = setTimeout(() => connection.destroy(new Error(`${socket} didn't respawn`)), 10_000);
  try {
    return await respawned;
  } finally {
    clearTimeout(timer);
    connection.end();
  }
}

/** What a holder's terminal shows, read over the holder's own protocol, as a client would. */
export interface HolderLook {
  /** The title its program set last. */
  readonly title: string;
  /** The visible screen's lines, as a browser replaying its snapshot shows them. */
  readonly screen: string[];
  /** The cursor's column and row on the visible screen, from zero. */
  readonly cursor: [number, number];
  /** The screen line the cursor is on. */
  readonly cursorRow: string;
}

type HolderHello = Extract<HolderReply, { type: "hello" }>["body"];

/** The id `askHolder` gives the one request it sends after `hello`. */
const ASKED = 2;

/**
 * Says `hello` to the holder at `socket`, without asking for the writer slot, then sends the
 * request `ask` makes of the hello, if any, and resolves with the holder's answer to it. A
 * refusal throws. Rejects with the connection's own error when nothing listens there.
 */
async function askHolder(
  socket: string,
  ask?: (hello: HolderHello, id: number) => HolderRequest,
): Promise<{ hello: HolderHello; answer: HolderReply | undefined }> {
  const connection = createConnection(socket);
  const decoder = holderReplyDecoder();
  let hello: HolderHello | undefined;
  let answer: HolderReply | undefined;
  let failure: Error | undefined;
  const answered = new Promise<void>((resolve, reject) => {
    connection.on("error", (error) => (failure = error));
    connection.on("data", (chunk: Buffer) => {
      const { frames, malformed } = decoder.push(new Uint8Array(chunk));
      for (const frame of frames) {
        if (frame.type === "hello" && hello === undefined) {
          hello = frame.body;
          if (ask === undefined) resolve();
          else connection.write(encodeHolderRequest(ask(hello, ASKED)));
        } else if (frame.type !== "unknown" && "id" in frame && frame.id === ASKED) {
          answer = frame.type === "snapshot" ? { ...frame, bytes: frame.bytes.slice() } : frame;
          resolve();
        }
      }
      if (malformed !== null) reject(new Error(`${socket} sent ${malformed}`));
    });
    connection.on("close", () => reject(failure ?? new Error(`${socket} hung up unanswered`)));
  });
  connection.write(
    encodeHolderRequest({ type: "hello", id: 1, body: { protocol: [HOLDER_PROTOCOL_VERSION] } }),
  );
  const timer = setTimeout(() => connection.destroy(new Error(`${socket} didn't answer`)), 5_000);
  try {
    await answered;
  } finally {
    clearTimeout(timer);
    connection.end();
  }
  if (hello === undefined) throw new Error(`${socket} said no hello`);
  if (answer?.type === "error") {
    throw new Error(
      `${socket} refused ${answer.body.request}: ${answer.body.code} ${answer.body.message}`,
    );
  }
  return { hello, answer };
}

/**
 * Says `hello` to the holder at `socket` and asks for a snapshot, then hangs up. Nothing it asks
 * changes the terminal: no writer slot, no subscription.
 */
export async function holderLook(socket: string): Promise<HolderLook> {
  const { hello, answer } = await askHolder(socket, (_, id) => ({ type: "snapshot", id }));
  if (answer?.type !== "snapshot") throw new Error(`${socket} answered no snapshot`);
  const shown = await replay(answer.bytes, hello.size);
  return {
    title: hello.title,
    screen: shown.screen,
    cursor: shown.cursor,
    cursorRow: shown.screen[shown.cursor[1]] ?? "",
  };
}

/** The name of the machine the tests run on, as the daemon gives its local environment's host. */
export const HOST = hostname();

/**
 * A writer connection of its own to the holder at `socket`, for while no daemon holds the writer
 * slot: `type` sends input to its program as keys would, `end` resolves once the holder has it.
 */
async function holderWriter(socket: string) {
  const connection = createConnection(socket);
  let failure: Error | undefined;
  connection.on("error", (error) => (failure = error));
  const decoder = holderReplyDecoder();
  const writer = new Promise<boolean>((resolve, reject) => {
    connection.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(new Uint8Array(chunk)).frames)
        if (frame.type === "hello") resolve(frame.body.writer);
    });
    connection.on("close", () => reject(failure ?? new Error(`${socket} hung up before hello`)));
  });
  const hello = { protocol: [HOLDER_PROTOCOL_VERSION], writer: true };
  connection.write(encodeHolderRequest({ type: "hello", id: 1, body: hello }));
  const timer = setTimeout(() => connection.destroy(new Error(`${socket} didn't answer`)), 5_000);
  try {
    if (!(await writer)) throw new Error(`${socket} gave its writer slot to another connection`);
  } catch (error) {
    connection.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  let id = 1;
  return {
    type: (input: string) =>
      connection.write(encodeHolderRequest({ type: "input", id: ++id, bytes: Buffer.from(input) })),
    end: async () => {
      await new Promise<void>((resolve) => connection.end(resolve));
      connection.destroy();
    },
  };
}

/** Types `input` into the program on the holder at `socket`, at once, as keys would. */
export async function typeOnHolder(socket: string, input: string): Promise<void> {
  const writer = await holderWriter(socket);
  writer.type(input);
  await writer.end();
}

/**
 * Submits `text` to the program on the holder at `socket` as `Daemon.prompt` does, typing over a
 * writer connection of its own: for while no daemon holds the writer slot, as when it is down.
 */
export async function promptHolder(socket: string, text: string): Promise<void> {
  const writer = await holderWriter(socket);
  try {
    const atCursor = async () => (await holderLook(socket)).cursorRow.split(text).length - 1;
    const before = await atCursor();
    writer.type(text);
    await waitUntil(
      async () => (await atCursor()) > before,
      "the typed prompt on the cursor's row",
    );
    writer.type("\r");
  } finally {
    await writer.end();
  }
}

/**
 * Whether a title names `threadId`. Codex cuts a long title short with an ellipsis, so the title
 * is a long enough prefix of it: thread ids are UUIDv7, and a thread started later differs well
 * within 20 characters.
 */
export const showsThread = (title: string, threadId: string) => {
  const shown = title.replace(/(\.\.\.|…)$/, "");
  return shown.length >= 20 && threadId.startsWith(shown);
};

/**
 * Opens a view of a terminal on the daemon at `url`, as a paired browser at `origin` would: what
 * `Daemon.view` does, for a process that has only the daemon's address and the browser's cookie.
 */
export async function openView(
  url: string,
  terminalId: string,
  mode: "observe" | "interactive",
  {
    origin,
    size,
    cookie,
  }: { origin: string; size: { cols: number; rows: number }; cookie: string },
): Promise<View> {
  const ws = new WebSocket(`${url.replace("http", "ws")}/v1/terminals/${terminalId}/stream`, {
    headers: { origin, cookie },
  });
  const view = new View(ws);
  await opened(ws);
  view.frame({ type: "hello", protocolId: await protocolId(), mode, ...size });
  return view;
}

/** Resolves once the upgrade is accepted; a refusal rejects with its status. */
function opened(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) => reject(new Error(`refused: ${res.statusCode}`)));
    ws.once("error", reject);
  });
}

/** One open event stream: every frame the daemon sent it. */
export class EventClient {
  readonly frames: EventFrame[] = [];
  private closed = false;
  private readonly ws: WebSocket;
  private readonly after: number;

  constructor(ws: WebSocket, after: number) {
    this.ws = ws;
    this.after = after;
    ws.on("message", (data: Buffer) => {
      this.frames.push(EventFrame.parse(JSON.parse(data.toString("utf8"))));
    });
    ws.on("close", () => (this.closed = true));
  }

  /** The ids of the events received, in the order they arrived. */
  ids(): number[] {
    return this.frames.flatMap((f) => (f.type === "event" ? [f.event.id] : []));
  }

  /** The newest event received, or the cursor the stream resumed after before any. */
  last(): number {
    return this.ids().at(-1) ?? this.after;
  }

  types(): string[] {
    return this.frames.flatMap((f) => (f.type === "event" ? [f.event.type] : []));
  }

  /** The payloads of the events of `type` received, in the order they arrived. */
  payloads(type: string): unknown[] {
    return this.frames.flatMap((f) =>
      f.type === "event" && f.event.type === type ? [f.event.payload] : [],
    );
  }

  /** Whether the daemon has closed the stream. */
  ended(): boolean {
    return this.closed;
  }

  close(): void {
    this.ws.close();
  }
}

/** One open stream: everything the daemon sent it, and a way to type. */
export class View {
  readonly frames: StreamServerFrame[] = [];
  private readonly raw: Buffer[] = [];
  private rawBytes = 0;
  private readonly outputListeners: ((chunk: Buffer) => void)[] = [];
  private snapshotEnd: number | undefined;
  private readonly ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: Buffer, binary: boolean) => {
      if (binary) {
        this.raw.push(data);
        this.rawBytes += data.length;
        for (const listener of this.outputListeners) listener(data);
        return;
      }
      const frame = StreamServerFrame.parse(JSON.parse(data.toString("utf8")));
      if (frame.type === "snapshot_end") this.snapshotEnd = this.raw.length;
      this.frames.push(frame);
      // As a browser does: what it types counts only under the epoch it last heard of.
      const attached = this.frames.some((f) => f.type === "attached");
      const epoch = this.frames.findLast((f) => f.type === "lease")?.epoch;
      if (
        (frame.type === "lease" || frame.type === "attached") &&
        attached &&
        epoch !== undefined
      ) {
        this.frame({ type: "epoch", epoch });
      }
    });
  }

  /** The bytes of the snapshot the view opened on, without the live output after it. */
  snapshot(): Buffer {
    if (this.snapshotEnd === undefined) throw new Error("no snapshot received yet");
    return Buffer.concat(this.raw.slice(0, this.snapshotEnd));
  }

  /** Calls `listener` with each chunk of terminal output this view receives from now on. */
  onOutput(listener: (chunk: Buffer) => void): void {
    this.outputListeners.push(listener);
  }

  /** Whether the snapshot the view opened on has arrived whole. */
  hasSnapshot(): boolean {
    return this.snapshotEnd !== undefined;
  }

  /** How many bytes of terminal output this view has received, without copying them. */
  receivedBytes(): number {
    return this.rawBytes;
  }

  /** Every byte of terminal output this view has received, in order. */
  received(): Buffer {
    return Buffer.concat(this.raw);
  }

  /** The terminal output this view has received, escape sequences included. */
  output(): string {
    return this.received().toString("utf8");
  }

  /** Resolves once the daemon has attached this view to the terminal. */
  async attached(): Promise<void> {
    await waitUntil(() => this.frames.some((f) => f.type === "attached"), "the attachment");
  }

  /** The id of this view's attachment, from the frame that told it it is attached. */
  attachmentId(): string {
    const attached = this.frames.find((f) => f.type === "attached");
    if (attached?.type !== "attached") throw new Error("the view is not attached yet");
    return attached.attachmentId;
  }

  /** Engages this view, as a click would, and resolves once it drives the terminal. */
  async drive(): Promise<void> {
    await this.attached();
    this.frame({ type: "engage" });
    await waitUntil(() => this.driving(), "the lease");
  }

  /** Whether this view drives the terminal, by the latest lease frame it received. */
  driving(): boolean {
    return this.frames.findLast((f) => f.type === "lease")?.driver === true;
  }

  frame(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  type(text: string): void {
    this.ws.send(Buffer.from(text), { binary: true });
  }

  /** The text a browser would show from everything received, whatever escapes drew it. */
  async text(): Promise<string> {
    return (await replay(this.received(), SIZE)).lines.join("\n");
  }

  /** The text a browser would show from the snapshot alone, once it has arrived whole. */
  async snapshotText(): Promise<string> {
    await waitUntil(() => this.hasSnapshot(), "the snapshot");
    return (await replay(this.snapshot(), SIZE)).lines.join("\n");
  }

  /** Stops reading from the socket, as a stalled browser would; the daemon's sends back up. */
  stall(): void {
    this.ws.pause();
  }

  resume(): void {
    this.ws.resume();
  }

  /** Resolves when the daemon has closed this view's socket. */
  closed(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === this.ws.CLOSED) resolve();
      else this.ws.once("close", () => resolve());
    });
  }

  close(): void {
    this.ws.close();
  }
}

/** `Ctrl-]` twice: what detaches unless the person names other keys. */
export const DETACH = "\x1d\x1d";

/**
 * `bazhen terminals attach <target>` in a terminal of its own, which util-linux's `script` gives it, sized
 * as a person's would be: what it shows, keys to type into it, and how it exits.
 */
export function attachInScript(daemon: Daemon, target: string) {
  const child = spawn(
    "script",
    ["-qfec", `stty cols 100 rows 30 && exec bazhen terminals attach ${target}`, "/dev/null"],
    { env: daemon.env, stdio: ["pipe", "pipe", "inherit"] },
  );
  let shown = "";
  child.stdout.on("data", (chunk: Buffer) => (shown += chunk.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return {
    shown: () => shown,
    /** Waits until it has shown `text`, saying what it showed instead if it never does. */
    shows: (text: string, what: string) =>
      waitUntil(() => shown.includes(text), what).catch((err: unknown) => {
        throw new Error(`${String(err)}; it showed ${JSON.stringify(shown)}`);
      }),
    type: (keys: string) => child.stdin.write(keys),
    exited,
    /** Detaches, should a test have left it attached. */
    leave: () => child.stdin.end(DETACH),
  };
}

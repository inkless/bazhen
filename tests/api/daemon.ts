// Runs the daemon as a separate process and reaches it only as a client would: over HTTP,
// WebSocket and tmux. Nothing here imports the daemon's code, so the same tests can certify a
// daemon written in another language.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
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
  EventFrame,
  HOLDER_PROTOCOL_VERSION,
  holderReplyDecoder,
  type HolderReply,
  LaunchAgentResponse,
  PROTOCOL_VERSION,
  StreamServerFrame,
  PairingCodeResponse,
  StateSnapshot,
} from "@bazhen/protocol";
import { agentHomes, codexDaemonStarted, loginEnv } from "../support/agent-env.ts";
import { giveTranscript } from "../support/transcript.ts";
import { replay } from "./fixtures/browser.ts";

const run = promisify(execFile);

/** What each harness's TUI shows once it has started. */
export const BANNER = { "claude-code": "Claude Code", codex: "OpenAI Codex" } as const;

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
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end(init.body === undefined ? undefined : JSON.stringify(init.body));
  });
}

/** Runs `bazhen <args>` with `env`, and resolves with how it exited and what it printed. */
export function bazhen(
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(repo, "apps/cli/src/main.ts"), ...args],
      { env, timeout: 30_000 },
      (err, stdout, stderr) =>
        resolve({ code: err === null ? 0 : Number(err.code ?? 1), out: stdout + stderr }),
    );
  });
}

/**
 * A directory under `home` holding a `bazhen` that runs this checkout's CLI, so an agent finds
 * the command by name, as it would where Bazhen is installed.
 */
function cliOnPath(home: string): string {
  const dir = join(home, "cli");
  mkdirSync(dir, { recursive: true });
  const main = join(repo, "apps/cli/src/main.ts");
  writeFileSync(join(dir, "bazhen"), `#!/bin/sh\nexec '${process.execPath}' '${main}' "$@"\n`);
  chmodSync(join(dir, "bazhen"), 0o755);
  return dir;
}

/** A daemon's environment on `home`: the login session's, and nothing of the test run's. */
export function homeEnv(home: string): Record<string, string> {
  return { ...loginEnv(), PATH: process.env["PATH"] ?? "/usr/bin:/bin", BAZHEN_HOME: home };
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
  /** The daemon's private server: `<home>/run/tmux.sock`, for a home this short. */
  readonly tmuxServer: TmuxServer;
  /** What the daemon runs with; the CLI reaches this daemon with it too. */
  readonly env: Record<string, string>;
  private port = 0;
  private process: ChildProcess | undefined;
  private output = "";

  private constructor(home: string, opts: DaemonOptions) {
    this.home = home;
    this.work = join(home, "work");
    this.tmuxServer = TmuxServer.at(join(home, "run", "tmux.sock"), { root: home });
    mkdirSync(this.work, { recursive: true });
    if (opts.config !== undefined) this.writeConfig(opts.config);

    this.env = {
      ...homeEnv(home),
      PATH: `${cliOnPath(home)}:${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      ...agentHomes(home, this.work, { anthropic: opts.modelUrl, responses: opts.responsesUrl }),
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
   * A daemon started as a user starts it: `bazhen start`, from a shell whose environment adds
   * `env`, with `config` as its config.toml. `stop` ends it with `bazhen stop`.
   */
  static async startWithCli(config: string, env: Record<string, string>): Promise<Daemon> {
    const daemon = new Daemon(realpathSync(mkdtempSync("/tmp/bz-api-")), {});
    daemon.port = await freePort();
    Object.assign(daemon.env, { BAZHEN_PORT: String(daemon.port) });
    daemon.writeConfig(config);
    const started = await bazhen(["start"], { ...daemon.env, ...env });
    if (started.code !== 0) {
      await daemon.stop();
      throw new Error(`bazhen start failed:\n${started.out}`);
    }
    return daemon;
  }

  /** Writes a role file of the user's, which the daemon reads at its next use of the roles. */
  writeRole(key: string, text: string): void {
    mkdirSync(join(this.home, "config", "roles"), { recursive: true });
    writeFileSync(join(this.home, "config", "roles", `${key}.md`), text);
  }

  /** Replaces its config.toml, which the daemon reads when it next starts. */
  writeConfig(toml: string): void {
    mkdirSync(join(this.home, "config"), { recursive: true });
    writeFileSync(join(this.home, "config", "config.toml"), toml);
  }

  /**
   * The line the daemon keeps for a shell to type back, read from its database: no client is
   * shown it, so a test that the right line was kept can only look there.
   */
  keptShellLine(terminalId: string): string | null {
    const db = new DatabaseSync(join(this.home, "data", "bazhen.db"), { readOnly: true });
    try {
      const row = db.prepare("SELECT last_command FROM terminals WHERE id = ?").get(terminalId);
      return typeof row?.last_command === "string" ? row.last_command : null;
    } finally {
      db.close();
    }
  }

  /** A shell's visible screen, as tmux holds it. */
  shellScreen(terminalId: string): string {
    const session = this.paneFact(terminalId, "session_name", "@bazhen_terminal_id");
    return session === undefined ? "" : this.tmux("capture-pane", "-p", "-t", session);
  }

  /** What the daemon has printed since it last started. */
  log(): string {
    return this.output;
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
    const holder = this.holderOf(launched.agentId);
    const row = async () =>
      holder === undefined
        ? this.cursorRow(launched.agentId)
        : (await holderLook(holder)).cursorRow;
    const atCursor = async () => (await row()).split(text).length - 1;
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

  /** The daemon's Unix socket, beside its tmux server. */
  get socket(): string {
    return join(this.home, "run", "bazhen.sock");
  }

  private async spawn(): Promise<void> {
    this.port = await freePort();
    const child = spawn(process.execPath, [join(repo, "apps/daemon/src/main.ts")], {
      env: { ...this.env, BAZHEN_PORT: String(this.port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    this.output = "";
    child.stdout.on("data", (d: Buffer) => (this.output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (this.output += d.toString()));
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
    throw new Error(`the daemon did not start:\n${this.output}`);
  }

  /**
   * The cookie of the browser this daemon's requests and streams come from, paired through
   * `bazhen pair`'s route on first use. The device outlives a restart, as a browser's does.
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
    const ws = new WebSocket(
      `${this.url.replace("http", "ws")}/v1/terminals/${terminalId}/stream`,
      {
        headers: { origin, cookie: cookie ?? (await this.cookie()) },
      },
    );
    const view = new View(ws);
    await opened(ws);
    view.frame({ type: "hello", protocolVersion: PROTOCOL_VERSION, mode, ...size });
    return view;
  }

  /** Opens the event stream as a browser would, resuming after `cursor`. */
  async events(
    cursor: { epoch: string; eventId: number },
    opts: { origin?: string; host?: string; version?: string; path?: string; cookie?: string } = {},
  ): Promise<EventClient> {
    const query = new URLSearchParams({
      v: opts.version ?? PROTOCOL_VERSION,
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

  /**
   * Resolves once `stream` has delivered every event the store holds now. The store goes on
   * recording (agents report as they start, a stream's next page waits on its last write), so a
   * stream is never compared with a snapshot at one instant: it is waited for to reach one.
   */
  async caughtUp(stream: EventClient): Promise<void> {
    const { eventId } = StateSnapshot.parse((await this.request("/v1/state")).body);
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

  /** The agent's tmux session, found by the tag Bazhen wrote on it. */
  private session(agentId: string): string | undefined {
    return this.paneFact(agentId, "session_name");
  }

  /**
   * A tmux format value of the agent's pane, found by the tag Bazhen wrote on it: its agent id,
   * or with `tag`, another of its tags, such as a shell's terminal id.
   */
  paneFact(id: string, format: string, tag = "@bazhen_agent_id"): string | undefined {
    const panes = this.tmux("list-panes", "-a", "-F", `#{${tag}} #{${format}}`);
    return panes
      .split("\n")
      .find((l) => l.startsWith(`${id} `))
      ?.split(" ")[1];
  }

  /** The title the agent's TUI gave its pane. */
  paneTitle(agentId: string): string {
    return this.paneFact(agentId, "pane_title") ?? "";
  }

  /** The socket of the holder the agent's terminal runs on; none for one on tmux, or none yet. */
  holderOf(agentId: string): string | undefined {
    const db = new DatabaseSync(join(this.home, "data", "bazhen.db"), { readOnly: true });
    try {
      const row = db
        .prepare(
          `SELECT t.id, t.runtime FROM agent_sessions a JOIN terminals t ON t.id = a.terminal_id
           WHERE a.id = ?`,
        )
        .get(agentId);
      return row?.runtime === "holder"
        ? join(this.home, "run", "holders", `${String(row.id)}.sock`)
        : undefined;
    } finally {
      db.close();
    }
  }

  /** The title the agent's TUI set, from its holder or its tmux pane. */
  async title(agentId: string): Promise<string> {
    const holder = this.holderOf(agentId);
    return holder === undefined ? this.paneTitle(agentId) : (await holderLook(holder)).title;
  }

  /** What the agent's terminal shows, from its holder or its tmux pane; nothing before it has one. */
  async shows(agentId: string): Promise<string> {
    const holder = this.holderOf(agentId);
    if (holder === undefined) return this.screen(agentId);
    return existsSync(holder) ? (await holderLook(holder)).screen.join("\n") : "";
  }

  /** The environment the agent's process runs with, as its own tools see it (Linux only). */
  agentEnv(agentId: string): Record<string, string> {
    return processEnv(this.panePid(agentId));
  }

  /** The environment a shell terminal's process runs with (Linux only). */
  shellEnv(terminalId: string): Record<string, string> {
    return processEnv(Number(this.paneFact(terminalId, "pane_pid", "@bazhen_terminal_id")));
  }

  /** What a file in the work directory holds, or null when there is none. */
  workFile(name: string): string | null {
    const path = join(this.work, name);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  /** A shell terminal's process, as its pane's pid. */
  shellPid(terminalId: string): number {
    return Number(this.paneFact(terminalId, "pane_pid", "@bazhen_terminal_id"));
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
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [join(repo, "apps/daemon/src/main.ts")],
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
    const entry = join(repo, "apps/daemon/src/main.ts");
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

  /** The command line of the agent's process (Linux only). */
  agentCommand(agentId: string): string[] {
    return readFileSync(`/proc/${this.panePid(agentId)}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean);
  }

  /** Whether the agent still has a tmux session. */
  hasTerminal(agentId: string): boolean {
    return this.session(agentId) !== undefined;
  }

  /** The process tmux runs for the agent, as the agent's own tools would find it. */
  panePid(agentId: string): number {
    return Number(this.paneFact(agentId, "pane_pid"));
  }

  /**
   * Signals the agent's process from outside the daemon, as a user's `kill` would. host-guard
   * reaches it only once the private server confirms the pane still runs that process.
   */
  async signalAgent(agentId: string, signal: NodeJS.Signals): Promise<void> {
    const pane = this.paneFact(agentId, "pane_id") ?? "";
    const expected = {
      pid: this.paneFact(agentId, "pane_pid") ?? "",
      generation: this.paneFact(agentId, GENERATION_OPTION) ?? "",
    };
    signalPane(await this.tmuxServer.paneGroup(pane, expected), signal);
  }

  private requireSession(agentId: string): string {
    const session = this.session(agentId);
    if (session === undefined) throw new Error(`no terminal for ${agentId}`);
    return session;
  }

  /** Gives the agent's bound Claude Code session a conversation to resume (`giveTranscript`). */
  giveTranscript(agentId: string, sessionId: string): Promise<void> {
    return giveTranscript(this.home, PROTOCOL_VERSION, agentId, sessionId);
  }

  /** What the agent's terminal shows, or nothing while it has no terminal yet. */
  screen(agentId: string): string {
    return this.session(agentId) === undefined ? "" : this.capture(agentId);
  }

  /**
   * A terminal running `argv`: an agent is launched, then its program is replaced, so the
   * terminal is one the daemon knows and streams.
   */
  async program(argv: readonly string[]): Promise<{ agentId: string; terminalId: string }> {
    const launched = await this.launch(`program-${++programs}`);
    const ids = { agentId: launched.agentId, terminalId: String(launched.terminalId) };
    await waitUntil(() => this.session(ids.agentId) !== undefined, "the agent's terminal");
    this.runInTerminal(ids.agentId, argv);
    return ids;
  }

  /**
   * The visible screen and up to `history` lines above it, as tmux holds them; with `escapes`,
   * with the colours and attributes as escape sequences.
   */
  capture(agentId: string, history = 0, escapes = false): string {
    const session = this.requireSession(agentId);
    return this.tmux(
      "capture-pane",
      "-p",
      ...(escapes ? ["-e"] : []),
      "-t",
      session,
      "-S",
      `-${history}`,
    );
  }

  /** Where tmux has the program's cursor: column and row on the screen, from zero. */
  cursor(agentId: string): [number, number] {
    const session = this.requireSession(agentId);
    const out = this.tmux("display-message", "-p", "-t", session, "#{cursor_x} #{cursor_y}");
    const [x = 0, y = 0] = out.trim().split(" ").map(Number);
    return [x, y];
  }

  /** The screen row the program's cursor is on. */
  cursorRow(agentId: string): string {
    const session = this.requireSession(agentId);
    const [, row] = this.cursor(agentId);
    return this.tmux("capture-pane", "-p", "-t", session, "-S", `${row}`, "-E", `${row}`);
  }

  /**
   * Runs another program in the agent's terminal, as if the agent had started it. The terminal
   * Bazhen knows stays the same, so its stream serves the new program.
   */
  runInTerminal(agentId: string, argv: readonly string[]): void {
    this.tmux("respawn-pane", "-k", "-t", `${this.requireSession(agentId)}:0`, ...argv);
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

  /** Deletes the private server's socket under it, as a temp cleaner would; the server runs on. */
  tmuxSocketExists(): boolean {
    return existsSync(this.tmuxServer.socket);
  }

  deleteTmuxSocket(): void {
    rmSync(this.tmuxServer.socket);
  }

  /** Ends the agent's terminal, as if its tmux session had been killed by hand. */
  endTerminal(agentId: string): void {
    const session = this.session(agentId);
    if (session === undefined) throw new Error(`no terminal for ${agentId}`);
    this.tmux("kill-session", "-t", session);
  }

  /** Rewrites the Codex home's config.toml as its user would edit it; returns what it held. */
  editCodexConfig(edit: (config: string) => string): string {
    const file = join(this.home, "codex", "config.toml");
    const before = readFileSync(file, "utf8");
    writeFileSync(file, edit(before));
    return before;
  }

  /** Runs the Codex CLI on this daemon's Codex home, as its user would. */
  async codex(...args: string[]): Promise<void> {
    await run("codex", args, { env: this.env, timeout: 90_000 });
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
   * the `pnpm test:real` container.
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

  /** Detaches every tmux client from the agent's terminal, as if the client's tmux link broke. */
  detachClients(agentId: string): void {
    this.tmux("detach-client", "-s", this.requireSession(agentId));
  }

  /** Ends every holder still answering under its home, each by its own protocol. */
  private async closeHolders(): Promise<void> {
    await Promise.all(
      holderSockets(this.home).map((socket) =>
        // A socket a holder that died left behind has nothing to close.
        closeHolder(socket).catch(() => {}),
      ),
    );
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
    this.tmuxServer.killServer();
    await this.closeHolders();
    await codexStopped;
    // The agents' processes may still be writing their state as the server goes down.
    rmSync(this.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/**
 * The socket of each holder under `home`, as the daemon's holder runtime binds them. A holder runs
 * on after its daemon, as a terminal should.
 */
export function holderSockets(home: string): string[] {
  const dir = join(home, "run", "holders");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sock"))
    .map((name) => join(dir, name));
}

/**
 * Ends a terminal by its holder's own protocol, from outside the daemon, and resolves once the
 * holder hangs up: nothing is signalled. A holder answers one connection's requests in order, so
 * `close` is sent straight after `hello`, its replies unread.
 */
export async function closeHolder(socket: string): Promise<void> {
  const connection = createConnection(socket);
  const ended = once(connection, "close");
  connection.on("error", () => {});
  connection.write(
    encodeHolderRequest({ type: "hello", id: 1, body: { protocol: [HOLDER_PROTOCOL_VERSION] } }),
  );
  connection.write(encodeHolderRequest({ type: "close", id: 2 }));
  connection.resume();
  const timer = setTimeout(() => connection.destroy(new Error(`${socket} didn't close`)), 5_000);
  await ended.finally(() => clearTimeout(timer));
}

/** What a holder's terminal shows, read over the holder's own protocol, as a client would. */
export interface HolderLook {
  /** The title its program set last. */
  readonly title: string;
  /** The visible screen's lines, as a browser replaying its snapshot shows them. */
  readonly screen: string[];
  /** The screen line the cursor is on. */
  readonly cursorRow: string;
}

/**
 * Says `hello` to the holder at `socket` and asks for a snapshot, then hangs up. Nothing it asks
 * changes the terminal: no writer slot, no subscription.
 */
export async function holderLook(socket: string): Promise<HolderLook> {
  const connection = createConnection(socket);
  connection.on("error", () => {});
  const decoder = holderReplyDecoder();
  let hello: Extract<HolderReply, { type: "hello" }> | undefined;
  let snapshot: Extract<HolderReply, { type: "snapshot" }> | undefined;
  const answered = new Promise<void>((resolve, reject) => {
    connection.on("data", (chunk: Buffer) => {
      const { frames, malformed } = decoder.push(new Uint8Array(chunk));
      for (const frame of frames) {
        if (frame.type === "hello") hello = frame;
        if (frame.type === "snapshot") snapshot = { ...frame, bytes: frame.bytes.slice() };
      }
      if (malformed !== null) reject(new Error(`${socket} sent ${malformed}`));
      if (snapshot !== undefined) resolve();
    });
    connection.on("close", () => reject(new Error(`${socket} hung up before its snapshot`)));
  });
  connection.write(
    encodeHolderRequest({ type: "hello", id: 1, body: { protocol: [HOLDER_PROTOCOL_VERSION] } }),
  );
  connection.write(encodeHolderRequest({ type: "snapshot", id: 2 }));
  const timer = setTimeout(() => connection.destroy(new Error(`${socket} didn't answer`)), 5_000);
  try {
    await answered;
  } finally {
    clearTimeout(timer);
    connection.end();
  }
  if (hello === undefined || snapshot === undefined) throw new Error(`${socket} said no hello`);
  const shown = await replay(snapshot.bytes, hello.body.size);
  return {
    title: hello.body.title,
    screen: shown.screen,
    cursorRow: shown.screen[shown.cursor[1]] ?? "",
  };
}

/**
 * Submits `text` to the program on the holder at `socket` as `Daemon.prompt` does, typing over a
 * writer connection of its own: for while no daemon holds the writer slot, as when it is down.
 */
export async function promptHolder(socket: string, text: string): Promise<void> {
  const connection = createConnection(socket);
  connection.on("error", () => {});
  const decoder = holderReplyDecoder();
  const writer = new Promise<boolean>((resolve, reject) => {
    connection.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(new Uint8Array(chunk)).frames)
        if (frame.type === "hello") resolve(frame.body.writer);
    });
    connection.on("close", () => reject(new Error(`${socket} hung up before hello`)));
  });
  const hello = { protocol: [HOLDER_PROTOCOL_VERSION], writer: true };
  connection.write(encodeHolderRequest({ type: "hello", id: 1, body: hello }));
  try {
    if (!(await writer)) throw new Error(`${socket} gave its writer slot to another connection`);
    const type = (id: number, input: string) =>
      connection.write(encodeHolderRequest({ type: "input", id, bytes: Buffer.from(input) }));
    const atCursor = async () => (await holderLook(socket)).cursorRow.split(text).length - 1;
    const before = await atCursor();
    type(2, text);
    await waitUntil(
      async () => (await atCursor()) > before,
      "the typed prompt on the cursor's row",
    );
    type(3, "\r");
    await new Promise<void>((resolve) => connection.end(resolve));
  } finally {
    connection.destroy();
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
  private snapshotEnd: number | undefined;
  private readonly ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: Buffer, binary: boolean) => {
      if (binary) {
        this.raw.push(data);
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

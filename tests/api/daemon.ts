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
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { GENERATION_OPTION, signalPane, TmuxServer } from "@bazhen/host-guard";
import {
  EventFrame,
  LaunchAgentResponse,
  PROTOCOL_VERSION,
  StreamServerFrame,
} from "@bazhen/protocol";
import { agentHomes, codexDaemonStarted, loginEnv } from "../support/agent-env.ts";
import { replay } from "./fixtures/browser.ts";

const run = promisify(execFile);

/** What each harness's TUI shows once it has started. */
export const BANNER = { "claude-code": "Claude Code", codex: "OpenAI Codex" } as const;

/** The size the daemon gives every agent's terminal. */
const SIZE = { cols: 120, rows: 40 };

const repo = fileURLToPath(new URL("../..", import.meta.url));
const bin = fileURLToPath(new URL("node_modules/.bin", import.meta.url));

async function freePort(): Promise<number> {
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
      ["--disable-warning=ExperimentalWarning", join(repo, "apps/cli/src/main.ts"), ...args],
      { env, timeout: 30_000 },
      (err, stdout, stderr) =>
        resolve({ code: err === null ? 0 : Number(err.code ?? 1), out: stdout + stderr }),
    );
  });
}

/** A daemon's environment on `home`: the login session's, and nothing of the test run's. */
function homeEnv(home: string): Record<string, string> {
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
    TmuxServer.at(join(home, "run", "tmux.sock"), { root: home }).kill();
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

export interface DaemonOptions {
  /** The fake Anthropic API's base URL, for Claude Code. */
  readonly modelUrl?: string;
  /** The fake Responses API's base URL, for Codex. */
  readonly responsesUrl?: string;
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

  private constructor(home: string, opts: DaemonOptions) {
    this.home = home;
    this.work = join(home, "work");
    this.tmuxServer = TmuxServer.at(join(home, "run", "tmux.sock"), { root: home });
    mkdirSync(this.work, { recursive: true });

    this.env = {
      ...homeEnv(home),
      PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      ...agentHomes(home, this.work, { anthropic: opts.modelUrl, responses: opts.responsesUrl }),
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
    mkdirSync(join(daemon.home, "config"), { recursive: true });
    writeFileSync(join(daemon.home, "config", "config.toml"), config);
    const started = await bazhen(["start"], { ...daemon.env, ...env });
    if (started.code !== 0) {
      await daemon.stop();
      throw new Error(`bazhen start failed:\n${started.out}`);
    }
    return daemon;
  }

  /** Launches an agent in the work directory, keyed by `key`. */
  async launch(
    key: string,
    harness: "claude-code" | "codex" = "claude-code",
  ): Promise<LaunchAgentResponse> {
    const res = await this.request("/v1/agents", {
      method: "POST",
      body: { idempotencyKey: key, harness, cwd: this.work },
    });
    return LaunchAgentResponse.parse(res.body);
  }

  /**
   * Submits a prompt in an agent's TUI through a view, as a person would. Enter waits until the
   * text has drawn, so the TUI doesn't read both as one paste.
   */
  async prompt(launched: { agentId: string; terminalId: string | null }, text: string) {
    const view = await this.view(String(launched.terminalId), "interactive");
    await view.drive();
    view.type(text);
    await waitUntil(() => this.screen(launched.agentId).includes(text), "the typed prompt");
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
    const child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(repo, "apps/daemon/src/main.ts")],
      { env: { ...this.env, BAZHEN_PORT: String(this.port) }, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.process = child;
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    for (let i = 0; i < 100 && child.exitCode === null; i++) {
      if (
        await fetch(`${this.url}/v1/health`).then(
          (r) => r.ok,
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
    throw new Error(`the daemon did not start:\n${output}`);
  }

  async request(path: string, init: { method?: string; body?: unknown; origin?: string } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.origin !== undefined) headers["origin"] = init.origin;
    const res = await fetch(`${this.url}${path}`, {
      method: init.method ?? "GET",
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
  ): Promise<View> {
    const ws = new WebSocket(
      `${this.url.replace("http", "ws")}/v1/terminals/${terminalId}/stream`,
      {
        headers: { origin },
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
    opts: { origin?: string; version?: string; path?: string } = {},
  ): Promise<EventClient> {
    const query = new URLSearchParams({
      v: opts.version ?? PROTOCOL_VERSION,
      epoch: cursor.epoch,
      after: String(cursor.eventId),
    });
    const ws = new WebSocket(
      `${this.url.replace("http", "ws")}${opts.path ?? "/v1/events"}?${query}`,
      {
        headers: { origin: opts.origin ?? this.url },
      },
    );
    const client = new EventClient(ws);
    await opened(ws);
    return client;
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

  /** A tmux format value of the agent's pane, found by the tag Bazhen wrote on it. */
  private paneFact(agentId: string, format: string): string | undefined {
    const panes = this.tmux("list-panes", "-a", "-F", `#{@bazhen_agent_id} #{${format}}`);
    return panes
      .split("\n")
      .find((l) => l.startsWith(`${agentId} `))
      ?.split(" ")[1];
  }

  /** The title the agent's TUI gave its pane. */
  paneTitle(agentId: string): string {
    return this.paneFact(agentId, "pane_title") ?? "";
  }

  /** The environment the agent's process runs with, as its own tools see it (Linux only). */
  agentEnv(agentId: string): Record<string, string> {
    const environ = readFileSync(`/proc/${this.panePid(agentId)}/environ`, "utf8");
    return Object.fromEntries(
      environ
        .split("\0")
        .filter((entry) => entry.includes("="))
        .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
    );
  }

  /**
   * Runs a second daemon on this home, straight from its entry point rather than through
   * `bazhen start`'s own check, and resolves with how it exited and what it printed.
   */
  startAnother(): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", join(repo, "apps/daemon/src/main.ts")],
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

  /** The visible screen and up to `history` lines above it, as tmux holds them. */
  capture(agentId: string, history = 0): string {
    return this.tmux("capture-pane", "-p", "-t", this.requireSession(agentId), "-S", `-${history}`);
  }

  /** Where tmux has the program's cursor: column and row on the screen, from zero. */
  cursor(agentId: string): [number, number] {
    const session = this.requireSession(agentId);
    const out = this.tmux("display-message", "-p", "-t", session, "#{cursor_x} #{cursor_y}");
    const [x = 0, y = 0] = out.trim().split(" ").map(Number);
    return [x, y];
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

  /** Ends the agent's terminal, as if its tmux session had been killed by hand. */
  endTerminal(agentId: string): void {
    const session = this.session(agentId);
    if (session === undefined) throw new Error(`no terminal for ${agentId}`);
    this.tmux("kill-session", "-t", session);
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
  async kill(): Promise<void> {
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
      child.kill(signal);
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

  /** Stops the daemon, its tmux server and every file under its home. */
  async stop(): Promise<void> {
    await this.exit("SIGTERM");
    // A daemon `bazhen start` detached is not this process's child.
    await bazhen(["stop"], this.env);
    // Codex's managed daemon outlives its clients; only its own stop ends it.
    const codexStopped = codexDaemonStarted(this.home)
      ? run("codex", ["app-server", "daemon", "stop"], { env: this.env, timeout: 90_000 })
      : undefined;
    this.tmuxServer.kill();
    await codexStopped;
    // The agents' processes may still be writing their state as the server goes down.
    rmSync(this.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
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

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: Buffer) => {
      this.frames.push(EventFrame.parse(JSON.parse(data.toString("utf8"))));
    });
    ws.on("close", () => (this.closed = true));
  }

  /** The ids of the events received, in the order they arrived. */
  ids(): number[] {
    return this.frames.flatMap((f) => (f.type === "event" ? [f.event.id] : []));
  }

  types(): string[] {
    return this.frames.flatMap((f) => (f.type === "event" ? [f.event.type] : []));
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

// Runs the daemon as a separate process and reaches it only as a client would: over HTTP,
// WebSocket and tmux. Nothing here imports the daemon's code, so the same tests can certify a
// daemon written in another language.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, StreamServerFrame } from "@bazhen/protocol";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const bin = fileURLToPath(new URL("node_modules/.bin", import.meta.url));
const DUMMY_KEY = "sk-ant-api-tests-00000000000000000000000000";

/** Only what a login session provides; never the developer's real model credentials. */
const BASE_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TMUX_TMPDIR"];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

let instances = 0;

/** Waits for a condition outside a test, where `expect.poll` can't run. */
export async function waitUntil(condition: () => boolean, what: string, timeoutMs = 20_000) {
  for (const start = Date.now(); Date.now() - start < timeoutMs;) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export class Daemon {
  readonly home: string;
  readonly work: string;
  readonly tmuxSocket: string;
  private readonly env: Record<string, string>;
  private port = 0;
  private process: ChildProcess | undefined;

  private constructor(home: string) {
    this.home = home;
    this.work = join(home, "work");
    this.tmuxSocket = `bz-test-${process.env["BZ_TEST_RUN"] ?? process.pid}-api-${++instances}`;
    const claudeConfig = join(home, "claude");
    mkdirSync(this.work, { recursive: true });
    mkdirSync(claudeConfig, { recursive: true });
    // Onboarding done, the work directory trusted and the dummy key approved, so the real TUI
    // starts without a prompt. Trust is keyed by the real path.
    writeFileSync(
      join(claudeConfig, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        customApiKeyResponses: { approved: [DUMMY_KEY.slice(-20)], rejected: [] },
        projects: {
          [this.work]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
        },
      }),
    );
    // Ask before tools run, whatever mode a machine's managed settings would pick.
    writeFileSync(
      join(claudeConfig, "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "default" } }),
    );
    const base = Object.fromEntries(
      BASE_ENV.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]]])),
    );
    this.env = {
      ...base,
      PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      BAZHEN_HOME: home,
      BAZHEN_TMUX_SOCKET: this.tmuxSocket,
      CLAUDE_CONFIG_DIR: claudeConfig,
      ANTHROPIC_API_KEY: DUMMY_KEY,
      // Nothing listens here: these tests never let the agent reach a model.
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      DISABLE_AUTOUPDATER: "1",
    };
  }

  /** A daemon on a fresh home. Short paths keep its socket under sun_path's limit. */
  static async start(): Promise<Daemon> {
    const daemon = new Daemon(realpathSync(mkdtempSync("/tmp/bz-api-")));
    await daemon.spawn();
    return daemon;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
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
      )
        return;
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
    const body: unknown = await res.json();
    return { status: res.status, body };
  }

  /** Opens a view of a terminal as a browser would, from the daemon's own origin by default. */
  async view(
    terminalId: string,
    mode: "observe" | "interactive",
    origin = this.url,
  ): Promise<View> {
    const ws = new WebSocket(
      `${this.url.replace("http", "ws")}/v1/terminals/${terminalId}/stream`,
      {
        headers: { origin },
      },
    );
    const view = new View(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("unexpected-response", (_req, res) =>
        reject(new Error(`refused: ${res.statusCode}`)),
      );
      ws.once("error", reject);
    });
    view.frame({ type: "hello", protocolVersion: PROTOCOL_VERSION, mode, cols: 100, rows: 30 });
    return view;
  }

  tmux(...args: string[]): string {
    return execFileSync("tmux", ["-L", this.tmuxSocket, ...args], {
      env: { ...process.env, TMUX: "" },
    }).toString();
  }

  /** What the agent's terminal shows, found by the tag Bazhen wrote on its tmux session. */
  screen(agentId: string): string {
    const panes = this.tmux("list-panes", "-a", "-F", "#{@bazhen_agent_id} #{session_name}");
    const session = panes
      .split("\n")
      .find((l) => l.startsWith(`${agentId} `))
      ?.split(" ")[1];
    return session === undefined ? "" : this.tmux("capture-pane", "-p", "-t", session);
  }

  /** Stops the daemon, its tmux server and every file under its home. */
  async stop(): Promise<void> {
    const child = this.process;
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGTERM");
      });
    }
    try {
      this.tmux("kill-server");
    } catch {
      // No server was ever started.
    }
    // The agents' processes may still be writing their state as the server goes down.
    rmSync(this.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** One open stream: everything the daemon sent it, and a way to type. */
export class View {
  readonly frames: StreamServerFrame[] = [];
  private bytes = "";
  private readonly ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: Buffer, binary: boolean) => {
      if (binary) this.bytes += data.toString("utf8");
      else this.frames.push(StreamServerFrame.parse(JSON.parse(data.toString("utf8"))));
    });
  }

  /** The terminal output this view has received, escape sequences included. */
  output(): string {
    return this.bytes;
  }

  frame(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  type(text: string): void {
    this.ws.send(Buffer.from(text), { binary: true });
  }

  close(): void {
    this.ws.close();
  }
}

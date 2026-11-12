// Run-scoped sandbox for the Codex app-server probes.
// - A temporary HOME and CODEX_HOME, so nothing reaches the user's ~/.codex or their daemon.
// - The fake Responses provider on a free loopback port.
// - An app-server started explicitly with `--listen unix://`, never `daemon start`: the managed
//   daemon runs its own auto-update loop, which may fetch a release.
// - A private tmux server (own TMUX_TMPDIR, -L bz-spike-*), driven by send-keys/capture-pane.
// - Refuses to start near the macOS PTY limit; kills everything it started on exit.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "./rpc-client.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PTY_CUTOFF = 420;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function ptysInUse(): number {
  return readdirSync("/dev").filter((name) => name.startsWith("ttys")).length;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export type Home = { root: string; home: string; codexHome: string; work: string; env: NodeJS.ProcessEnv };

export class Run {
  readonly id: string;
  readonly dir: string;
  readonly runLog: string;
  readonly tmuxDir: string;
  readonly tmuxSocket: string;
  readonly homes: Home[] = [];
  private readonly children: ChildProcess[] = [];
  private readonly clients: RpcClient[] = [];
  providerPort = 0;
  providerLog = "";

  private constructor(name: string) {
    const used = ptysInUse();
    if (used > PTY_CUTOFF) throw new Error(`Refusing to run: ${used} PTYs in use (> ${PTY_CUTOFF})`);
    this.id = `${name}-${process.pid}`;
    // Under /tmp, not os.tmpdir(): Unix socket paths must stay under ~104 bytes on macOS.
    this.dir = mkdtempSync(`/tmp/bz-spike-${name}-`);
    mkdirSync(join(here, "runs"), { recursive: true });
    this.runLog = join(here, "runs", `${this.id}.jsonl`);
    writeFileSync(this.runLog, "");
    this.tmuxDir = mkdtempSync("/tmp/bz-tmux-");
    this.tmuxSocket = `bz-spike-${this.id}`;
    const onSignal = () => {
      this.cleanup();
      process.exit(130);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  static async start(name: string): Promise<Run> {
    const run = new Run(name);
    await run.startProvider();
    return run;
  }

  log(event: string, data: object = {}): void {
    const line = { ts: new Date().toISOString(), event, ...data };
    appendFileSync(this.runLog, `${JSON.stringify(line)}\n`);
    console.log(`[${event}]`, JSON.stringify(data).slice(0, 400));
  }

  private async startProvider(): Promise<void> {
    this.providerPort = await freePort();
    this.providerLog = join(this.dir, "provider.jsonl");
    const p = spawn(process.execPath, [join(here, "fake-provider.ts"), String(this.providerPort), this.providerLog], {
      stdio: "ignore",
    });
    this.children.push(p);
    await sleep(500);
  }

  /** A fresh, isolated Codex home configured for the fake provider. */
  makeHome(label = `h${this.homes.length}`): Home {
    const root = join(this.dir, label);
    const home = join(root, "home");
    const codexHome = join(root, "codex");
    const work = join(root, "work");
    for (const d of [home, codexHome, work]) mkdirSync(d, { recursive: true });
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        `approvals_reviewer = "user"`,
        `model = "fake-model"`,
        `model_provider = "fake"`,
        `approval_policy = "on-request"`,
        `sandbox_mode = "read-only"`,
        `check_for_update_on_startup = false`,
        // File stores: with the keyring default, Codex looks up a login keychain, and macOS
        // raises "keychain not found" errors when that lookup misses.
        `cli_auth_credentials_store = "file"`,
        `mcp_oauth_credentials_store = "file"`,
        ``,
        `[model_providers.fake]`,
        `name = "fake"`,
        `base_url = "http://127.0.0.1:${this.providerPort}/v1"`,
        `wire_api = "responses"`,
        `env_key = "BZ_FAKE_KEY"`,
        `requires_openai_auth = false`,
        ``,
        `[projects."${work}"]`,
        `trust_level = "trusted"`,
        ``,
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // HOME stays the user's: a temporary HOME has no login keychain. CODEX_HOME alone moves
      // every Codex path (config, sessions, sockets, daemon package) into the run directory.
      CODEX_HOME: codexHome,
      BZ_FAKE_KEY: "dummy",
      TMUX_TMPDIR: this.tmuxDir,
    };
    delete env["TMUX"];
    const h = { root, home, codexHome, work, env };
    this.homes.push(h);
    return h;
  }

  /** `codex app-server --listen unix://<sock>` for one home. Returns the process and socket. */
  async startAppServer(h: Home, sockName = "as.sock"): Promise<{ proc: ChildProcess; sock: string }> {
    const sock = join(h.root, sockName);
    const proc = spawn("codex", ["app-server", "--listen", `unix://${sock}`], {
      env: h.env,
      cwd: h.work,
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.stderr?.on("data", (d: Buffer) => appendFileSync(join(h.root, "app-server.log"), d));
    this.children.push(proc);
    for (let i = 0; i < 50; i++) {
      try {
        readdirSync(h.root).includes(sockName) && execFileSync("test", ["-S", sock]);
        await sleep(300);
        return { proc, sock };
      } catch {
        await sleep(200);
      }
    }
    throw new Error(`app-server socket ${sock} never appeared`);
  }

  async client(name: string, h: Home, sock: string): Promise<RpcClient> {
    const c = new RpcClient({ name, sock, env: h.env, logFile: this.runLog });
    this.clients.push(c);
    await c.initialize();
    return c;
  }

  tmux(...args: string[]): string {
    const env = { ...process.env, TMUX_TMPDIR: this.tmuxDir };
    delete env["TMUX"];
    return execFileSync("tmux", ["-L", this.tmuxSocket, "-f", "/dev/null", ...args], {
      env,
      encoding: "utf8",
    });
  }

  /** Starts a TUI in its own tmux window, with the home's environment. */
  startTui(h: Home, window: string, codexArgs: string[]): void {
    const envArgs = ["CODEX_HOME", "BZ_FAKE_KEY"].flatMap((k) => ["-e", `${k}=${h.env[k] ?? ""}`]);
    const cmd = ["codex", ...codexArgs].map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ");
    const hasServer = (() => {
      try {
        this.tmux("has-session");
        return true;
      } catch {
        return false;
      }
    })();
    if (!hasServer) {
      this.tmux("new-session", "-d", "-x", "160", "-y", "45", "-s", "spike", "-n", "init", "sleep 86400");
      this.tmux("set-option", "-g", "remain-on-exit", "on");
    }
    this.tmux("new-window", "-d", ...envArgs, "-n", window, "-c", h.work, cmd);
    this.log("tui.start", { window, codexArgs });
  }

  capture(window: string): string {
    return this.tmux("capture-pane", "-p", "-t", `spike:${window}`);
  }

  keys(window: string, ...keys: string[]): void {
    this.tmux("send-keys", "-t", `spike:${window}`, ...keys);
  }

  /** Types literal text, then presses Enter after a pause so the TUI doesn't read a paste. */
  type(window: string, text: string): void {
    this.tmux("send-keys", "-t", `spike:${window}`, "-l", text);
    execFileSync("sleep", ["0.8"]);
    this.tmux("send-keys", "-t", `spike:${window}`, "Enter");
  }

  async waitScreen(window: string, re: RegExp, timeoutMs = 20000): Promise<string> {
    const end = Date.now() + timeoutMs;
    let screen = "";
    while (Date.now() < end) {
      screen = this.capture(window);
      if (re.test(screen)) return screen;
      await sleep(300);
    }
    throw new Error(`screen ${window} never matched ${re}; last screen:\n${screen}`);
  }

  snapshot(window: string, label: string): string {
    const screen = this.capture(window);
    writeFileSync(join(here, "runs", `${this.id}.${label}.txt`), screen);
    this.log("screen", { window, label, lines: screen.split("\n").filter((l) => l.trim()).slice(-12) });
    return screen;
  }

  providerTurns(): { userMessages: string[]; reply: string; lastType: string }[] {
    try {
      return execFileSync("cat", [this.providerLog], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e: { kind: string }) => e.kind === "turn");
    } catch {
      return [];
    }
  }

  /** Processes whose command line mentions this run's directory (servers, TUIs, proxies). */
  leftovers(): string[] {
    try {
      return execFileSync("pgrep", ["-fl", this.dir], { encoding: "utf8" }).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  cleanup(): void {
    for (const c of this.clients) c.close();
    try {
      this.tmux("kill-server");
    } catch {
      // no server
    }
    for (const p of this.children) p.kill("SIGTERM");
    for (const signal of ["-TERM", "-KILL"]) {
      try {
        execFileSync("pkill", [signal, "-f", this.dir]);
        execFileSync("sleep", ["1"]);
      } catch {
        // nothing left
      }
    }
    rmSync(this.tmuxDir, { recursive: true, force: true });
    const left = this.leftovers();
    if (left.length) console.error("LEFTOVER PROCESSES:", left);
    console.log(`run log: ${this.runLog}`);
  }
}

// Run-scoped harness: temp dirs, the fake API, a private tmux server, cleanup and leak checks.
// Nothing here reads or writes the user's own Claude Code config or default tmux server.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const CLAUDE = process.env.BZ_SPIKE_CLAUDE ?? "claude";
export const PTY_ABORT = 420;
export const DUMMY_KEY = "sk-ant-fake-spike-0000000000000000000000";

/** Every hook event in the pinned binary's canonical list (its `rc` array). */
export const ALL_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Notification",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PreModelSwitch",
  "PostModelSwitch",
  "PermissionRequest",
  "PermissionDenied",
  "Setup",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "WorktreeCreate",
  "WorktreeRemove",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged",
  "DirectoryAdded",
  "MessageDisplay",
] as const;
/** Events whose hook entries take a tool-name matcher. */
const MATCHER_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
]);

/**
 * The environment every tmux call (and so the server and every pane) starts from. A tmux server
 * copies the full environment of the client that starts it, so without this the probed Claude
 * Code inherits this session's CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION and
 * messaging-socket variables.
 */
export function baseEnv(): Record<string, string> {
  const keep = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|TMPDIR|TZ)$/;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (keep.test(k) && v !== undefined) out[k] = v;
  return out;
}

export function ptyCount(): number {
  return readdirSync("/dev").filter((f) => /^ttys\d+$/.test(f)).length;
}

export type HookEntry = Record<string, unknown>;
export type Hooks = Record<string, { matcher?: string; hooks: HookEntry[] }[]>;
export type Recorded = {
  event: string;
  received_at: string;
  pid: number;
  payload: Record<string, unknown>;
};

export const node = (script: string, ...args: string[]) =>
  ["node", "--disable-warning=ExperimentalWarning", join(HERE, script), ...args].join(" ");

/** One recorder entry per event, plus any extra entries the probe adds. */
export function recordingHooks(extra: Hooks = {}, events: readonly string[] = ALL_EVENTS): Hooks {
  const out: Hooks = {};
  for (const ev of events) {
    const group: { matcher?: string; hooks: HookEntry[] } = {
      hooks: [{ type: "command", command: node("hooks/record.ts", ev), timeout: 10 }],
    };
    if (MATCHER_EVENTS.has(ev)) group.matcher = "*";
    out[ev] = [group];
  }
  for (const [ev, groups] of Object.entries(extra)) out[ev] = [...(out[ev] ?? []), ...groups];
  return out;
}

/** asyncRewake waiter entries for the given events. */
export function waiterHooks(events: string[] = ["SessionStart", "Stop"], timeout = 86400): Hooks {
  const out: Hooks = {};
  for (const ev of events)
    out[ev] = [{ hooks: [{ type: "command", command: node("hooks/waiter.ts", ev), asyncRewake: true, timeout }] }];
  return out;
}

const USER_FILES = [
  join(homedir(), ".claude", "settings.json"),
  join(homedir(), ".claude.json"),
  join(homedir(), ".claude", "projects"),
  join(homedir(), ".local", "state", "triage"),
];

export function snapshotUserFiles(): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const f of USER_FILES) out[f] = existsSync(f) ? statSync(f).mtimeMs : null;
  return out;
}

export class Run {
  readonly id: string;
  readonly dir: string;
  readonly config: string;
  readonly work: string;
  readonly socket: string;
  readonly hooksFile: string;
  readonly requestsFile: string;
  readonly sock: string;
  port = 0;
  private fake?: ChildProcess;
  private userBefore = snapshotUserFiles();
  private ptyBefore = ptyCount();

  constructor(label: string) {
    if (this.ptyBefore > PTY_ABORT)
      throw new Error(`Refusing to run: ${this.ptyBefore} PTYs in use (limit ${PTY_ABORT})`);
    this.dir = realpathSync(mkdtempSync(join(tmpdir(), `bz-spike-${label}-`)));
    this.id = this.dir.split("-").pop()!;
    this.config = join(this.dir, "config");
    this.work = join(this.dir, "work");
    for (const d of [this.config, this.work]) mkdirSync(d, { recursive: true });
    this.socket = `bz-spike-${label}-${this.id}`;
    this.hooksFile = join(this.dir, "hooks.jsonl");
    this.requestsFile = join(this.dir, "requests.jsonl");
    this.sock = `/tmp/bz30-${this.id}.sock`;
    writeFileSync(this.hooksFile, "");
    writeFileSync(this.requestsFile, "");
    this.seedConfig();
  }

  /** Global config with onboarding done, the work dir trusted and the dummy key approved. */
  private seedConfig() {
    const cfg = {
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.322",
      theme: "dark",
      customApiKeyResponses: { approved: [DUMMY_KEY.slice(-20)], rejected: [] },
      projects: {
        [this.work]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      },
    };
    writeFileSync(join(this.config, ".claude.json"), JSON.stringify(cfg, null, 2));
  }

  async startFake() {
    const portFile = join(this.dir, "fake.port");
    this.fake = spawn(
      "node",
      [
        "--disable-warning=ExperimentalWarning",
        join(HERE, "fake-anthropic.ts"),
        "--log",
        this.requestsFile,
        "--port-file",
        portFile,
      ],
      { stdio: "ignore" },
    );
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(50);
    this.port = Number(readFileSync(portFile, "utf8"));
    if (!this.port) throw new Error("fake API did not start");
  }

  writeSettings(hooks: Hooks, extra: Record<string, unknown> = {}) {
    const path = join(this.dir, "settings.json");
    writeFileSync(path, JSON.stringify({ hooks, ...extra }, null, 2));
    return path;
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      // HOME stays the real one: Claude Code runs `security find-generic-password`, and a fake
      // HOME makes macOS report "keychain not found". CLAUDE_CONFIG_DIR alone isolates config.
      HOME: process.env.HOME ?? "",
      CLAUDE_CONFIG_DIR: this.config,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${this.port}`,
      ANTHROPIC_API_KEY: DUMMY_KEY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      BZ_SPIKE_DIR: this.dir,
      BZ_SPIKE_SOCK: this.sock,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TERM: "xterm-256color",
      ...extra,
    };
  }

  tmux(...args: string[]): string {
    return execFileSync("tmux", ["-L", this.socket, "-f", "/dev/null", ...args], {
      encoding: "utf8",
      env: baseEnv(),
    });
  }

  /** Start `claude` in window `name` of the private server. */
  launch(name: string, claudeArgs: string[], env: Record<string, string> = {}) {
    const envFlags = Object.entries(this.env(env)).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const settings = join(this.dir, "settings.json");
    const cmd = [
      CLAUDE,
      // --strict-mcp-config is refused when an enterprise MCP config is present.
      "--permission-mode",
      "default",
      "--setting-sources",
      "project",
      "--settings",
      settings,
      ...claudeArgs,
    ]
      .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
      .join(" ");
    const stderr = join(this.dir, `claude-${name}.stderr`);
    const wrapped = `exec ${cmd} 2>>'${stderr}'`;
    if (!this.serverAlive()) {
      // A holder window keeps the server up and lets remain-on-exit apply before claude starts.
      this.tmux("new-session", "-d", "-s", "spike", "-n", "hold", "-x", "200", "-y", "50", "sleep 86400");
      this.tmux("set-option", "-g", "remain-on-exit", "on");
    }
    this.tmux("new-window", "-d", "-n", name, "-c", this.work, ...envFlags, wrapped);
  }

  keys(name: string, ...keys: string[]) {
    this.tmux("send-keys", "-t", `spike:${name}`, ...keys);
  }

  /** Type literal text, then press Enter as a separate key. */
  async type(name: string, text: string) {
    this.tmux("send-keys", "-t", `spike:${name}`, "-l", text);
    await sleep(300);
    this.tmux("send-keys", "-t", `spike:${name}`, "Enter");
  }

  capture(name: string): string {
    return this.tmux("capture-pane", "-p", "-t", `spike:${name}`);
  }

  panePid(name: string): number {
    return Number(this.tmux("display-message", "-p", "-t", `spike:${name}`, "#{pane_pid}").trim());
  }

  hooks(): Recorded[] {
    return readFileSync(this.hooksFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Recorded);
  }

  waiterLog(): Record<string, unknown>[] {
    const f = join(this.dir, "waiter.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  /** The first logged request whose messages contain `needle`, with the block that holds it. */
  findInRequests(needle: string): { index: number; role: string; text: string; position: string } | undefined {
    const reqs = this.requests();
    for (let i = 0; i < reqs.length; i++) {
      const body = reqs[i]!.body as { messages?: { role: string; content: unknown }[] } | undefined;
      const msgs = body?.messages ?? [];
      for (let m = 0; m < msgs.length; m++) {
        const c = msgs[m]!.content;
        const blocks = typeof c === "string" ? [{ type: "text", text: c }] : (c as Record<string, unknown>[]);
        for (const b of blocks) {
          const t = JSON.stringify(b);
          if (t.includes(needle))
            return { index: i, role: msgs[m]!.role, text: t.slice(0, 600), position: `message ${m + 1}/${msgs.length}` };
        }
      }
    }
    return undefined;
  }

  requests(): Record<string, unknown>[] {
    return readFileSync(this.requestsFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  async waitFor<T>(what: string, fn: () => T | undefined | false, timeoutMs = 30_000): Promise<T> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  /** Wait until `count` events named `event` have been recorded (after `since` entries). */
  waitEvent(event: string, since = 0, timeoutMs = 30_000, count = 1) {
    return this.waitFor(
      `${event} hook`,
      () => {
        const got = this.hooks().slice(since).filter((h) => h.event === event);
        return got.length >= count ? got[count - 1] : undefined;
      },
      timeoutMs,
    );
  }

  serverAlive(): boolean {
    try {
      execFileSync("tmux", ["-L", this.socket, "list-sessions"], { stdio: "ignore", env: baseEnv() });
      return true;
    } catch {
      return false;
    }
  }

  /** Kill the private tmux server and the fake; report leaks and any change to user files. */
  async cleanup(): Promise<{ leaks: string[]; userFilesChanged: string[] }> {
    try {
      this.tmux("kill-server");
    } catch {}
    this.fake?.kill();
    await sleep(500);
    const leaks: string[] = [];
    if (this.serverAlive()) leaks.push(`tmux server ${this.socket} still alive`);
    const sockPath = join(`/private/tmp/tmux-${process.getuid?.() ?? 0}`, this.socket);
    if (!this.serverAlive()) rmSync(sockPath, { force: true });
    if (existsSync(sockPath)) leaks.push(`socket ${sockPath} left behind`);
    const after = snapshotUserFiles();
    const userFilesChanged = Object.keys(after).filter((k) => after[k] !== this.userBefore[k]);
    return { leaks, userFilesChanged };
  }
}

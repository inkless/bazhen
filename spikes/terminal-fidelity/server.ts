// Throwaway "daemon" for Spike C: one PTY-attached `tmux attach` client per viewed terminal,
// fanned out to every browser view, with a daemon-side headless emulator for the attach snapshot
// and a minimal driver lease that sizes the window (FD §4.2, §4.3, §5.3, §5.4).
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { spawn, type IPty } from "node-pty";
import { WebSocketServer, type WebSocket } from "ws";
import xtermHeadless from "@xterm/headless";
import serializePkg from "@xterm/addon-serialize";

const { Terminal: Headless } = xtermHeadless;
const { SerializeAddon } = serializePkg;
const run = promisify(execFile);

const PORT = Number(process.env["PORT"] ?? 7681);
const SOCKET = process.env["BZ_SPIKE_SOCKET"] ?? `bz-spike-c-${process.pid}`;
const HISTORY_LINES = 2000;
const PTY_ABORT_AT = 420;
const work = mkdtempSync(join(tmpdir(), "bz-spike-c-"));
const configFile = join(work, "tmux.conf");

// Copied from packages/runtime-tmux/src/index.ts (TMUX_CONFIG). Spike-only additions are below the
// marker and are findings in their own right; see notes.md.
const TMUX_CONFIG = `set -g prefix None
set -g prefix2 None
unbind-key -a -T prefix
unbind-key -a -T root
unbind-key -a -T copy-mode
unbind-key -a -T copy-mode-vi
set -g status off
set -g remain-on-exit on
set -g escape-time 0
set -g default-terminal tmux-256color
set -g extended-keys on
set -g focus-events on
set -g set-clipboard on
set -as terminal-features ",xterm-256color:RGB:extkeys:clipboard:hyperlinks:focus"
`;
// Who answers tmux's attach-time queries (DA1, DA2, XTVERSION, OSC 10/11): the daemon's headless
// emulator, or each browser's xterm.js. See notes.md#findings (lone Esc held 500 ms).
const REPLIES = (process.env["BZ_SPIKE_REPLIES"] ?? "daemon") as "daemon" | "browser";
const SPIKE_EXTRA = process.env["BZ_SPIKE_TMUX_EXTRA"] ?? "";
writeFileSync(configFile, TMUX_CONFIG + SPIKE_EXTRA + "\n", { mode: 0o600 });

// The tmux server's global environment is copied from whichever process starts it, and every pane
// inherits it. Start it from an allowlist, never from the daemon's own environment (notes.md, F7).
const ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TMPDIR|TZ)$/;
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && ENV_ALLOW.test(k)) env[k] = v;
  return { ...env, ...extra };
}
const CLEAN_ENV = process.env["BZ_SPIKE_DIRTY_ENV"] === "1" ? undefined : cleanEnv();

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await run("tmux", ["-L", SOCKET, "-f", configFile, ...args], {
    env: CLEAN_ENV,
    timeout: 5000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function escapeTrailingSemicolon(arg: string): string {
  return arg.endsWith(";") ? `${arg.slice(0, -1)}\\;` : arg;
}

function ptyCountMachine(): number {
  const out = execFileSync("sh", ["-c", "lsof 2>/dev/null | grep -c /dev/ptmx || true"]);
  return Number(out.toString().trim());
}

type Seed = "capture-then-attach" | "atomic" | "none";

interface Size {
  cols: number;
  rows: number;
}

interface View {
  id: number;
  ws: WebSocket;
  interactive: boolean;
  size: Size | null;
  droppedInput: number;
}

interface Term {
  name: string;
  session: string;
  size: Size;
  views: Set<View>;
  client: IPty | null;
  headless: InstanceType<typeof Headless> | null;
  serializer: InstanceType<typeof SerializeAddon> | null;
  driver: View | null;
  lastInteractive: View | null;
  epoch: number;
  seed: Seed;
  resizes: number;
}

const terms = new Map<string, Term>();
let delayMs = 0;
let nextViewId = 1;

function later(fn: () => void): void {
  if (delayMs > 0) setTimeout(fn, delayMs);
  else fn();
}

function send(view: View, msg: object): void {
  if (view.ws.readyState === view.ws.OPEN) view.ws.send(JSON.stringify(msg));
}

async function createTerm(body: {
  name: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  seed?: Seed;
}): Promise<Term> {
  const session = `bz-${body.name}`;
  const size = { cols: body.cols ?? 120, rows: body.rows ?? 36 };
  const env = Object.entries(body.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  await tmux(
    "new-session",
    "-d",
    "-s",
    session,
    "-x",
    String(size.cols),
    "-y",
    String(size.rows),
    "-c",
    body.cwd ?? work,
    ...env,
    "--",
    ...body.argv.map(escapeTrailingSemicolon),
  );
  await tmux("set-option", "-w", "-t", `${session}:0`, "window-size", "manual");
  await tmux(
    "resize-window",
    "-t",
    `${session}:0`,
    "-x",
    String(size.cols),
    "-y",
    String(size.rows),
  );
  const t: Term = {
    name: body.name,
    session,
    size,
    views: new Set(),
    client: null,
    headless: null,
    serializer: null,
    driver: null,
    lastInteractive: null,
    epoch: 0,
    seed: body.seed ?? "capture-then-attach",
    resizes: 0,
  };
  terms.set(body.name, t);
  return t;
}

function newHeadless(t: Term): void {
  t.headless = new Headless({
    cols: t.size.cols,
    rows: t.size.rows,
    scrollback: HISTORY_LINES + 1000,
    allowProposedApi: true,
  });
  t.serializer = new SerializeAddon();
  t.headless.loadAddon(t.serializer);
}

/** History lines are written so every one of them ends up above the viewport. */
function historyBytes(text: string, rows: number): string {
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") return "";
  return lines.join("\r\n") + "\r\n".repeat(rows);
}

function fanOut(t: Term, data: Buffer): void {
  t.headless?.write(data);
  for (const v of t.views) later(() => v.ws.readyState === v.ws.OPEN && v.ws.send(data));
}

async function startClient(t: Term): Promise<void> {
  if (ptyCountMachine() > PTY_ABORT_AT) throw new Error(`PTY count above ${PTY_ABORT_AT}`);
  newHeadless(t);
  const target = `${t.session}:0`;
  const base = ["-L", SOCKET, "-f", configFile];
  let argv: string[];
  if (t.seed === "capture-then-attach") {
    const hist = await tmux("capture-pane", "-p", "-e", "-J", "-t", target, "-S", `-${HISTORY_LINES}`, "-E", "-1");
    t.headless!.write(historyBytes(hist, t.size.rows));
    argv = [...base, "attach-session", "-t", t.session];
  } else if (t.seed === "atomic") {
    // One command list: the server runs both without processing pane output in between.
    argv = [
      ...base,
      "capture-pane", "-p", "-e", "-J", "-t", target, "-S", `-${HISTORY_LINES}`, "-E", "-1",
      ";", "attach-session", "-t", t.session,
    ];
  } else {
    argv = [...base, "attach-session", "-t", t.session];
  }
  const env = cleanEnv();
  const proc = spawn("tmux", argv, {
    name: "xterm-256color",
    cols: t.size.cols,
    rows: t.size.rows,
    cwd: work,
    env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    encoding: null,
  });
  t.client = proc;
  proc.onData((d: string | Buffer) => fanOut(t, typeof d === "string" ? Buffer.from(d) : d));
  if (REPLIES === "daemon") {
    const h = t.headless!;
    h.onData((reply) => proc.write(reply)); // DA1/DA2 and any other reply the emulator generates
    h.parser.registerCsiHandler({ prefix: ">", final: "q" }, () => {
      proc.write("\x1bP>|bazhen-spike\x1b\\");
      return true;
    });
    for (const [id, rgb] of [[10, "dddd/dddd/dddd"], [11, "1111/1111/1111"]] as const) {
      h.parser.registerOscHandler(id, (data) => {
        if (data !== "?") return false;
        proc.write(`\x1b]${id};rgb:${rgb}\x1b\\`);
        return true;
      });
    }
  }
  proc.onExit(() => {
    if (t.client !== proc) return;
    t.client = null;
    for (const v of t.views) {
      send(v, { type: "exit" });
      v.ws.close();
    }
  });
}

function stopClient(t: Term): void {
  const c = t.client;
  t.client = null;
  c?.kill();
  t.headless?.dispose();
  t.headless = null;
  t.serializer = null;
}

function applySize(t: Term, size: Size): void {
  if (size.cols === t.size.cols && size.rows === t.size.rows) return;
  t.size = size;
  t.resizes++;
  t.headless?.resize(size.cols, size.rows);
  t.client?.resize(size.cols, size.rows);
  tmux("resize-window", "-t", `${t.session}:0`, "-x", String(size.cols), "-y", String(size.rows)).catch(() => {});
  broadcastLease(t);
}

function sizer(t: Term): View | null {
  return t.driver ?? t.lastInteractive;
}

function broadcastLease(t: Term): void {
  for (const v of t.views)
    send(v, { type: "lease", driver: v === t.driver, epoch: t.epoch, cols: t.size.cols, rows: t.size.rows });
}

function takeLease(t: Term, v: View): void {
  if (!v.interactive || t.driver === v) return;
  t.driver = v;
  t.epoch++;
  if (v.size) applySize(t, v.size);
  broadcastLease(t);
}

async function attachView(t: Term, ws: WebSocket, interactive: boolean, hello: Size | null): Promise<void> {
  const v: View = { id: nextViewId++, ws, interactive, size: hello, droppedInput: 0 };
  if (interactive) t.lastInteractive = v;
  if (interactive && !t.driver && hello) t.size = hello;
  const first = !t.client;
  if (first) {
    if (hello && interactive) {
      await tmux("resize-window", "-t", `${t.session}:0`, "-x", String(t.size.cols), "-y", String(t.size.rows));
    }
    await startClient(t);
  }
  // Serialize and subscribe in one event-loop turn: no byte can land between them.
  send(v, { type: "hello", protocol: 0, cols: t.size.cols, rows: t.size.rows, view: v.id, first, replies: REPLIES });
  send(v, { type: "snapshot-start" });
  const snap = t.serializer!.serialize({ scrollback: HISTORY_LINES });
  ws.send(Buffer.from(snap));
  send(v, { type: "snapshot-end" });
  t.views.add(v);
  broadcastLease(t);

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (t.driver !== v) {
        v.droppedInput++;
        send(v, { type: "error", reason: "not-driver", dropped: v.droppedInput });
        takeLease(t, v);
        return;
      }
      const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
      later(() => t.client?.write(bytes));
      return;
    }
    const msg = JSON.parse(String(data)) as { type: string; cols?: number; rows?: number; t?: number };
    if (msg.type === "focus") takeLease(t, v);
    else if (msg.type === "resize" && msg.cols && msg.rows) {
      v.size = { cols: msg.cols, rows: msg.rows };
      if (sizer(t) === v) applySize(t, v.size);
    } else if (msg.type === "ping") send(v, { type: "pong", t: msg.t });
  });
  ws.on("close", () => {
    t.views.delete(v);
    if (t.driver === v) t.driver = null;
    if (t.lastInteractive === v) t.lastInteractive = [...t.views].reverse().find((x) => x.interactive) ?? null;
    if (t.views.size === 0) stopClient(t);
    else {
      const s = sizer(t);
      if (s?.size) applySize(t, s.size);
      broadcastLease(t);
    }
  });
}

// ---- HTTP: static page plus a small control API for the scenarios ----

const distDir = resolve(import.meta.dirname, "dist");
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean); // api, terminals, :name, action
  if (parts[1] === "terminals" && req.method === "POST" && parts.length === 2) {
    const t = await createTerm(await readBody(req));
    return json(res, 200, { name: t.name, session: t.session });
  }
  if (parts[1] === "terminals" && parts[2]) {
    const t = terms.get(parts[2]);
    if (!t) return json(res, 404, { error: "no such terminal" });
    if (req.method === "DELETE") {
      for (const v of t.views) v.ws.close();
      stopClient(t);
      await tmux("kill-session", "-t", t.session).catch(() => {});
      terms.delete(t.name);
      return json(res, 200, {});
    }
    if (parts[3] === "capture") {
      const args = ["capture-pane", "-p", "-t", `${t.session}:0`];
      if (url.searchParams.get("escapes") === "1") args.push("-e");
      if (url.searchParams.get("join") === "1") args.push("-J");
      const start = url.searchParams.get("start");
      if (start) args.push("-S", start);
      const end = url.searchParams.get("end");
      if (end) args.push("-E", end);
      return json(res, 200, { text: await tmux(...args) });
    }
    if (parts[3] === "keys" && req.method === "POST") {
      const body = await readBody(req);
      await tmux("send-keys", "-t", `${t.session}:0`, ...(body.literal ? ["-l"] : []), ...body.keys);
      return json(res, 200, {});
    }
    if (parts[3] === "info") {
      const fmt = "#{window_width}x#{window_height} #{pane_width}x#{pane_height} #{alternate_on} #{pane_dead} #{client_count}";
      const info = await tmux("display-message", "-p", "-t", `${t.session}:0`, fmt);
      const clients = await tmux("list-clients", "-t", t.session, "-F", "#{client_width}x#{client_height} #{client_termname}").catch(() => "");
      return json(res, 200, {
        tmux: info.trim(),
        clients: clients.trim(),
        size: t.size,
        epoch: t.epoch,
        views: [...t.views].map((v) => ({ id: v.id, interactive: v.interactive, driver: v === t.driver, size: v.size, dropped: v.droppedInput })),
        attachClient: t.client !== null,
        resizes: t.resizes,
        headless: t.headless ? headlessText(t) : null,
      });
    }
  }
  if (parts[1] === "tmux" && req.method === "POST") {
    return json(res, 200, { out: await tmux(...(await readBody(req)).args) });
  }
  if (parts[1] === "delay" && req.method === "POST") {
    delayMs = Number((await readBody(req)).ms ?? 0);
    return json(res, 200, { delayMs });
  }
  if (parts[1] === "stats") {
    return json(res, 200, { ptys: ptyCountMachine(), socket: SOCKET, work, terminals: [...terms.keys()] });
  }
  json(res, 404, { error: "not found" });
}

function headlessText(t: Term): { lines: string[]; baseY: number; cursorY: number } {
  const buf = t.headless!.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  return { lines, baseY: buf.baseY, cursorY: buf.cursorY };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    api(req, res, url).catch((err) => json(res, 500, { error: String(err?.stderr ?? err) }));
    return;
  }
  let file = join(distDir, url.pathname === "/" ? "index.html" : url.pathname);
  if (!file.startsWith(distDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(distDir, "index.html");
  res.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const m = /^\/terminals\/([\w-]+)\/stream$/.exec(url.pathname);
  const t = m ? terms.get(m[1]!) : undefined;
  if (!t) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const cols = Number(url.searchParams.get("cols"));
    const rows = Number(url.searchParams.get("rows"));
    const hello = cols && rows ? { cols, rows } : null;
    attachView(t, ws, url.searchParams.get("mode") !== "observe", hello).catch((err) => {
      send({ ws } as View, { type: "error", reason: String(err) });
      ws.close();
    });
  });
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const t of terms.values()) stopClient(t);
  try {
    execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
  } catch {}
  rmSync(join(process.env["TMUX_TMPDIR"] ?? "/private/tmp", `tmux-${process.getuid!()}`, SOCKET), { force: true });
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, "127.0.0.1", () => {
  console.log(JSON.stringify({ listening: `http://127.0.0.1:${PORT}`, socket: SOCKET, work, ptys: ptyCountMachine() }));
});

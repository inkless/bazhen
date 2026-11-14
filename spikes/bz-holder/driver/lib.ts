// The spike's stand-in for the daemon: talks to bz-holder over its socket, spawns and reaps
// holders, and compares terminals cell by cell in @xterm/headless.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import xtermHeadless from "@xterm/headless";
import unicodeAddon from "@xterm/addon-unicode11";

const { Terminal } = xtermHeadless;
const { Unicode11Addon } = unicodeAddon;
export type Term = InstanceType<typeof Terminal>;

export const SPIKE = path.resolve(import.meta.dirname, "..");
export const BIN = path.join(SPIKE, "target", "release");
export const HOLDER = path.join(BIN, "bz-holder");
export const PROBE = path.join(BIN, "bz-probe");
export const REPLAY = path.join(BIN, "bz-replay");
export const PROGRAMS = path.join(SPIKE, "programs");

export const K = {
  HELLO: 0x01,
  SNAPSHOT: 0x02,
  SUBSCRIBE: 0x03,
  INPUT: 0x04,
  RESIZE: 0x05,
  STATS: 0x06,
  CLOSE: 0x07,
  R_HELLO: 0x81,
  R_SNAPSHOT: 0x82,
  R_DATA: 0x83,
  R_GAP: 0x84,
  R_STATS: 0x85,
  R_EXITED: 0x86,
  R_ERROR: 0x87,
} as const;

export function frame(kind: number, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload;
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length + 1, 0);
  head.writeUInt8(kind, 4);
  return Buffer.concat([head, body]);
}

export function u64(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

export interface Frame {
  kind: number;
  payload: Buffer;
}

export const offsetOf = (f: Frame): bigint => f.payload.readBigUInt64BE(0);
export const bytesOf = (f: Frame): Buffer => f.payload.subarray(8);
export const jsonOf = <T = Record<string, unknown>>(f: Frame): T =>
  JSON.parse(f.payload.toString("utf8")) as T;

/** One connection to a holder. Frames arrive in order; `next` waits for one of a kind. */
export class Conn {
  private buf = Buffer.alloc(0);
  private waiters: { kinds: number[]; resolve: (f: Frame) => void }[] = [];
  private closed = false;
  onFrame: (f: Frame) => void = () => {};

  readonly sock: net.Socket;

  private constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on("data", (chunk: Buffer) => this.feed(chunk));
    sock.on("close", () => {
      this.closed = true;
    });
    sock.on("error", () => {
      this.closed = true;
    });
  }

  static connect(socket: string): Promise<Conn> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(socket);
      sock.once("connect", () => resolve(new Conn(sock)));
      sock.once("error", reject);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(...frames: Buffer[]): void {
    this.sock.write(Buffer.concat(frames));
  }

  next(...kinds: number[]): Promise<Frame> {
    return new Promise((resolve) => this.waiters.push({ kinds, resolve }));
  }

  async hello(): Promise<Hello> {
    const reply = this.next(K.R_HELLO);
    this.send(frame(K.HELLO));
    return jsonOf<Hello>(await reply);
  }

  async stats(): Promise<Stats> {
    const reply = this.next(K.R_STATS);
    this.send(frame(K.STATS));
    return jsonOf<Stats>(await reply);
  }

  close(): void {
    this.sock.destroy();
  }

  private feed(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    let at = 0;
    while (this.buf.length - at >= 4) {
      const len = this.buf.readUInt32BE(at);
      if (this.buf.length - at - 4 < len) break;
      const f = { kind: this.buf[at + 4]!, payload: this.buf.subarray(at + 5, at + 4 + len) };
      at += 4 + len;
      const i = this.waiters.findIndex((w) => w.kinds.includes(f.kind));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        w!.resolve(f);
      }
      this.onFrame(f);
    }
    this.buf = this.buf.subarray(at);
  }
}

export interface Hello {
  terminalId: string;
  holderPid: number;
  childPid: number;
  exit: { code: number | null; signal: number | null } | null;
  cols: number;
  rows: number;
  offset: number;
  alternate: boolean;
}

export interface Stats {
  rss: number | null;
  engineBytes: number;
  ringBytes: number;
  historyLines: number;
  offset: number;
  engineResets: number;
}

export interface HolderRef {
  id: string;
  pid: number;
  childPid: number;
  socket: string;
}

/** A temporary BAZHEN_HOME. Under /tmp, not os.tmpdir(): a macOS socket path must fit ~104 B. */
export function makeHome(tag: string): string {
  const home = fs.mkdtempSync(`/tmp/bzh-${tag}-`);
  fs.mkdirSync(path.join(home, "run", "holders"), { recursive: true });
  return home;
}

export interface SpawnOptions {
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  historyLines?: number;
  ringBytes?: number;
  cwd?: string;
}

export async function spawnHolder(
  home: string,
  id: string,
  argv: string[],
  opts: SpawnOptions = {},
): Promise<HolderRef> {
  const socket = path.join(home, "run", "holders", `${id}.sock`);
  const spec = {
    id,
    argv,
    cwd: opts.cwd ?? home,
    env: { BAZHEN_HOME: home, ...opts.env },
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 40,
    historyLines: opts.historyLines ?? 10_000,
    ringBytes: opts.ringBytes ?? 8 << 20,
    socket,
  };
  const out = execFileSync(HOLDER, ["spawn"], { input: JSON.stringify(spec), encoding: "utf8" });
  const pid = Number(/^ready (\d+)/.exec(out)?.[1]);
  if (!Number.isInteger(pid)) throw new Error(`holder ${id} did not start: ${out}`);
  const conn = await Conn.connect(socket);
  const hello = await conn.hello();
  conn.close();
  return { id, pid, childPid: hello.childPid, socket };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Closes each holder over its socket, then SIGKILLs any holder or child group still alive. */
export async function reap(holders: HolderRef[]): Promise<{ leftAlive: number[] }> {
  for (const h of holders) {
    try {
      const c = await Conn.connect(h.socket);
      c.send(frame(K.CLOSE));
      setTimeout(() => c.close(), 50);
    } catch {
      // Its socket is gone; the SIGKILL below covers it.
    }
  }
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && holders.some((h) => alive(h.pid))) await sleep(50);
  for (const h of holders) {
    for (const kill of [() => process.kill(h.pid, "SIGKILL"), () => process.kill(-h.childPid, "SIGKILL")]) {
      try {
        kill();
      } catch {
        // Already gone.
      }
    }
  }
  await sleep(100);
  return { leftAlive: holders.flatMap((h) => [h.pid, h.childPid]).filter(alive) };
}

/** Refuses to run near PTY exhaustion, with tests/support/global-setup.ts's cutoff. */
export function ptyGuard(needed: number): void {
  let used: number;
  let cutoff: number;
  if (process.platform === "linux") {
    const read = (n: string) => Number(fs.readFileSync(`/proc/sys/kernel/pty/${n}`, "utf8").trim());
    used = read("nr");
    cutoff = Math.floor(read("max") * (420 / 511));
  } else {
    used = fs.readdirSync("/dev").filter((n) => n.startsWith("ttys")).length;
    cutoff = 420;
  }
  if (used + needed > cutoff) {
    throw new Error(`Refusing to run: ${used} PTYs in use + ${needed} needed > cutoff ${cutoff}`);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function newTerm(cols: number, rows: number, scrollback = 10_000): Term {
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  return term;
}

export function write(term: Term, data: Uint8Array | string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

export interface Diff {
  cells: number;
  rows: number;
  lengths: [number, number];
  cursor: string | null;
  modes: string[];
  active: string | null;
  samples: string[];
}

/** Compares everything a viewer can see: both buffers' cells and wrap flags, cursor, modes. */
export function diffTerms(want: Term, got: Term): Diff {
  const diff: Diff = {
    cells: 0,
    rows: 0,
    lengths: [want.buffer.normal.length, got.buffer.normal.length],
    cursor: null,
    modes: [],
    active: null,
    samples: [],
  };
  if (want.buffer.active.type !== got.buffer.active.type) {
    diff.active = `${want.buffer.active.type} != ${got.buffer.active.type}`;
  }
  for (const name of ["normal", "alternate"] as const) {
    const a = want.buffer[name];
    const b = got.buffer[name];
    const rows = Math.max(a.length, b.length);
    // Compare bottom-aligned: the screen is the bottom, history above it.
    for (let r = 0; r < rows; r++) {
      const la = a.getLine(a.length - 1 - r);
      const lb = b.getLine(b.length - 1 - r);
      let rowDiffers = false;
      if (!la || !lb) {
        if (la?.translateToString(true) || lb?.translateToString(true)) rowDiffers = true;
      } else {
        if (la.isWrapped !== lb.isWrapped) rowDiffers = true;
        for (let x = 0; x < want.cols; x++) {
          const ca = cellKey(la.getCell(x));
          const cb = cellKey(lb.getCell(x));
          if (ca !== cb) {
            diff.cells++;
            rowDiffers = true;
            if (diff.samples.length < 5) diff.samples.push(`${name} -${r} x${x}: ${ca} != ${cb}`);
          }
        }
      }
      if (rowDiffers) diff.rows++;
    }
  }
  const ca = want.buffer.active;
  const cb = got.buffer.active;
  if (ca.cursorX !== cb.cursorX || ca.cursorY !== cb.cursorY) {
    diff.cursor = `${ca.cursorX},${ca.cursorY} != ${cb.cursorX},${cb.cursorY}`;
  }
  const ma = want.modes as unknown as Record<string, unknown>;
  const mb = got.modes as unknown as Record<string, unknown>;
  for (const k of Object.keys(ma)) if (ma[k] !== mb[k]) diff.modes.push(`${k}: ${ma[k]} != ${mb[k]}`);
  return diff;
}

export const clean = (d: Diff) =>
  d.cells === 0 && d.rows === 0 && d.cursor === null && d.modes.length === 0 && d.active === null;

type Cell = NonNullable<ReturnType<NonNullable<ReturnType<Term["buffer"]["normal"]["getLine"]>>["getCell"]>>;

function cellKey(c: Cell | undefined): string {
  if (!c) return "-";
  const chars = c.getChars() || (c.getWidth() === 0 ? "" : " ");
  return [
    JSON.stringify(chars),
    c.getWidth(),
    c.getFgColorMode(),
    c.getFgColor(),
    c.getBgColorMode(),
    c.getBgColor(),
    c.isBold(),
    c.isItalic(),
    c.isDim(),
    c.isUnderline(),
    c.isInverse(),
    c.isInvisible(),
    c.isStrikethrough(),
  ].join("|");
}

/** Text of the normal buffer's lines, joined across soft wraps. */
export function logicalLines(term: Term): string[] {
  const buf = term.buffer.normal;
  const out: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)!;
    const text = line.translateToString(true);
    if (line.isWrapped && out.length > 0) out[out.length - 1] += text;
    else out.push(text);
  }
  return out;
}

/** CPU seconds a process has used (user + system). */
export function cpuSeconds(pid: number): number {
  if (process.platform === "linux") {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(fields[11]) + Number(fields[12])) / 100;
  }
  const t = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).trim();
  const parts = t.split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function rssKb(pid: number): number {
  return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/** A shell wrapper that runs `load` in the background and logs any SIGHUP it receives. */
export function hupTrapped(load: string, hupLog: string): string[] {
  return [
    "/bin/sh",
    "-c",
    `trap 'echo HUP >> "$0"' HUP; ( ${load} ) & child=$!; while kill -0 $child 2>/dev/null; do wait; done`,
    hupLog,
  ];
}

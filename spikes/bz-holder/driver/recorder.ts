// The recorder's lifecycle: mirror a holder into this terminal, forward keys, and end through
// one `finish` whatever ends it. Its dependencies are passed in so the test can drive every end.
import fs from "node:fs";
import os from "node:os";
import { K, bytesOf, frame, u64, type Frame } from "./lib.ts";
import { DetachScanner, KEYBOARD_PROTOCOL, ScreenTracker, restoreTerminal, type RawTty } from "./tty.ts";

export interface RecorderDeps {
  name: string;
  /** The recorder's holder home, named when the user skips the rest of cleanup. */
  home: string;
  conn: {
    onFrame: (f: Frame) => void;
    onClose: () => void;
    send(...frames: Buffer[]): void;
    close(): void;
  };
  stdin: RawTty & {
    on(event: "data", fn: (chunk: Buffer) => void): unknown;
    off(event: "data", fn: (chunk: Buffer) => void): unknown;
    pause(): unknown;
  };
  proc: {
    pid: number;
    on(event: string, fn: (...args: any[]) => void): unknown;
    exit(code: number): void;
  };
  /** Writes to this terminal synchronously: restore and messages, which must land before exit. */
  write(text: string): void;
  mirror(bytes: Buffer): void;
  recordingPath(partial: boolean): string;
  save(file: string, bytes: Buffer): void;
  reap(): Promise<{ leftAlive: number[] }>;
  removeHome(): void;
  keylog?: (line: string) => void;
  watchdogMs?: number;
  /** How long the start of a split escape sequence is held back before it goes to the program. */
  escapeMs?: number;
}

type End = "detach" | "exited" | "lost" | "error" | NodeJS.Signals;

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export function startRecorder(d: RecorderDeps): void {
  const chunks: Buffer[] = [];
  const screen = new ScreenTracker();
  const scanner = new DetachScanner();
  let escapeTimer: NodeJS.Timeout | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let restored = false;
  let finishing = false;

  const restore = () => {
    if (restored) return;
    restored = true;
    restoreTerminal(d.stdin, d.write, screen);
  };
  const say = (text: string) => {
    try {
      d.write(text);
    } catch {
      // The terminal is gone.
    }
  };

  const onKey = (key: Buffer) => {
    d.keylog?.(`in ${key.toString("hex")} ${JSON.stringify(key.toString("latin1"))}`);
    clearTimeout(escapeTimer);
    const { forward, detach } = scanner.feed(key);
    if (forward.length > 0) d.conn.send(frame(K.INPUT, forward));
    if (detach) {
      void finish("detach");
      return;
    }
    if (scanner.holding) {
      escapeTimer = setTimeout(() => {
        const held = scanner.flush();
        if (!finishing && held.length > 0) d.conn.send(frame(K.INPUT, held));
      }, d.escapeMs ?? 10);
    }
  };

  async function finish(end: End, cause?: unknown): Promise<void> {
    if (finishing) return;
    finishing = true;
    watchdog = setTimeout(() => {
      say(`\r\nrecorder: cleanup did not finish in ${d.watchdogMs ?? 10_000} ms\r\n`);
      d.proc.exit(1);
    }, d.watchdogMs ?? 10_000);
    d.conn.onFrame = () => {};
    d.stdin.off("data", onKey);
    d.stdin.pause();
    clearTimeout(escapeTimer);
    restore();
    say(`recorder: ${end}, saving and closing the holder (Ctrl-C again to skip)\r\n`);

    const report: string[] = [`recorder: ${end}${cause === undefined ? "" : `: ${message(cause)}`}`];
    let failed = end === "lost" || end === "error";
    const step = async (what: string, fn: () => unknown) => {
      try {
        await fn();
      } catch (e) {
        failed = true;
        report.push(`${what} failed: ${message(e)}`);
      }
    };
    const file = d.recordingPath(end === "lost" || end === "error");
    await step("save", () => {
      d.save(file, Buffer.concat(chunks));
      report.push(`saved ${file}`);
    });
    await step("close", () => d.conn.close());
    await step("reap", async () => {
      const { leftAlive } = await d.reap();
      if (leftAlive.length > 0) throw new Error(`left alive: ${leftAlive.join(" ")}`);
    });
    await step("remove home", d.removeHome);
    clearTimeout(watchdog);
    say(`\r\n${report.join("\r\n")}\r\n`);
    const signal = SIGNALS.find((s) => s === end);
    d.proc.exit(signal ? 128 + os.constants.signals[signal] : failed ? 1 : 0);
  }

  d.conn.onFrame = (f) => {
    if (f.kind === K.R_EXITED) {
      void finish("exited");
      return;
    }
    if (f.kind !== K.R_DATA) return;
    const bytes = bytesOf(f);
    chunks.push(bytes);
    screen.observe(bytes);
    if (d.keylog) {
      for (const m of bytes.toString("latin1").matchAll(KEYBOARD_PROTOCOL)) d.keylog(`out ${JSON.stringify(m[0])}`);
    }
    d.mirror(bytes);
  };
  d.conn.onClose = () => void finish("lost");
  // Cooked again once finishing, so Ctrl-C is SIGINT: the user's way past a slow reap. Registered
  // before the finish handlers, so the SIGINT that starts finishing doesn't also skip it.
  d.proc.on("SIGINT", () => {
    if (!finishing) return;
    clearTimeout(watchdog);
    say(`\r\nrecorder: cleanup skipped; close what is left with node driver/cleanup.ts ${d.home}\r\n`);
    d.proc.exit(130);
  });
  for (const s of SIGNALS) d.proc.on(s, () => void finish(s));
  d.proc.on("uncaughtException", (e) => void finish("error", e));
  d.proc.on("unhandledRejection", (e) => void finish("error", e));
  d.proc.on("exit", restore);

  say(`recording ${d.name}: stop with Ctrl-], or from any shell: kill ${d.proc.pid}\r\n`);
  d.stdin.setRawMode(true);
  d.stdin.on("data", onKey);
  d.conn.send(frame(K.SUBSCRIBE, u64(0)));
}

/** Writes beside the target, then renames, so a failed write leaves an earlier recording whole. */
export function saveAtomic(file: string, bytes: Buffer): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

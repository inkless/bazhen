// A tmux control-mode client (`tmux -C attach`) on plain pipes, one per viewed terminal: the
// candidate replacement for a PTY-attached `tmux attach` client.

import type { ChildProcess } from "node:child_process";
import { signalGroup, spawnGroup, type TmuxServer } from "@bazhen/host-guard";

const NL = 0x0a;
const BACKSLASH = 0x5c;

/** A `%output` payload as bytes: tmux escapes bytes below a space, and the backslash, as `\ooo`. */
export function unescapeOutput(data: Buffer): Buffer {
  if (!data.includes(BACKSLASH)) return data;
  const out = Buffer.allocUnsafe(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i] ?? 0;
    if (b === BACKSLASH && i + 3 < data.length) {
      out[n++] =
        ((data[i + 1] ?? 0x30) - 0x30) * 64 +
        ((data[i + 2] ?? 0x30) - 0x30) * 8 +
        ((data[i + 3] ?? 0x30) - 0x30);
      i += 3;
    } else out[n++] = b;
  }
  return out.subarray(0, n);
}

/** One command's reply: its output lines, and whether tmux reported an error. */
export interface Reply {
  readonly ok: boolean;
  readonly lines: string[];
}

interface Pending {
  readonly resolve: (reply: Reply) => void;
  /** Runs as the reply's `%end` is parsed, before any output that follows it. */
  readonly atEnd?: () => void;
}

export class ControlClient {
  readonly child: ChildProcess;
  /** Raw pane bytes received, all panes, after unescaping. */
  bytes = 0;
  /** The reason tmux gave in `%exit`, if it sent one. */
  exitReason: string | null = null;
  readonly exited: Promise<number | null>;
  readonly ready: Promise<void>;
  private buffered: Buffer = Buffer.alloc(0);
  private readonly pending: Pending[] = [];
  private block: { lines: string[] } | null = null;
  private outputHandlers: Array<(pane: string, data: Buffer) => void> = [];
  private dropping = false;
  private readyResolve!: () => void;
  private gotFirstBlock = false;

  private constructor(server: TmuxServer, session: string, flags: readonly string[]) {
    const [bin, ...argv] = server.argv("-C", "attach-session", ...flags, "-t", session);
    this.child = spawnGroup(bin, argv, { stdio: ["pipe", "pipe", "pipe"] });
    this.ready = new Promise((r) => (this.readyResolve = r));
    this.child.stdout?.on("data", (chunk: Buffer) => this.feed(chunk));
    // A write racing the client's exit fails with EPIPE; `exited` already reports the exit.
    this.child.stdin?.on("error", () => {});
    this.exited = new Promise((resolve) => this.child.once("exit", (code) => resolve(code)));
    void this.exited.then(() => {
      for (const p of this.pending.splice(0)) p.resolve({ ok: false, lines: ["client exited"] });
    });
  }

  /** A client attached to `session`, once tmux has answered the attach. */
  static async attach(
    server: TmuxServer,
    session: string,
    flags: readonly string[] = [],
  ): Promise<ControlClient> {
    const client = new ControlClient(server, session, flags);
    await Promise.race([
      client.ready,
      client.exited.then(() => {
        throw new Error(`control client for ${session} exited before attaching`);
      }),
    ]);
    return client;
  }

  onOutput(cb: (pane: string, data: Buffer) => void): void {
    this.outputHandlers.push(cb);
  }

  command(line: string, atEnd?: () => void): Promise<Reply> {
    return new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve({ ok: false, lines: ["client exited"] });
        return;
      }
      this.pending.push(atEnd === undefined ? { resolve } : { resolve, atEnd });
      this.child.stdin?.write(`${line}\n`);
    });
  }

  /** Types `bytes` into `pane` as they are, in commands of at most `chunk` bytes. */
  async sendBytes(pane: string, bytes: Uint8Array, chunk = 4096): Promise<void> {
    const sends: Array<Promise<Reply>> = [];
    for (let i = 0; i < bytes.length; i += chunk) {
      const hex = Buffer.from(bytes.subarray(i, i + chunk)).toString("hex");
      sends.push(this.command(`send-keys -t ${pane} -H ${hex.replace(/(..)(?!$)/g, "$1 ")}`));
    }
    for (const reply of await Promise.all(sends)) {
      if (!reply.ok) throw new Error(`send-keys failed: ${reply.lines.join(" ")}`);
    }
  }

  /**
   * Attach's seam: the mode formats and the whole pane as tmux holds it, with every `%output`
   * before the capture's `%end` dropped, so capture plus what follows is the pane exactly.
   */
  async snapshot(pane: string, formats: string): Promise<{ modes: string; capture: string }> {
    this.dropping = true;
    const modes = this.command(`display-message -p -t ${pane} '${formats}'`);
    const capture = this.command(`capture-pane -p -e -J -t ${pane} -S - -E -`, () => {
      this.dropping = false;
    });
    return { modes: (await modes).lines.join("\n"), capture: (await capture).lines.join("\n") };
  }

  /** Stops reading tmux's output, as a viewer too slow to keep up would. */
  pause(): void {
    this.child.stdout?.pause();
  }

  resume(): void {
    this.child.stdout?.resume();
  }

  /** Detaches by closing stdin, as tmux documents; kills the client if it outlives `ms`. */
  async close(ms = 5000): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin?.end();
    const timer = setTimeout(() => signalGroup(this.child, "SIGKILL"), ms);
    await this.exited;
    clearTimeout(timer);
  }

  private feed(chunk: Buffer): void {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    let start = 0;
    for (;;) {
      const end = this.buffered.indexOf(NL, start);
      if (end === -1) break;
      this.line(this.buffered.subarray(start, end));
      start = end + 1;
    }
    this.buffered =
      start === this.buffered.length ? Buffer.alloc(0) : this.buffered.subarray(start);
  }

  private line(raw: Buffer): void {
    if (this.block !== null) {
      const text = raw.toString("utf8");
      if (text.startsWith("%end ") || text.startsWith("%error ")) {
        const { lines } = this.block;
        this.block = null;
        if (!this.gotFirstBlock) {
          this.gotFirstBlock = true;
          this.readyResolve();
          return;
        }
        const p = this.pending.shift();
        p?.atEnd?.();
        p?.resolve({ ok: text.startsWith("%end "), lines });
      } else this.block.lines.push(text);
      return;
    }
    if (raw.subarray(0, 8).toString("latin1") === "%output ") {
      const space = raw.indexOf(0x20, 8);
      const pane = raw.subarray(8, space).toString("latin1");
      const data = unescapeOutput(raw.subarray(space + 1));
      this.bytes += data.length;
      if (!this.dropping) for (const h of this.outputHandlers) h(pane, data);
      return;
    }
    const text = raw.toString("utf8");
    if (text.startsWith("%begin ")) this.block = { lines: [] };
    else if (text.startsWith("%exit")) this.exitReason = text.slice(6) || "";
  }
}

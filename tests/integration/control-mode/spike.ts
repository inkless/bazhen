import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import headless from "@xterm/headless";
import type { ConfiguredTmuxServer } from "@bazhen/host-guard";
import { TMUX_CONFIG } from "@bazhen/runtime-tmux";
import { testServer } from "../helpers.ts";

export const HISTORY = 10_000;
export const SIZE = { cols: 106, rows: 28 } as const;

let version = "unknown";

/** One measurement, as a line the run log can be grepped for. */
export function report(test: string, data: Record<string, unknown>): void {
  console.log(`BZSPIKE ${JSON.stringify({ test, tmux: version, ...data })}`);
}

/** A private server configured as the runtime configures its own, with the larger history. */
export function spikeServer(label: string, extra = ""): ConfiguredTmuxServer {
  const server = testServer(label);
  writeFileSync(server.config, `${TMUX_CONFIG}set -g history-limit ${HISTORY}\n${extra}`);
  return server;
}

export interface Terminal {
  readonly session: string;
  readonly pane: string;
}

/** A session running `command`, its window sized and pinned as the runtime does. */
export function newTerminal(
  server: ConfiguredTmuxServer,
  name: string,
  command: string,
  size: { cols: number; rows: number } = SIZE,
): Terminal {
  const out = server.runSync([
    "new-session",
    "-d",
    "-s",
    name,
    "-x",
    String(size.cols),
    "-y",
    String(size.rows),
    "-P",
    "-F",
    "#{session_id} #{pane_id}",
    command,
  ]);
  const [session = "", pane = ""] = out.trim().split(" ");
  version = server.runSync(["display-message", "-p", "#{version}"]).trim();
  server.runSync(["set-option", "-w", "-t", `${session}:`, "window-size", "manual"]);
  return { session, pane };
}

/** A FIFO the pane's program waits on, so a test can start output at the moment it chooses. */
export function fifo(dir: string, name: string): string {
  const path = join(dir, name);
  execFileSync("mkfifo", [path]);
  return path;
}

/** A headless xterm.js as the daemon's emulator and the browser build it: unicode 11 widths. */
export class Screen {
  readonly term: headless.Terminal;
  private last: Promise<void> = Promise.resolve();

  constructor(size: { cols: number; rows: number } = SIZE, scrollback = HISTORY) {
    this.term = new headless.Terminal({ ...size, scrollback, allowProposedApi: true });
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
  }

  write(data: Uint8Array | string): void {
    this.last = new Promise((resolve) => this.term.write(data, resolve));
  }

  async settled(): Promise<void> {
    await this.last;
  }

  /** Every line, scrollback and screen, trailing blanks trimmed, wrapped lines joined. */
  lines(): string[] {
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line === undefined) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && out.length > 0) out[out.length - 1] += text;
      else out.push(text);
    }
    return out;
  }
}

/** The whole numbers that make up a line on their own: what `seq` printed and survived. */
export function numbers(lines: readonly string[]): Set<number> {
  const set = new Set<number>();
  for (const line of lines) if (/^\d+$/.test(line.trim())) set.add(Number(line.trim()));
  return set;
}

/** tmux's own copy of a pane, history and screen, wrapped lines joined. */
export function tmuxLines(server: ConfiguredTmuxServer, pane: string): string[] {
  return server.runSync(["capture-pane", "-p", "-J", "-t", pane, "-S", "-", "-E", "-"]).split("\n");
}

export function missing(want: Set<number>, have: Set<number>): number[] {
  return [...want].filter((n) => !have.has(n));
}

const CLK_TCK = 100;

/** CPU seconds a process has used, user and system, from /proc. */
export function cpuSeconds(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return (Number(fields[11]) + Number(fields[12])) / CLK_TCK;
}

export function serverPid(server: ConfiguredTmuxServer): number {
  return Number(server.runSync(["display-message", "-p", "#{pid}"]).trim());
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(check: () => boolean, ms: number, step = 50): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(step);
  }
  return check();
}

/** The environment a PTY-attached `tmux attach` gets here. */
export const attachEnv = (): Record<string, string> => ({
  PATH: process.env["PATH"] ?? "",
  LANG: "C.UTF-8",
});

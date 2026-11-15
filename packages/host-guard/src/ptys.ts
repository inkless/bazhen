// How many PTYs the machine has in use, and the most it allows. A PTY leak starves every terminal
// on the machine, Bazhen's and the user's own, so both the daemon and the test suites read this.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

/**
 * The machine's PTYs. `exact` is false where `used` counts device nodes rather than PTYs: macOS's
 * `/dev/ttys*` nodes can outlive the PTY that made them, so the count is only an upper bound.
 */
export type HostPtys =
  | { readonly ok: true; readonly used: number; readonly max: number; readonly exact: boolean }
  | { readonly ok: false; readonly reason: string };

/** What the readers touch, so a small test can stand in for the machine. */
export interface PtySource {
  readonly platform: NodeJS.Platform;
  readFile(path: string): string;
  readdir(path: string): readonly string[];
  /** `kern.tty.ptmx_max`, on macOS only. */
  ptmxMax(): string;
}

export const machinePtySource: PtySource = {
  platform: process.platform,
  readFile: (path) => readFileSync(path, "utf8"),
  readdir: (path) => readdirSync(path),
  ptmxMax: () =>
    execFileSync("/usr/sbin/sysctl", ["-n", "kern.tty.ptmx_max"], {
      encoding: "utf8",
      timeout: 5_000,
    }),
};

const count = (raw: string, what: string): number => {
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} is "${raw.trim()}"`);
  return n;
};

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * A reader of the machine's PTYs, called as often as needed. On Linux each call reads the
 * kernel's own counters. On macOS the maximum is read once, by the first call, since it costs a
 * process; each call counts `/dev/ttys*`, which includes the 16 legacy BSD names: an overcount,
 * the safe direction. A machine whose figures can't be read answers why, never a guess.
 */
export function hostPtyReader(source: PtySource = machinePtySource): () => HostPtys {
  if (source.platform === "linux") {
    const sysctl = (name: string) =>
      count(source.readFile(`/proc/sys/kernel/pty/${name}`), `kernel.pty.${name}`);
    return () => {
      try {
        return { ok: true, used: sysctl("nr"), max: sysctl("max"), exact: true };
      } catch (err) {
        return { ok: false, reason: reasonOf(err) };
      }
    };
  }
  if (source.platform === "darwin") {
    let max: number | undefined;
    return () => {
      try {
        max ??= count(source.ptmxMax(), "kern.tty.ptmx_max");
        const used = source.readdir("/dev").filter((name) => name.startsWith("ttys")).length;
        return { ok: true, used, max, exact: false };
      } catch (err) {
        return { ok: false, reason: reasonOf(err) };
      }
    };
  }
  const reason = `PTYs aren't counted on ${source.platform}`;
  return () => ({ ok: false, reason });
}

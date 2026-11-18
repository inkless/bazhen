// Where processes are working now, as a terminal's foreground reports it: read from /proc where
// there is one, and from one batched lsof elsewhere, as on macOS.

import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { promisify } from "node:util";
import { heard } from "./child.ts";

const run = promisify(execFile);
const TIMEOUT_MS = 5_000;
const MAX_BYTES = 1024 * 1024;
const LSOF_ENV = { LC_ALL: "C", PATH: process.env["PATH"] ?? "/usr/bin:/usr/sbin:/bin" };

/** The largest pid there can be: a `pid_t` is 32 bits, and a larger one fails `ps` and `lsof`. */
const PID_MAX = 2 ** 31 - 1;

/** Whether `pid` could be a process to read: never 0, 1 or a negative group, nor out of range. */
export const isPid = (pid: number) => Number.isSafeInteger(pid) && pid > 1 && pid <= PID_MAX;

/**
 * Each pid's directory from `lsof -a -d cwd -Fpn0`, whose fields each end in a NUL: `p<pid>`,
 * then its `n<path>`. A newline may start a field, never end one, so a path holding one is read
 * whole.
 */
export function parseLsofCwds(out: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | undefined;
  for (const raw of out.split("\0")) {
    const field = raw.replace(/^\n/, "");
    if (field.startsWith("p")) {
      const parsed = Number(field.slice(1));
      pid = isPid(parsed) && /^\d+$/.test(field.slice(1)) ? parsed : undefined;
    } else if (field.startsWith("n") && pid !== undefined && !cwds.has(pid)) {
      cwds.set(pid, field.slice(1));
    }
  }
  return cwds;
}

const stdoutOf = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "stdout" in error &&
  typeof error.stdout === "string"
    ? error.stdout
    : "";

/**
 * The working directory of each of `pids` that can be read; one that can't, as a process that
 * has exited or another user's, is left out. Nothing at all is read for no pids.
 */
export async function processCwds(
  pids: readonly number[],
  platform: NodeJS.Platform = process.platform,
): Promise<Map<number, string>> {
  const wanted = [...new Set(pids.filter(isPid))];
  if (wanted.length === 0) return new Map();
  if (platform === "linux") {
    const read = await Promise.all(
      wanted.map(async (pid) => {
        const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null);
        return cwd === null ? [] : [[pid, cwd] as const];
      }),
    );
    return new Map(read.flat());
  }
  const args = ["-a", "-d", "cwd", "-Fpn0", "-p", wanted.join(",")];
  try {
    const { stdout } = await heard(
      run("lsof", args, {
        env: LSOF_ENV,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BYTES,
      }),
    );
    return parseLsofCwds(stdout);
  } catch (error) {
    // lsof exits 1 when any pid has no process, and still prints the others.
    return parseLsofCwds(stdoutOf(error));
  }
}

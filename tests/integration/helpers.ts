import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

/** As if `bazhen start` ran inside another Claude Code session, with a token of the user's own. */
export const launchedFrom: NodeJS.ProcessEnv = {
  ...process.env,
  CLAUDECODE: "1",
  BZ_USER_VALUE: "kept",
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A private tmux server name scoped to this test run, so teardown can find and check it. */
export function testSocket(label: string): string {
  return `bz-test-${process.env["BZ_TEST_RUN"] ?? process.pid}-${label}`;
}

/** Runs a tmux command on the test's own server and returns what it printed. */
export function tmuxOut(socket: string, ...args: string[]): string {
  return execFileSync("tmux", ["-L", socket, ...args]).toString();
}

export function killServer(socket: string): void {
  try {
    execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
  } catch {}
}

export function serverAlive(socket: string): boolean {
  try {
    execFileSync("tmux", ["-L", socket, "list-sessions"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** PTY master handles held by this process: /dev/ptmx entries on macOS, ptmx links on Linux. */
export function ptyHandleCount(): number {
  if (process.platform === "linux") {
    return readdirSync("/proc/self/fd").filter((fd) => {
      try {
        return execFileSync("readlink", [`/proc/self/fd/${fd}`])
          .toString()
          .includes("ptmx");
      } catch {
        return false;
      }
    }).length;
  }
  const out = execFileSync("sh", [
    "-c",
    `lsof -p ${process.pid} 2>/dev/null | grep -c /dev/ptmx || true`,
  ]);
  return Number(out.toString().trim());
}

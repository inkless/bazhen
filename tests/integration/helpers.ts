import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function testSocket(label: string): string {
  return `bz-test-${label}-${process.pid}`;
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

export async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await sleep(20);
  }
  return pred();
}

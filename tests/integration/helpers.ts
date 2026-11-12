import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { TmuxServer, type ConfiguredTmuxServer } from "@bazhen/host-guard";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A private tmux server scoped to this test run, in the run's own socket directory, so teardown
 * can find and check it. Its config file sits beside it unless the test names one.
 */
export function testServer(label: string, config?: string): ConfiguredTmuxServer {
  const root = process.env["BZ_TEST_SERVERS"];
  if (root === undefined) throw new Error("no BZ_TEST_SERVERS: the integration setup did not run");
  const name = `bz-test-${process.env["BZ_TEST_RUN"] ?? process.pid}-${label}`;
  return TmuxServer.at(join(root, name), {
    root,
    config: config ?? join(root, `${name}.conf`),
  });
}

/** Runs a tmux command on the test's own server and returns what it printed. */
export const tmuxOut = (server: TmuxServer, ...args: string[]) => server.runSync(args);

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

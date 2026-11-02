// Vitest globalSetup for the medium and integration projects (docs/standards/testing.md).
// - Every run gets a temporary BAZHEN_HOME, so no test touches the user's real data.
// - Every run gets an id (BZ_TEST_RUN) that testSocket() puts in tmux socket names, so teardown
//   can find exactly this run's servers without touching parallel runs in other worktrees.
// - The run refuses to start when the machine is close to running out of PTYs: a leak there
//   starves every terminal on the machine, not just Bazhen's.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The spikes' watchdog aborted above 420 of macOS's 511 PTYs (kern.tty.ptmx_max).
const MACOS_CUTOFF = 420;
const LINUX_CUTOFF_FRACTION = 420 / 511;

const readPtySysctl = (name: string) =>
  Number(readFileSync(`/proc/sys/kernel/pty/${name}`, "utf8").trim());

export function ptysInUse(): { used: number; cutoff: number } {
  const override = process.env["BZ_PTY_CUTOFF"];
  if (process.platform === "linux") {
    const max = readPtySysctl("max");
    return {
      used: readPtySysctl("nr"),
      cutoff: override ? Number(override) : Math.floor(max * LINUX_CUTOFF_FRACTION),
    };
  }
  // Counts the 16 legacy BSD names too, which overcounts slightly: the safe direction, and the
  // same way the spike measured the cutoff.
  const used = readdirSync("/dev").filter((name) => name.startsWith("ttys")).length;
  return { used, cutoff: override ? Number(override) : MACOS_CUTOFF };
}

function tmuxSocketDir(): string {
  return join(process.env["TMUX_TMPDIR"] ?? "/tmp", `tmux-${process.getuid?.() ?? 0}`);
}

// Vitest's source-map lookup crashes on errors thrown from globalSetup and hides their message,
// so print it before throwing.
function fail(message: string): never {
  console.error(`\n${message}\n`);
  throw new Error(message);
}

function alive(socket: string): boolean {
  try {
    execFileSync("tmux", ["-L", socket, "list-sessions"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

let home: string | undefined;

export function setup(): void {
  const { used, cutoff } = ptysInUse();
  if (used > cutoff) {
    fail(
      `Refusing to run: ${used} PTYs are in use machine-wide (cutoff ${cutoff}). ` +
        "Something is leaking PTYs; see the bz-debug-integration-test skill.",
    );
  }
  home = mkdtempSync(join(tmpdir(), "bz-test-home-"));
  process.env["BAZHEN_HOME"] = home;
  process.env["BZ_TEST_RUN"] = `${process.pid}`;
}

export function teardown(): void {
  const prefix = `bz-test-${process.env["BZ_TEST_RUN"]}-`;
  let sockets: string[] = [];
  try {
    sockets = readdirSync(tmuxSocketDir()).filter((name) => name.startsWith(prefix));
  } catch {
    // No socket directory: this run never started tmux.
  }
  const leaked = sockets.filter(alive);
  for (const socket of leaked) {
    try {
      execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore", timeout: 5000 });
    } catch {
      // Already gone.
    }
  }
  for (const socket of sockets) rmSync(join(tmuxSocketDir(), socket), { force: true });
  if (home) rmSync(home, { recursive: true, force: true });
  if (leaked.length > 0) {
    fail(
      `Tests left ${leaked.length} tmux server(s) running: ${leaked.join(", ")}. ` +
        "Kill every server a test starts in afterAll (docs/standards/testing.md).",
    );
  }
}

// Vitest globalSetup for the medium, integration and api projects (docs/standards/testing.md).
// - Every run gets a temporary BAZHEN_HOME, so no test touches the user's real data.
// - Every run gets its own tmux socket directory (TMUX_TMPDIR) and runs outside any tmux client
//   (TMUX unset). Every tmux command a test runs, with or without -L, lands on a throwaway server
//   and can never reach the user's sessions, the agent fleet, or a real Bazhen daemon. Teardown
//   fails the run if any server in that directory is still alive.
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

function cutoffOverride(): number | undefined {
  const raw = process.env["BZ_PTY_CUTOFF"];
  if (raw === undefined || raw === "") return undefined;
  const cutoff = Number(raw);
  if (!Number.isFinite(cutoff) || cutoff <= 0) {
    fail(`BZ_PTY_CUTOFF must be a positive number of PTYs, got "${raw}".`);
  }
  return cutoff;
}

export function ptysInUse(): { used: number; cutoff: number } {
  const override = cutoffOverride();
  if (process.platform === "linux") {
    const max = readPtySysctl("max");
    return {
      used: readPtySysctl("nr"),
      cutoff: override ?? Math.floor(max * LINUX_CUTOFF_FRACTION),
    };
  }
  // Counts the 16 legacy BSD names too, which overcounts slightly: the safe direction, and the
  // same way the spike measured the cutoff.
  const used = readdirSync("/dev").filter((name) => name.startsWith("ttys")).length;
  return { used, cutoff: override ?? MACOS_CUTOFF };
}

function tmuxSocketDir(): string {
  return join(process.env["TMUX_TMPDIR"] ?? "/tmp", `tmux-${process.getuid?.() ?? 0}`);
}

// Under /tmp, not os.tmpdir(): a Unix socket path must fit in about 104 bytes on macOS, and the
// per-user temp directory there is already over 50.
function privateTmuxDir(): string {
  return mkdtempSync("/tmp/bz-tmux-");
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
let tmuxDir: string | undefined;

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
  tmuxDir = privateTmuxDir();
  process.env["TMUX_TMPDIR"] = tmuxDir;
  delete process.env["TMUX"];
  delete process.env["TMUX_PANE"];
}

export function teardown(): void {
  let sockets: string[] = [];
  try {
    sockets = readdirSync(tmuxSocketDir());
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
  if (tmuxDir) rmSync(tmuxDir, { recursive: true, force: true });
  if (home) rmSync(home, { recursive: true, force: true });
  if (leaked.length > 0) {
    fail(
      `Tests left ${leaked.length} tmux server(s) running: ${leaked.join(", ")}. ` +
        "Kill every server a test starts in afterAll (docs/standards/testing.md).",
    );
  }
}

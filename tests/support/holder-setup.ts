// Vitest globalSetup for the holder project, which runs real PTYs and holders on the host
// (docs/standards/testing.md).
// - It refuses to start when the machine is close to running out of PTYs, before anything else.
// - Every run gets a temporary BAZHEN_HOME under /tmp, so a holder's socket path stays inside
//   the 103 bytes a Unix socket allows on macOS too, and tests find it only through
//   ./holder-home.ts, which refuses any home but this one.
// - No test can reach a tmux server: `tmux` on PATH is a script that refuses, TMUX is unset, and
//   TMUX_TMPDIR is an empty directory of the run's, not a file or a missing path, from which
//   tmux would fall back to /tmp and the user's own servers. Teardown fails the run if anything
//   appears there.
// - Teardown closes every holder still answering in the home, through the protocol, and fails
//   the run naming them. It signals nothing: host-guard is the one place that does.

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { connectHolder, HolderDisconnected } from "@bazhen/runtime-holder";
import { holdersDir, RUN_ENV, RUN_MARKER } from "./holder-home.ts";
import { requirePtyHeadroom } from "./ptys.ts";

/** What `tmux` on the holder tests' PATH is: a script that refuses. */
export const TMUX_REFUSAL = '#!/bin/sh\necho "holder tests never run tmux" >&2\nexit 127\n';
const CLOSE_WAIT_MS = 2000;

const tmuxDir = (home: string) => join(home, "tmux");

let home: string | undefined;

function isolateTmux(dir: string): void {
  delete process.env["TMUX"];
  delete process.env["TMUX_PANE"];
  mkdirSync(tmuxDir(dir), { mode: 0o700 });
  process.env["TMUX_TMPDIR"] = tmuxDir(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), TMUX_REFUSAL, { mode: 0o755 });
  process.env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
}

export function setup(): void {
  requirePtyHeadroom();
  home = mkdtempSync("/tmp/bz-h-");
  for (const dir of [join(home, "run"), holdersDir(home)]) {
    mkdirSync(dir);
    chmodSync(dir, 0o700);
  }
  isolateTmux(home);
  const run = randomUUID();
  writeFileSync(join(home, RUN_MARKER), run);
  process.env["BAZHEN_HOME"] = home;
  process.env[RUN_ENV] = run;
}

export interface LeakedHolder {
  readonly socket: string;
  /** Null for a holder that took the connection but never answered `hello`. */
  readonly terminalId: string | null;
  readonly holderPid: number | null;
  /** Whether it answered `close`; one that didn't may still be running. */
  readonly closed: boolean;
}

const timeout = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

async function closeIfLive(socket: string, waitMs: number): Promise<LeakedHolder | null> {
  let client;
  try {
    client = await connectHolder(socket, {
      onEvent: () => {},
      signal: AbortSignal.timeout(waitMs),
    });
  } catch (error) {
    // Refused, missing or hung up at once: nothing holds this socket any more.
    if (error instanceof HolderDisconnected) return null;
    return { socket, terminalId: null, holderPid: null, closed: false };
  }
  const { terminalId, holderPid } = client.hello;
  const closed = await client.close({ signal: AbortSignal.timeout(waitMs) }).then(
    () => true,
    () => false,
  );
  if (closed) await Promise.race([client.ended, timeout(waitMs)]);
  client.end();
  return { socket, terminalId, holderPid, closed };
}

/** Closes every holder still answering on a socket in `dir`, and says which they were. */
export async function closeLiveHolders(
  dir: string,
  waitMs: number = CLOSE_WAIT_MS,
): Promise<LeakedHolder[]> {
  const sockets = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".sock")) : [];
  const found = await Promise.all(sockets.map((name) => closeIfLive(join(dir, name), waitMs)));
  return found.filter((holder) => holder !== null);
}

const describeLeak = (holder: LeakedHolder) =>
  holder.terminalId === null
    ? `${holder.socket} (never answered hello)`
    : `${holder.terminalId} (pid ${holder.holderPid}, ${holder.closed ? "closed" : "ignored close; still running"})`;

// Vitest's source-map lookup hides errors thrown from globalSetup, so print it as well.
function fail(message: string): never {
  console.error(`\n${message}\n`);
  throw new Error(message);
}

export async function teardown(): Promise<void> {
  const dir = home;
  home = undefined;
  if (dir === undefined) return;
  const leaked = await closeLiveHolders(holdersDir(dir));
  const ranTmux = readdirSync(tmuxDir(dir));
  rmSync(dir, { recursive: true, force: true });
  const problems = [
    ...(leaked.length > 0
      ? [
          `Tests left ${leaked.length} holder(s) running: ${leaked.map(describeLeak).join(", ")}. ` +
            "Close every holder a test starts in afterAll (docs/standards/testing.md).",
        ]
      : []),
    ...(ranTmux.length > 0 ? [`A holder test ran tmux, which made ${ranTmux.join(", ")}.`] : []),
  ];
  if (problems.length > 0) fail(problems.join("\n"));
}

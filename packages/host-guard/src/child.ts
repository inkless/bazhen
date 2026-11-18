// A child's stdio streams are sockets the daemon holds. One that fails with no `error` listener
// throws out of the event loop and ends the daemon: a child that exits before reading what it was
// written breaks its stdin, and nothing but the child decides when that happens.

import type { ChildProcess } from "node:child_process";

type Stdio = Pick<ChildProcess, "stdin" | "stdout" | "stderr">;
/** A started child, or what `promisify(execFile)` returns for one. */
type Started = Stdio | { readonly child: Stdio };

const ignore = () => {};

/**
 * `started`, with an `error` listener on each of its child's stdio streams. The child's own
 * `error`, `exit` and `close`, or the callback or promise of the start, still say how it ended: a
 * broken pipe changes what they report, never whether the process lives.
 */
export function heard<T extends Started>(started: T): T {
  const start: Started = started;
  const child = "child" in start ? start.child : start;
  child.stdin?.on("error", ignore);
  child.stdout?.on("error", ignore);
  child.stderr?.on("error", ignore);
  return started;
}

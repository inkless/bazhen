import { createRequire } from "node:module";
import { spawn as nodePtySpawn, type IPty, type IPtyForkOptions } from "node-pty";
import type { PtyProcess, PtySpawner } from "@bazhen/core";

/** node-pty's `spawn`, or a stand-in for it. */
export type PtySpawn = (file: string, args: string[], options: IPtyForkOptions) => IPty;

/** What the seam uses of node-pty's terminal beyond its typings, which leave out `destroy` and `on`. */
const RELIED_ON = ["destroy", "kill", "on"] as const;

/** The prototype of node-pty's terminal on Linux and macOS, a class its package doesn't export. */
export function unixTerminal(): object {
  const lib: unknown = createRequire(import.meta.url)("node-pty/lib/unixTerminal.js");
  const prototype: unknown =
    typeof lib === "object" && lib !== null && "UnixTerminal" in lib
      ? Reflect.get(Object(lib.UnixTerminal), "prototype")
      : undefined;
  if (typeof prototype !== "object" || prototype === null) {
    throw new TypeError("node-pty has no UnixTerminal");
  }
  return prototype;
}

const sendNothing = () => {};

const method = (target: object, name: (typeof RELIED_ON)[number]) => {
  const found: unknown = Reflect.get(target, name);
  if (typeof found !== "function") throw new TypeError(`node-pty's terminal has no ${name}`);
  return found;
};

/** Whether `target` has node-pty's `ptsName` getter, which its typings leave out. */
function hasPtsName(target: object): boolean {
  for (let at: object | null = target; at !== null; at = Reflect.getPrototypeOf(at)) {
    const found = Reflect.getOwnPropertyDescriptor(at, "ptsName");
    if (found !== undefined) return typeof found.get === "function";
  }
  return false;
}

/**
 * Makes `proc` one that can be hung up without a signal, and returns its hang-up.
 *
 * node-pty's `kill` is `process.kill(pid)`, and node-pty reaps its child on a thread of its own
 * before any listener hears of the exit, so a `kill` can reach a pid already freed for reuse. Its
 * `destroy`, which its typings leave out, closes the master, and the kernel hangs up whichever
 * session holds the terminal then, by no pid; but it also calls `kill` once the master has closed.
 * So the instance's `kill` is replaced with one that sends nothing, before anything can call it.
 */
function disarm(proc: IPty): () => void {
  const destroy = method(proc, "destroy");
  if (!Reflect.defineProperty(proc, "kill", { value: sendNothing })) {
    throw new TypeError("node-pty's terminal kill can't be replaced");
  }
  return () => Reflect.apply(destroy, proc, []);
}

/**
 * The PTY seam over a node-pty `spawn` whose terminals have `terminal` as their prototype. A
 * prototype without what the hang-up relies on, or without the terminal device's name, is refused
 * here, before any child is started.
 */
export function ptySpawner(spawn: PtySpawn, terminal: object): PtySpawner {
  for (const name of RELIED_ON) method(terminal, name);
  if (!hasPtsName(terminal)) throw new TypeError("node-pty's terminal has no ptsName");
  return {
    spawn(argv, size, env): PtyProcess {
      const [file, ...args] = argv;
      const proc = spawn(file, args, {
        name: "xterm-256color",
        cols: size.cols,
        rows: size.rows,
        env: { ...env, TERM: "xterm-256color" },
        encoding: null,
      });
      const hangUp = disarm(proc);
      const tty: unknown = Reflect.get(proc, "ptsName");
      if (typeof tty !== "string" || tty === "") {
        hangUp();
        throw new TypeError("node-pty's terminal names no terminal device");
      }
      // node-pty resizes by its fd's number even once the master is closed, when that number may
      // be another file's. At the child's end of file it closes the master before it reports the
      // exit, and says so by its own `close`.
      let ended = false;
      const end = () => {
        ended = true;
      };
      proc.onExit(end);
      Reflect.apply(method(proc, "on"), proc, ["close", end]);
      return {
        get tty() {
          return ended ? undefined : tty;
        },
        onData: (cb) => {
          proc.onData((d: string | Buffer) => cb(typeof d === "string" ? Buffer.from(d) : d));
        },
        onExit: (cb) => {
          proc.onExit((e) => cb(e.exitCode));
        },
        write: (bytes) => {
          if (!ended) proc.write(Buffer.from(bytes));
        },
        resize: (next) => {
          if (!ended) proc.resize(next.cols, next.rows);
        },
        hangUp: () => {
          if (ended) return;
          ended = true;
          hangUp();
        },
      };
    },
  };
}

/**
 * The PTY seam's only implementation. node-pty is pinned to a 1.2.0 beta: 1.1.0 leaks a PTY per
 * spawn on macOS, and the hang-up relies on this version's `destroy`, `kill` and `close`. The
 * child gets exactly `env` plus TERM, never the daemon's own environment.
 */
export const nodePtySpawner: PtySpawner = ptySpawner(nodePtySpawn, unixTerminal());

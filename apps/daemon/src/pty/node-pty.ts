import { spawn as nodePtySpawn, type IPty, type IPtyForkOptions } from "node-pty";
import type { PtyProcess, PtySpawner } from "@bazhen/core";

/** node-pty's `spawn`, or a stand-in for it. */
export type PtySpawn = (file: string, args: string[], options: IPtyForkOptions) => IPty;

const sendNothing = () => {};

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
  const destroy: unknown = Reflect.get(proc, "destroy");
  if (typeof destroy !== "function") throw new TypeError("node-pty's terminal has no destroy");
  if (!Reflect.defineProperty(proc, "kill", { value: sendNothing })) {
    throw new TypeError("node-pty's terminal kill can't be replaced");
  }
  return () => Reflect.apply(destroy, proc, []);
}

/** The PTY seam over a node-pty `spawn`. */
export function ptySpawner(spawn: PtySpawn): PtySpawner {
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
      // node-pty resizes by its fd's number even once the master is closed, when that number may
      // be another file's.
      let ended = false;
      proc.onExit(() => {
        ended = true;
      });
      return {
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
 * spawn on macOS, and the hang-up relies on this version's `destroy`. The child gets exactly `env`
 * plus TERM, never the daemon's own environment.
 */
export const nodePtySpawner: PtySpawner = ptySpawner(nodePtySpawn);

import { spawn } from "node-pty";
import type { PtyProcess, PtySpawner } from "@bazhen/core";

/**
 * The PTY seam's only implementation. node-pty is pinned to a 1.2.0 beta: 1.1.0 leaks a PTY per
 * spawn on macOS. The child gets exactly `env` plus TERM, never the daemon's own environment.
 */
export const nodePtySpawner: PtySpawner = {
  spawn(argv, size, env): PtyProcess {
    const [file, ...args] = argv;
    const proc = spawn(file, args, {
      name: "xterm-256color",
      cols: size.cols,
      rows: size.rows,
      env: { ...env, TERM: "xterm-256color" },
      encoding: null,
    });
    return {
      onData: (cb) => {
        proc.onData((d: string | Buffer) => cb(typeof d === "string" ? Buffer.from(d) : d));
      },
      onExit: (cb) => {
        proc.onExit((e) => cb(e.exitCode));
      },
      write: (bytes) => proc.write(Buffer.from(bytes)),
      resize: (next) => proc.resize(next.cols, next.rows),
      kill: () => proc.kill(),
    };
  },
};

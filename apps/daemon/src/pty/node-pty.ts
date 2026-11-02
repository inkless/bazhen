import { spawn } from "node-pty";
import type { PtyProcess, PtySpawner } from "@bazhen/core";

/** The PTY seam's only implementation. node-pty is pinned to a 1.2.0 beta: 1.1.0 leaks a PTY per spawn on macOS. */
function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export const nodePtySpawner: PtySpawner = {
  spawn(argv, size, env): PtyProcess {
    const [file, ...args] = argv;
    const proc = spawn(file, args, {
      name: "xterm-256color",
      cols: size.cols,
      rows: size.rows,
      env: { ...definedEnv(process.env), ...env, TERM: "xterm-256color" },
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

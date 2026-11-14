// `pnpm dev` as a developer's terminal runs it: in a pty, stopped with Ctrl-C. Linux only, for
// /proc and util-linux `script`: like every api helper, it runs on a disposable host.

import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { signalGroup, spawnGroup, TmuxServer } from "@bazhen/host-guard";
import { freePort, homeEnv, waitUntil } from "./daemon.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));

/** Reads a /proc entry of a process that may exit at any moment; undefined once it has. */
const proc = <T>(read: () => T): T | undefined => {
  try {
    return read();
  } catch {
    return undefined;
  }
};

const link = (path: string) => proc(() => readlinkSync(path));

/** A process's parent, group and its terminal's foreground group, from /proc/<pid>/stat. */
function stat(pid: number): { ppid: number; pgrp: number; tpgid: number } | undefined {
  return proc(() => {
    // The command name is in parentheses and may hold spaces; the fields after it are fixed.
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { ppid: Number(f[1]), pgrp: Number(f[2]), tpgid: Number(f[5]) };
  });
}

/** Every process below `root`. */
function descendants(root: number): number[] {
  const all = readdirSync("/proc")
    .filter((d) => /^\d+$/.test(d))
    .map((d) => ({ pid: Number(d), ppid: stat(Number(d))?.ppid }));
  const found: number[] = [];
  for (let frontier = [root]; frontier.length > 0;) {
    const parents = frontier;
    frontier = all
      .filter((p) => p.ppid !== undefined && parents.includes(p.ppid))
      .map((p) => p.pid);
    found.push(...frontier);
  }
  return found;
}

const commandLine = (pid: number) =>
  proc(() => readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim());

/**
 * `pnpm dev` on a fresh home and free ports, in the pty of a `script` that leads a process group
 * of this run's own. Ctrl-C goes in through `script`'s stdin, as a key would.
 */
export class DevRun {
  private readonly home: string;
  private readonly script: ChildProcess;
  private output = "";
  private exited = false;
  /** What `script -e` reports: pnpm's exit status, or 128 + the signal that ended it. */
  private status: number | null = null;
  /** Everything the run started, kept so `stop` can wait for processes reparented away. */
  private readonly seen = new Set<number>();

  private constructor(home: string, script: ChildProcess) {
    this.home = home;
    this.script = script;
    script.stdout?.on("data", (d: Buffer) => (this.output += d.toString()));
    script.on("exit", (code) => {
      this.status = code;
      this.exited = true;
    });
  }

  /** Started, once the daemon listens and vite is ready. */
  static async start(): Promise<DevRun> {
    const home = realpathSync(mkdtempSync("/tmp/bz-dev-"));
    const env = {
      ...homeEnv(home),
      TERM: "xterm-256color",
      BAZHEN_PORT: String(await freePort()),
      BAZHEN_WEB_PORT: String(await freePort()),
    };
    // `exec`, so the status is pnpm's: a non-interactive sh left in between dies of the Ctrl-C.
    const script = spawnGroup("script", ["-qefc", "exec pnpm dev", "/dev/null"], {
      cwd: repo,
      env,
      stdio: "pipe",
    });
    const run = new DevRun(home, script);
    try {
      await waitUntil(
        () => {
          run.record();
          return run.exited || (run.text.includes("listening on") && run.text.includes("ready in"));
        },
        "pnpm dev to start",
        90_000,
      );
      if (run.exited) throw new Error(`pnpm dev exited at start:\n${run.text}`);
    } catch (err) {
      await run.stop();
      throw err;
    }
    return run;
  }

  /** What the pty showed, without escape sequences. */
  get text(): string {
    return stripVTControlCharacters(this.output);
  }

  /** The status pnpm gave each app so far, sorted. */
  statuses(): string[] {
    return (this.text.match(/apps\/\w+ dev: (?:Done|Failed)\b/g) ?? []).toSorted();
  }

  private record(): number[] {
    const pid = this.script.pid;
    const below = pid === undefined ? [] : descendants(pid);
    for (const p of below) this.seen.add(p);
    return below;
  }

  /**
   * The command lines of the processes under `pnpm dev` that hold its terminal on stdin, stdout
   * or stderr from outside the foreground process group, which the shell doesn't wait for.
   */
  backgroundHolders(): string[] {
    const [pnpm, ...rest] = this.record();
    const terminal = pnpm === undefined ? undefined : link(`/proc/${pnpm}/fd/0`);
    return rest
      .filter((pid) => {
        const s = stat(pid);
        const holds = [0, 1, 2].some((fd) => link(`/proc/${pid}/fd/${fd}`) === terminal);
        return holds && s !== undefined && s.pgrp !== s.tpgid;
      })
      .map((pid) => commandLine(pid) ?? `${pid} (exited)`);
  }

  /** Presses Ctrl-C and waits for `pnpm dev` to end; its exit status and each app's. */
  async interrupt(): Promise<{ exit: number | null; apps: string[] }> {
    this.record();
    this.script.stdin?.write("\x03");
    await waitUntil(() => this.exited, "pnpm dev to exit", 30_000);
    return { exit: this.status, apps: this.statuses() };
  }

  /**
   * Ends the whole tree, then removes the home. Killing `script` closes the pty, whose hangup
   * ends pnpm, and pnpm's own reaper then kills the process groups it gave each app. Nothing is
   * removed until every process the run started has gone.
   */
  async stop(): Promise<void> {
    this.record();
    if (!this.exited) signalGroup(this.script, "SIGKILL");
    await waitUntil(
      () => [...this.seen].every((pid) => !existsSync(`/proc/${pid}`)),
      "every process of pnpm dev to exit",
      20_000,
    );
    TmuxServer.at(join(this.home, "run", "tmux.sock"), { root: this.home }).kill();
    rmSync(this.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

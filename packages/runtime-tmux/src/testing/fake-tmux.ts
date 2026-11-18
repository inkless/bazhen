import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TmuxServer } from "@bazhen/host-guard";
import { TmuxRuntime, type TmuxRuntimeOptions } from "../index.ts";

/** The command a fake answers with its own path, and real tmux refuses before reaching a server. */
const IDENTIFY = "bz-fake-tmux-identify";

export interface FakeTmux {
  readonly runtime: TmuxRuntime;
  /** The directory the fake, its socket and whatever the script writes live in. */
  readonly root: string;
}

const made: string[] = [];

/**
 * A runtime whose every tmux command runs `script`, a shell script that is the only thing on its
 * PATH, with `FAKE_DIR` naming its directory. The script may use shell builtins and absolute
 * paths. It runs on the host, so it is confirmed to be the `tmux` every command resolves to
 * before the runtime is handed out.
 */
export function fakeTmux(
  script: string,
  opts: Pick<TmuxRuntimeOptions, "onError" | "processPollMs"> & {
    env?: Record<string, string>;
  } = {},
): FakeTmux {
  const root = mkdtempSync("/tmp/bz-fake-tmux-");
  made.push(root);
  const bin = join(root, "tmux");
  const identify = `case "$*" in *" ${IDENTIFY}") echo "$0"; exit 0 ;; esac\n`;
  writeFileSync(bin, script.replace(/^(#!.*\n)/, `$1${identify}`), { mode: 0o755 });
  const server = TmuxServer.at(join(root, "tmux.sock"), { root, config: join(root, "tmux.conf") });
  const env = { ...opts.env, PATH: root, FAKE_DIR: root };
  const resolved = server.runSync([IDENTIFY], { env }).trim();
  if (resolved !== bin) throw new Error(`tmux resolves to ${resolved}, not the fake at ${bin}`);
  const runtime = new TmuxRuntime({
    server,
    pty: {
      spawn: () => {
        throw new Error("no PTY here");
      },
    },
    env,
    ...(opts.onError === undefined ? {} : { onError: opts.onError }),
    ...(opts.processPollMs === undefined ? {} : { processPollMs: opts.processPollMs }),
  });
  return { runtime, root };
}

/** Removes every fake made so far, for an `afterEach`. */
export function removeFakes(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

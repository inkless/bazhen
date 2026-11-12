import { createHash } from "node:crypto";
import { homedir, tmpdir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface BazhenPaths {
  readonly config: string;
  readonly data: string;
  readonly bank: string;
  readonly state: string;
  readonly cache: string;
  /** Holds the daemon's Unix socket and instance lock; mode 0700. */
  readonly run: string;
  readonly socket: string;
  /** The private tmux server's socket, in `run`, so every instance has a server of its own. */
  readonly tmuxSocket: string;
}

export interface PathInputs {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly tmp: string;
  readonly uid: number;
  readonly flags?: { readonly home?: string; readonly bank?: string };
  readonly configBank?: string;
}

/** `sun_path` holds 104 bytes, including the terminating NUL. */
const MAX_SOCKET_PATH = 103;
const SOCKET_NAME = "bazhen.sock";
const TMUX_SOCKET_NAME = "tmux.sock";

const shortHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 8);
const absolute = (value: string | undefined) => (value?.startsWith("/") ? value : undefined);

/**
 * One XDG layout on macOS and Linux (foundation-design §6.1). Each location resolves from a CLI
 * flag, then the environment, then the config file, then the default.
 */
export function resolvePaths(i: PathInputs): BazhenPaths {
  const home = i.flags?.home ?? i.env.BAZHEN_HOME;
  if (home !== undefined && !isAbsolute(home)) {
    throw new RangeError(`BAZHEN_HOME must be an absolute path, not ${home}`);
  }
  // Normalised, so `/a` and `/a/` are one instance with one tmux server.
  const root = home === undefined ? undefined : resolve(home);
  const xdg = (name: string, fallback: string) =>
    join(absolute(i.env[name]) ?? join(i.home, fallback), "bazhen");
  const base = root
    ? {
        config: join(root, "config"),
        data: join(root, "data"),
        state: join(root, "state"),
        cache: join(root, "cache"),
        run: join(root, "run"),
      }
    : {
        config: xdg("XDG_CONFIG_HOME", ".config"),
        data: xdg("XDG_DATA_HOME", ".local/share"),
        state: xdg("XDG_STATE_HOME", ".local/state"),
        cache: xdg("XDG_CACHE_HOME", ".cache"),
        run: defaultRun(i),
      };
  const run =
    Buffer.byteLength(join(base.run, SOCKET_NAME)) > MAX_SOCKET_PATH
      ? `/tmp/bazhen-${i.uid}-${shortHash(base.run)}`
      : base.run;
  return {
    ...base,
    run,
    socket: join(run, SOCKET_NAME),
    bank: i.flags?.bank ?? i.env.BAZHEN_BANK ?? i.configBank ?? join(base.data, "bank"),
    tmuxSocket: join(run, TMUX_SOCKET_NAME),
  };
}

function defaultRun(i: PathInputs): string {
  if (i.platform === "darwin") return join(i.tmp, "bazhen");
  const runtime = absolute(i.env.XDG_RUNTIME_DIR);
  return runtime ? join(runtime, "bazhen") : `/tmp/bazhen-${i.uid}`;
}

/** This process's inputs to `resolvePaths`. */
export function currentInputs(flags?: PathInputs["flags"]): PathInputs {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    tmp: tmpdir(),
    uid: userInfo().uid,
    ...(flags ? { flags } : {}),
  };
}

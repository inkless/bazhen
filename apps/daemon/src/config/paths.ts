import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export interface BazhenPaths {
  readonly config: string;
  readonly data: string;
  readonly bank: string;
  readonly state: string;
  readonly cache: string;
  readonly run: string;
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

/** Precedence: CLI flag, then environment, then config file, then the platform default. */
export function resolvePaths(i: PathInputs): BazhenPaths {
  const root = i.flags?.home ?? i.env.BAZHEN_HOME;
  const base = root
    ? {
        config: join(root, "config"),
        data: join(root, "data"),
        state: join(root, "state"),
        cache: join(root, "cache"),
        run: join(root, "run"),
      }
    : i.platform === "darwin"
      ? macDefaults(i)
      : xdgDefaults(i);
  const bank = i.flags?.bank ?? i.env.BAZHEN_BANK ?? i.configBank ?? join(base.data, "bank");
  return { ...base, bank };
}

function macDefaults(i: PathInputs) {
  const support = join(i.home, "Library", "Application Support", "Bazhen");
  return {
    config: support,
    data: support,
    state: join(i.home, "Library", "Logs", "Bazhen"),
    cache: join(i.home, "Library", "Caches", "Bazhen"),
    run: join(i.tmp, `bazhen-${i.uid}`),
  };
}

function xdgDefaults(i: PathInputs) {
  const xdg = (name: string, fallback: string) => {
    const value = i.env[name];
    return value && value.startsWith("/") ? value : join(i.home, fallback);
  };
  const runtime = i.env.XDG_RUNTIME_DIR;
  return {
    config: join(xdg("XDG_CONFIG_HOME", ".config"), "bazhen"),
    data: join(xdg("XDG_DATA_HOME", ".local/share"), "bazhen"),
    state: join(xdg("XDG_STATE_HOME", ".local/state"), "bazhen"),
    cache: join(xdg("XDG_CACHE_HOME", ".cache"), "bazhen"),
    run:
      runtime && runtime.startsWith("/") ? join(runtime, "bazhen") : join(i.tmp, `bazhen-${i.uid}`),
  };
}

export function currentPaths(flags?: PathInputs["flags"]): BazhenPaths {
  return resolvePaths({
    platform: process.platform,
    env: process.env,
    home: homedir(),
    tmp: tmpdir(),
    uid: userInfo().uid,
    ...(flags ? { flags } : {}),
  });
}

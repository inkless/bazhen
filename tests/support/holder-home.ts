// Where holder tests keep their holders: under the temporary BAZHEN_HOME their run made, and
// never under any other, a real one included.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HolderClient } from "@bazhen/runtime-holder";

type HolderProcessSpec = Parameters<HolderClient["respawn"]>[0];

/** The file in a run's home naming the run, and the variable that names it to the tests. */
export const RUN_MARKER = ".bz-holder-test-run";
export const RUN_ENV = "BZ_HOLDER_TEST_RUN";

export const holdersDir = (home: string) => join(home, "run", "holders");
/** tmux's socket directory, empty unless something ran tmux. */
export const tmuxDir = (home: string) => join(home, "tmux");
/** The directory first on PATH, whose `tmux` refuses to run. */
export const binDir = (home: string) => join(home, "bin");
/** HOME for whatever a holder runs, so no shell reads the user's rc files or writes their history. */
export const userDir = (home: string) => join(home, "home");

function markerIn(home: string): string | undefined {
  try {
    return readFileSync(join(home, RUN_MARKER), "utf8");
  } catch {
    return undefined;
  }
}

/** This run's BAZHEN_HOME. Throws for any home the run didn't make, so no test reaches a real one. */
export function testHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env["BAZHEN_HOME"];
  const run = env[RUN_ENV];
  if (home === undefined || run === undefined || markerIn(home) !== run) {
    throw new Error(
      `Refusing BAZHEN_HOME=${home ?? "(unset)"}: holder tests run only under the temporary ` +
        "home their run makes. Run them with pnpm test:real holder.",
    );
  }
  return home;
}

/** A terminal id as holder/1 has it: a plain file name, so its socket stays in the home. */
const TERMINAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The socket of the holder for `terminalId`, in this run's home. */
export function holderSocket(terminalId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!TERMINAL_ID.test(terminalId)) throw new Error(`${terminalId} is no terminal id`);
  return join(holdersDir(testHome(env)), `${terminalId}.sock`);
}

const XDG_DIRS = {
  XDG_CONFIG_HOME: ".config",
  XDG_CACHE_HOME: ".cache",
  XDG_DATA_HOME: ".local/share",
  XDG_STATE_HOME: ".local/state",
  XDG_RUNTIME_DIR: "run",
} as const;

/**
 * What a child may carry besides the guarded variables: terminal and locale settings, and a
 * test's own BZ_TEST_*. Anything else, such as BASH_ENV, ENV, ZDOTDIR, SSH_AUTH_SOCK, TMUX or
 * DBUS_SESSION_BUS_ADDRESS, could lead it to the user's shell setup, agents or tmux.
 */
const ALLOWED = new Set(["PATH", "TERM", "COLORTERM", "LANG", "LANGUAGE", "TZ"]);
const isAllowed = (name: string) =>
  ALLOWED.has(name) || /^LC_[A-Z]+$/.test(name) || /^BZ_TEST_[A-Z0-9_]+$/.test(name);

/** What a holder test's child must have as its environment, every other variable aside. */
function guardedEnv(home: string): Record<string, string> {
  const user = userDir(home);
  return {
    BAZHEN_HOME: home,
    HOME: user,
    TMUX_TMPDIR: tmuxDir(home),
    ...Object.fromEntries(Object.entries(XDG_DIRS).map(([name, dir]) => [name, join(user, dir)])),
  };
}

/**
 * The whole environment for a process a holder test's holder runs: HOME and XDG_* inside the
 * run's home, tmux's socket directory the run's, the run's tmux refusal first on PATH, and no
 * TMUX. A spec's env is all its child gets, so build every one with this.
 */
export function holderEnv(
  extra: Readonly<Record<string, string>> = {},
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const home = testHome(env);
  const path = env["PATH"] ?? "";
  return requireHolderEnv(
    { TERM: "xterm-256color", ...extra, ...guardedEnv(home), PATH: path },
    env,
  );
}

/**
 * Returns `childEnv` if it keeps a holder test's child from the user's tmux servers and files,
 * and throws otherwise. Whatever starts a holder or respawns its child passes the spec's env here.
 */
export function requireHolderEnv(
  childEnv: Readonly<Record<string, string>>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const home = testHome(env);
  const guarded = guardedEnv(home);
  const wrong = Object.entries(guarded)
    .filter(([name, value]) => childEnv[name] !== value)
    .map(([name]) => name);
  if (childEnv["PATH"]?.split(":")[0] !== binDir(home)) wrong.push("PATH");
  const unknown = Object.keys(childEnv).filter((name) => !(name in guarded) && !isAllowed(name));
  if (wrong.length > 0 || unknown.length > 0) {
    throw new Error(
      `Refusing a holder test's child environment: ${[...wrong, ...unknown].join(", ")} ` +
        `could reach outside ${home}. Build it with holderEnv(), whose extras may be only ` +
        "terminal and locale variables or BZ_TEST_*.",
    );
  }
  return { ...childEnv };
}

/** A process spec for a holder test: `argv` run in the run's HOME, with `holderEnv(extra)`. */
export function holderProcessSpec(
  argv: readonly [string, ...string[]],
  extra: Readonly<Record<string, string>> = {},
  env: NodeJS.ProcessEnv = process.env,
): HolderProcessSpec {
  return {
    argv: [...argv],
    cwd: userDir(testHome(env)),
    env: holderEnv(extra, env),
    generation: 0,
  };
}

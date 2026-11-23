// The daemons a run on the host may start that the whole user then shares, so that one left
// running is no leak of the run's. A name is only a first filter: anything can call itself
// `catatonit`. What leaves a daemon out is its shared identity, matched against this process's own
// state, never the run's: a daemon a test started with a `HOME` of its own holds other paths and
// counts. A daemon no entry identifies counts too, so one missing here fails a run by its name.
// Nothing reads another process's `/proc/<pid>/environ`: a daemon may hold secrets there.

import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/** A live process of the run's that a shared daemon's name matches, as `/proc` shows it. */
export interface Candidate {
  readonly pid: number;
  readonly name: string;
  readonly argv: readonly string[];
  /** The inodes of the sockets it holds, from its `/proc/<pid>/fd` links. */
  readonly sockets: ReadonlySet<number>;
}

/** This process's own state that a shared daemon's identity is matched against. */
export interface Own {
  /** The pid in podman's `$XDG_RUNTIME_DIR/libpod/tmp/pause.pid`. */
  readonly pausePid?: number;
  /** `gpgconf --list-dirs homedir`. */
  readonly gpgHome?: string;
  /** The inodes bound at `gpgconf --list-dirs agent-socket`, from `/proc/net/unix`. */
  readonly gpgSockets: ReadonlySet<number>;
}

export interface SharedDaemon {
  /** Its `comm`, the first filter. */
  readonly name: string;
  readonly why: string;
  readonly is: (candidate: Candidate, own: Own) => boolean;
}

const argValue = (argv: readonly string[], flag: string) => {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
};

export const SHARED_DAEMONS: readonly SharedDaemon[] = [
  {
    name: "catatonit",
    why:
      "podman's pause process holds the rootless user namespace every podman of the user joins, " +
      "and the first podman to need it starts it",
    is: (c, own) => c.argv.includes("-P") && own.pausePid !== undefined && c.pid === own.pausePid,
  },
  {
    name: "gpg-agent",
    why:
      "gpg starts the agent for its home on first use, and every gpg of the user with that home " +
      "then talks to it",
    is: (c, own) => {
      const home = argValue(c.argv, "--homedir");
      if (home !== undefined && own.gpgHome !== undefined && home === own.gpgHome) return true;
      return [...c.sockets].some((inode) => own.gpgSockets.has(inode));
    },
  },
];

/** Which of `candidates` a `SHARED_DAEMONS` entry identifies, by pid. */
export function sharedAmong(
  candidates: readonly Candidate[],
  own: Own,
  daemons: readonly SharedDaemon[] = SHARED_DAEMONS,
): Set<number> {
  return new Set(
    candidates
      .filter((c) => daemons.some((d) => d.name === c.name && d.is(c, own)))
      .map((c) => c.pid),
  );
}

/** Whether a process named `name` is one a shared daemon's name matches. */
export const mayBeShared = (name: string, daemons: readonly SharedDaemon[] = SHARED_DAEMONS) =>
  daemons.some((d) => d.name === name);

/** The inodes `/proc/net/unix`'s `text` lists as bound at `path`. */
export function unixInodes(text: string, path: string): Set<number> {
  const inodes = new Set<number>();
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length >= 8 && fields.slice(7).join(" ") === path) inodes.add(Number(fields[6]));
  }
  return inodes;
}

/** The socket inodes among `links`, the targets of a process's `/proc/<pid>/fd` entries. */
export const socketInodes = (links: readonly string[]) =>
  new Set(
    links.flatMap((link) => {
      const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
      return inode === undefined ? [] : [Number(inode)];
    }),
  );

const readOrUndefined = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** A live process's argv and the sockets it holds, read from `/proc`. */
export function candidateOf(pid: number, name: string): Candidate {
  const argv = (readOrUndefined(`/proc/${pid}/cmdline`) ?? "").split("\0").filter(Boolean);
  let links: string[] = [];
  try {
    const dir = `/proc/${pid}/fd`;
    links = readdirSync(dir).flatMap((fd) => {
      try {
        return [readlinkSync(join(dir, fd))];
      } catch {
        return [];
      }
    });
  } catch {
    // Gone, or not readable: it holds no socket this can see, so only its argv can identify it.
  }
  return { pid, name, argv, sockets: socketInodes(links) };
}

/**
 * This process's own state, as `gpgDirs` (the lines of `gpgconf --list-dirs agent-socket homedir`,
 * or undefined where gpgconf isn't there) and `$XDG_RUNTIME_DIR` give it.
 */
export function ownState(runtimeDir: string | undefined, gpgDirs: string | undefined): Own {
  const pause =
    runtimeDir === undefined
      ? undefined
      : readOrUndefined(join(runtimeDir, "libpod", "tmp", "pause.pid"));
  const pausePid = pause === undefined ? Number.NaN : Number(pause.trim());
  const [socket, home] = (gpgDirs ?? "").split("\n");
  const unix = socket ? readOrUndefined("/proc/net/unix") : undefined;
  return {
    ...(Number.isSafeInteger(pausePid) && pausePid > 1 ? { pausePid } : {}),
    ...(home ? { gpgHome: home } : {}),
    gpgSockets: socket && unix !== undefined ? unixInodes(unix, socket) : new Set(),
  };
}

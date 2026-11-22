import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { heard } from "@bazhen/host-guard";
import { afterEach, describe, expect, it } from "vitest";
import { fullBacklog } from "../testing/full-backlog.ts";
import {
  type Claimed,
  DRAIN_MS,
  claim,
  LockUnavailable,
  lockOf,
  lockOpened,
  tryLock,
} from "./lock.ts";
import type { Answer } from "./probe.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function socketPath(): string {
  const dir = mkdtempSync("/tmp/bz-lock-");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "bazhen.sock");
}

/** The lock for `socket`'s fd, which must be free. */
function taken(socket: string): number {
  const fd = tryLock(lockOf(socket));
  if (fd === null) throw new Error("the lock was already held");
  return fd;
}

/** The lock for `socket`, held by this process until the test ends or it is let go. */
function held(socket: string): () => void {
  const fd = taken(socket);
  let open = true;
  const letGo = () => {
    if (open) closeSync(fd);
    open = false;
  };
  cleanups.push(letGo);
  return letGo;
}

/** Whether another process, as `flock(2)` in the Rust daemon does, finds the lock free. */
function freeToOthers(socket: string): boolean {
  return spawnSync("flock", ["--nonblock", lockOf(socket), "true"]).status === 0;
}

async function answering(): Promise<string> {
  const socket = socketPath();
  const server = createServer((_req, res) => res.end(JSON.stringify({ status: "ok" })));
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return socket;
}

const QUICK = { waitMs: 300, locks: true } as const;
const nothing = async (): Promise<Answer> => ({ kind: "nothing" });
const daemon = async (): Promise<Answer> => ({ kind: "daemon", protocolId: null });

function letGoOf(claimed: Claimed): Claimed {
  if (claimed.kind === "taken" && claimed.fd !== null) closeSync(claimed.fd);
  return claimed;
}

describe.runIf(process.platform === "linux")("claim", () => {
  it("names the lock beside the socket", () => {
    expect(lockOf("/h/run/bazhen.sock")).toBe("/h/run/bazhen.sock.lock");
  });

  it("holds off a second open, even in this process, and a flock from another, until let go", () => {
    const socket = socketPath();
    const letGo = held(socket);
    const second = tryLock(lockOf(socket));
    const othersWhileHeld = freeToOthers(socket);
    const mode = statSync(lockOf(socket)).mode & 0o777;
    letGo();
    expect([second, othersWhileHeld, freeToOthers(socket), mode]).toEqual([
      null,
      false,
      true,
      0o600,
    ]);
  });

  it("takes a free lock only where nothing answers on the socket", async () => {
    const free = socketPath();
    const stuck = socketPath();
    const backlog = await fullBacklog(stuck);
    cleanups.push(() => backlog.close());
    const answered = await answering();
    const claimed = [
      letGoOf(await claim(free, QUICK)),
      letGoOf(await claim(stuck, QUICK)),
      letGoOf(await claim(answered, QUICK)),
    ];
    expect(claimed).toEqual([
      { kind: "taken", fd: expect.any(Number) },
      {
        kind: "refused",
        message: expect.stringMatching(
          new RegExp(`^bazhen won't start over ${stuck}: something may hold it`),
        ),
      },
      { kind: "refused", message: `bazhen is already running on ${answered}` },
    ]);
    expect([free, stuck, answered].map(freeToOthers)).toEqual([true, true, true]);
  });

  it("refuses at once where the lock is held and its daemon answers", async () => {
    const socket = socketPath();
    held(socket);
    const begun = Date.now();
    const claimed = await claim(socket, { ...QUICK, waitMs: 5000, probe: daemon });
    expect(claimed).toEqual({ kind: "refused", message: `bazhen is already running on ${socket}` });
    expect(Date.now() - begun).toBeLessThan(1000);
  });

  it("gives up on a held lock whose daemon never answers, after the wait", async () => {
    const socket = socketPath();
    held(socket);
    const begun = Date.now();
    const claimed = await claim(socket, { ...QUICK, probe: nothing });
    const took = Date.now() - begun;
    expect(claimed).toEqual({
      kind: "refused",
      message: `bazhen won't start: another daemon holds ${lockOf(socket)} but doesn't answer on ${socket}; it may be stuck`,
    });
    expect(took).toBeGreaterThanOrEqual(QUICK.waitMs);
    expect(took).toBeLessThan(QUICK.waitMs * 3);
  });

  it("takes a lock let go during the wait", async () => {
    const socket = socketPath();
    const letGo = held(socket);
    setTimeout(letGo, 150);
    const claimed = letGoOf(await claim(socket, { ...QUICK, waitMs: 5000, probe: nothing }));
    expect(claimed).toEqual({ kind: "taken", fd: expect.any(Number) });
  });

  it("takes no lock on a file since replaced at its path, and lets that one go", () => {
    const socket = socketPath();
    const path = lockOf(socket);
    const opened = openSync(path, "w");
    rmSync(path);
    writeFileSync(path, "");
    const onTheOld = lockOpened(opened, path);
    const onTheNew = taken(socket);
    cleanups.push(() => closeSync(onTheNew));
    expect([onTheOld, freeToOthers(socket)]).toEqual([null, false]);
  });

  it("refuses, and lets go, where the path can't be checked after the flock", () => {
    const socket = socketPath();
    const opened = openSync(lockOf(socket), "w");
    const looping = `${socket}.loop`;
    symlinkSync(looping, looping);
    expect(() => lockOpened(opened, looping)).toThrow(LockUnavailable);
    expect(freeToOthers(socket)).toBe(true);
    expect(() => fstatSync(opened)).toThrow(/EBADF/);
  });

  it("refuses, naming the cause, where flock can't be run", async () => {
    const socket = socketPath();
    const path = process.env["PATH"];
    process.env["PATH"] = "/nonexistent";
    cleanups.push(() => {
      process.env["PATH"] = path;
    });
    expect(await claim(socket, { ...QUICK, probe: nothing })).toEqual({
      kind: "refused",
      message: `bazhen can't lock ${lockOf(socket)}: flock isn't on PATH (util-linux has it)`,
    });
  });
});

/** A child started as `startHolder` starts one, waiting on its stdin until the test closes it. */
function child(extra: number | null): ChildProcess {
  const started = heard(
    spawn("/bin/sh", ["-c", "read line || true"], {
      env: {},
      cwd: "/",
      stdio: extra === null ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", extra],
    }),
  );
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        started.once("exit", () => resolve());
        started.stdin?.end();
      }),
  );
  return started;
}

describe.runIf(process.platform === "linux")("a child started while the lock is held", () => {
  it("doesn't keep it once the daemon lets go", () => {
    const socket = socketPath();
    const letGo = held(socket);
    child(null);
    letGo();
    expect(freeToOthers(socket)).toBe(true);
  });

  it("keeps it if handed the lock file, so the case above would be seen", () => {
    const socket = socketPath();
    const fd = taken(socket);
    child(fd);
    closeSync(fd);
    expect(freeToOthers(socket)).toBe(false);
  });
});

describe("claim where this daemon takes no lock", () => {
  it("only probes", async () => {
    const socket = socketPath();
    expect(await claim(socket, { locks: false, probe: nothing })).toEqual({
      kind: "taken",
      fd: null,
    });
    expect(await claim(socket, { locks: false, probe: daemon })).toEqual({
      kind: "refused",
      message: `bazhen is already running on ${socket}`,
    });
  });
});

describe("the wait on a held lock", () => {
  it("covers the Rust daemon's drain, as serve.rs sets it", () => {
    const serve = readFileSync(
      new URL("../../../../crates/bazhen-daemon/src/serve.rs", import.meta.url),
      "utf8",
    );
    const drain = /^ {4}drain: Duration::from_secs\((\d+)\),$/m.exec(serve)?.[1];
    expect(Number(drain) * 1000).toBe(DRAIN_MS);
  });
});

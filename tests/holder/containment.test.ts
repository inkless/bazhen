// Each terminal contained in a systemd scope of its own, on a real user manager. Runs only in CI's
// containment job, where lingering gives the runner one, and fails rather than passes where
// terminals can't be contained, so a runner that stops giving one can't turn it green.
//
// Every allocator stops itself at ALLOC_STOP, so a cap that fails to fire costs the run that much
// and a failed assertion, never the runner's memory.

import { connectHolder, type HolderClient } from "@bazhen/runtime-holder";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  cappedAt,
  cgroupOfPid,
  memoryMax,
  oomKills,
  probeSuite,
  type Scoped,
  swapMax,
  unitProperty,
} from "../support/holder-containment.ts";
import {
  closeHolder,
  processStart,
  type SpawnedHolder,
  spawnHolder,
  START_SKEW_S,
} from "../support/holder-spawn.ts";

const MIB = 1024 ** 2;
const ALLOC_STOP = 384 * MIB;
/** 16 MiB every 20 ms, held, up to ALLOC_STOP; then it idles, alive. */
const ALLOCATOR = `const a = []; setInterval(() => a.length < ${ALLOC_STOP / (16 * MIB)} && a.push(Buffer.alloc(16 << 20, 1)), 20)`;
const TERMINAL_SCOPE = /\/bazhen\.slice\/bazhen-terminals\.slice\/bazhen-terminal-[\w-]+\.scope$/;

let scoped: Scoped;
const running: SpawnedHolder[] = [];
const clients: HolderClient[] = [];

beforeAll(async () => {
  const containment = await probeSuite();
  if (containment.kind !== "scoped") {
    throw new Error(`this runner can't contain terminals: ${containment.why}`);
  }
  scoped = containment;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.end();
  await Promise.all(running.splice(0).map((holder) => closeHolder(holder)));
});

async function started(
  terminalId: string,
  argv: readonly [string, ...string[]],
  containment: Scoped | "unscoped" = scoped,
) {
  const options = containment === "unscoped" ? {} : { containment };
  const holder = await spawnHolder(terminalId, argv, options);
  running.push(holder);
  return holder;
}

async function hello(holder: SpawnedHolder) {
  const client = await connectHolder(holder.socket, { onEvent: () => {} });
  clients.push(client);
  return client.hello;
}

/** How far `pid`'s start, as `ps` says now, lies from `start`. */
async function startSkew(pid: number, start: number): Promise<number> {
  const now = await processStart(pid);
  if (now === null) throw new Error(`${pid} has no process`);
  return Math.abs(now - start);
}

/** The OOMPolicy each scope should carry: continue where systemd takes it, else its default. */
const expectedOomPolicy = () => (scoped.oomPolicy ? "continue" : "stop");

const until = async (done: () => boolean | Promise<boolean>, what: string, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`${what} never happened`);
    await new Promise((wait) => setTimeout(wait, 50));
  }
};

describe("a holder started in a scope", () => {
  it("runs in a terminal's scope of its own, under the terminal's caps, its child with it", async () => {
    const holder = await started("scoped", ["sleep", "60"]);
    const { childPid } = await hello(holder);
    const cgroup = cgroupOfPid(holder.pid);
    expect(cgroup).toMatch(TERMINAL_SCOPE);
    expect(cgroupOfPid(childPid)).toBe(cgroup);
    expect(Number(memoryMax(cgroup))).toBe(256 * MIB);
    expect(swapMax(cgroup)).toBe("0");
    expect(unitProperty(cgroup, "OOMPolicy")).toBe(expectedOomPolicy());
  });

  it("keeps the pid and start it was recorded under, which the launcher's exec doesn't change", async () => {
    const holder = await started("same-pid", ["sleep", "60"]);
    const said = await hello(holder);
    expect(said.holderPid).toBe(holder.pid);
    expect(await startSkew(holder.pid, holder.start)).toBeLessThanOrEqual(START_SKEW_S);
    expect(Math.abs(said.holderStart - holder.start)).toBeLessThanOrEqual(START_SKEW_S);
  });

  it("gets a scope no other terminal shares", async () => {
    const [a, b] = await Promise.all([
      started("own-a", ["sleep", "60"]),
      started("own-b", ["sleep", "60"]),
    ]);
    expect(cgroupOfPid(a.pid)).not.toBe(cgroupOfPid(b.pid));
  });

  it("is told apart from one started without a scope, which stays where it was started", async () => {
    const holder = await started("unscoped", ["sleep", "60"], "unscoped");
    expect(cgroupOfPid(holder.pid)).not.toMatch(TERMINAL_SCOPE);
  });
});

describe("a terminal past its memory cap", () => {
  it("loses only the process past it: its holder reports the kill, and other terminals run on", async () => {
    const node = process.execPath;
    const sibling = await started("sibling", ["sleep", "60"]);
    const under = await started("under-cap", [node, "-e", ALLOCATOR], cappedAt(scoped, "768M"));
    const over = await started("over-cap", [node, "-e", ALLOCATOR], cappedAt(scoped, "128M"));
    const overCgroup = cgroupOfPid(over.pid);
    let exit: Awaited<ReturnType<typeof hello>>["exit"] = null;
    await until(async () => {
      exit = (await hello(over)).exit;
      return exit !== null;
    }, "the over-cap child's exit");
    expect(exit).toEqual({ type: "signalled", signal: "SIGKILL" });
    expect(oomKills(overCgroup)).toBeGreaterThanOrEqual(1);
    expect((await hello(over)).holderPid).toBe(over.pid);
    // The under-cap control: the same allocator, its cap above what it takes, is never killed.
    await new Promise((wait) => setTimeout(wait, 1_500));
    expect((await hello(under)).exit).toBeNull();
    expect(oomKills(cgroupOfPid(under.pid))).toBe(0);
    expect((await hello(sibling)).exit).toBeNull();
  });
});

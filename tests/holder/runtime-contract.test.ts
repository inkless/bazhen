// The runtime contract and the snapshot attach contract, on HolderRuntime with real holders.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  newId,
  runtimeContract,
  snapshotContract,
  type SnapshotHarness,
} from "@bazhen/core/testing";
import { describe, expect, it, onTestFinished } from "vitest";
import { replay } from "@bazhen/daemon/testing";
import { connectHolder, type HolderEvent, HolderRuntime } from "@bazhen/runtime-holder";
import { holderEnv, holderProcessSpec, testHome, userDir } from "../support/holder-home.ts";
import { oscProbe } from "../support/osc-probe.ts";
import {
  closeHolder,
  HOLDER_BINARY,
  holderStarter,
  killTestHolder,
  type SpawnedHolder,
} from "../support/holder-spawn.ts";

type Runtime = ReturnType<SnapshotHarness["make"]>["runtime"];

/** How long a child killed from outside has to be seen to exit. */
const EXIT_MS = 10_000;
type Ref = Parameters<SnapshotHarness["forge"]>[0];

interface Made {
  readonly root: string;
  readonly started: SpawnedHolder[];
}

const made = new Map<Runtime, Made>();
let count = 0;

function madeOf(runtime: Runtime): Made {
  const found = made.get(runtime);
  if (found === undefined) throw new Error("not a runtime this harness made");
  return found;
}

const socketsOf = (root: string) => {
  const dir = join(root, "holders");
  return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : [];
};

/** Closes the terminal by its holder's protocol, from outside the runtime. */
async function closeFromOutside(socket: string): Promise<void> {
  const client = await connectHolder(socket, { onEvent: () => {} });
  await client.close();
  await client.ended;
}

/** Kills the child from outside the runtime, then respawns it as the next generation. */
async function replaceFromOutside(socket: string): Promise<void> {
  const { promise: exited, resolve } = Promise.withResolvers<void>();
  const onEvent = (event: HolderEvent) => {
    if (event.type === "exited") resolve();
  };
  const client = await connectHolder(socket, { onEvent });
  try {
    await client.signal("SIGKILL");
    const deadline = new Promise<never>((_, refuse) =>
      setTimeout(
        () => refuse(new Error(`${socket}'s child outlived its SIGKILL`)),
        EXIT_MS,
      ).unref(),
    );
    await Promise.race([exited, deadline]);
    const next = { ...holderProcessSpec(["sleep", "300"]), generation: client.generation + 1 };
    await client.respawn(next);
  } finally {
    client.end();
  }
}

/** A HolderRuntime under a root of its own in the run's home, and how to end its holders. */
function holderRuntime() {
  const root = join(testHome(), `r${++count}`);
  mkdirSync(root, { mode: 0o700 });
  const started: SpawnedHolder[] = [];
  const runtime = new HolderRuntime({
    root,
    binary: HOLDER_BINARY,
    env: holderEnv(),
    exitPollMs: 50,
    start: holderStarter(started),
  });
  made.set(runtime, { root, started });
  return {
    runtime,
    dispose: () => {
      // Readable again first, or nothing could close them.
      for (const socket of socketsOf(root)) chmodSync(socket, 0o600);
      // One that won't close stays in the ledger, and the run's teardown reports it.
      void Promise.allSettled(started.map((holder) => closeHolder(holder)));
    },
  };
}

const harness: SnapshotHarness = {
  make: holderRuntime,
  // Every socket closed to this user: the holders run on, and no client reaches them.
  unreadable: (runtime) => {
    for (const socket of socketsOf(madeOf(runtime).root)) chmodSync(socket, 0o000);
  },
  // A holder only respawns as a later generation, so the replacement is a generation on.
  replaceProcess: (_, ref) => replaceFromOutside(ref.locator.socket ?? ""),
  vanish: (_, ref) => closeFromOutside(ref.locator.socket ?? ""),
  reboot: async (runtime) => {
    await Promise.all(madeOf(runtime).started.map((holder) => killTestHolder(holder)));
  },
  forge: (ref: Ref) => ({ ...ref, locator: { ...ref.locator, holderStart: "1" } }),
  placeOf: (ref) => ref.locator.socket,
  exitMayBeUnknown: false,
  pastes: false,
  // Resolved, as the OS reports a process's directory: macOS's /tmp is a link to /private/tmp.
  cwd: realpathSync(userDir(testHome())),
  waitMs: 10_000,
  replay,
};

runtimeContract("HolderRuntime", harness);
snapshotContract("HolderRuntime", harness);

describe("HolderRuntime: watching an agent's title", () => {
  it("hears a title its program sets after the watch opened, which never subscribed", async () => {
    const holders = holderRuntime();
    onTestFinished(() => holders.dispose());
    const { runtime } = holders;
    const told: string[] = [];
    onTestFinished(runtime.onTitle((terminalId) => told.push(terminalId)));
    const ref = await runtime.create({
      terminalId: newId("term"),
      tags: { kind: "agent", agentId: newId("agent") },
      argv: ["sh", "-c", "sleep 1; printf '\\033]2;the thread\\007'; exec sleep 300"],
      cwd: harness.cwd,
      env: {},
      size: { cols: 80, rows: 24 },
      generation: 0,
    });
    await expect.poll(() => told, { timeout: harness.waitMs }).toEqual([ref.terminalId]);
    expect(await runtime.title(ref)).toBe("");
    await expect
      .poll(() => told, { timeout: harness.waitMs })
      .toEqual([ref.terminalId, ref.terminalId]);
    expect(await runtime.title(ref)).toBe("the thread");
  });
});

/** How the process `ref` names ended, or null while it runs or isn't listed. */
async function exitOf(runtime: Runtime, ref: Ref) {
  const entry = (await runtime.inventory()).find(
    (e) =>
      e.ref.terminalId === ref.terminalId && e.ref.locator.generation === ref.locator.generation,
  );
  return entry?.exit ?? null;
}

describe("HolderRuntime: a terminal's theme", () => {
  it("tells a program asking at its first instruction the theme its terminal was created or respawned in, and dark for none", async () => {
    const holders = holderRuntime();
    onTestFinished(() => holders.dispose());
    const { runtime } = holders;
    const out = () => join(harness.cwd, `osc-${newId("term")}`);
    const [first, second, third] = [out(), out(), out()];
    const exited = (ref: Ref) => () => exitOf(runtime, ref);
    const spec = {
      terminalId: newId("term"),
      tags: { kind: "agent", agentId: newId("agent") },
      argv: oscProbe(first),
      cwd: harness.cwd,
      env: {},
      size: { cols: 80, rows: 24 },
      generation: 0,
    } as const;
    const light = await runtime.create({ ...spec, theme: "light" });
    await expect.poll(exited(light), { timeout: harness.waitMs }).not.toBeNull();
    const dark = await runtime.respawn(light, {
      ...spec,
      generation: 1,
      theme: "dark",
      argv: oscProbe(second),
    });
    await expect.poll(exited(dark), { timeout: harness.waitMs }).not.toBeNull();
    await runtime.respawn(dark, { ...spec, generation: 2, argv: oscProbe(third) });
    await expect.poll(() => existsSync(third), { timeout: harness.waitMs }).toBe(true);
    expect([first, second, third].map((f) => readFileSync(f, "latin1"))).toEqual([
      "\x1b]11;rgb:fdfd/fdfd/fdfd\x1b\\",
      "\x1b]11;rgb:0f0f/0f0f/1010\x1b\\",
      "\x1b]11;rgb:0f0f/0f0f/1010\x1b\\",
    ]);
  });
});

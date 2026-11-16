// The runtime contract and the snapshot attach contract, on HolderRuntime with real holders.

import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runtimeContract, snapshotContract, type SnapshotHarness } from "@bazhen/core/testing";
import { replay } from "@bazhen/daemon/testing";
import { connectHolder, type HolderEvent, HolderRuntime } from "@bazhen/runtime-holder";
import { holderEnv, holderProcessSpec, testHome, userDir } from "../support/holder-home.ts";
import {
  closeHolder,
  HOLDER_BINARY,
  holderStarter,
  killTestHolder,
  type SpawnedHolder,
} from "../support/holder-spawn.ts";

type Runtime = ReturnType<SnapshotHarness["make"]>["runtime"];
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
    await exited;
    const next = { ...holderProcessSpec(["sleep", "300"]), generation: client.generation + 1 };
    await client.respawn(next);
  } finally {
    client.end();
  }
}

const harness: SnapshotHarness = {
  make: () => {
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
  },
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
  cwd: userDir(testHome()),
  waitMs: 10_000,
  replay,
};

runtimeContract("HolderRuntime", harness);
snapshotContract("HolderRuntime", harness);

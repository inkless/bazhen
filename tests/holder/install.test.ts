// A holder run from an installed build, while the next build installs beside it.

import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FRESH_MS,
  type HolderInstall,
  HolderRuntime,
  installHolder,
  pruneUnusedHolders,
} from "@bazhen/runtime-holder";
import { HOLDER_PROTOCOL_VERSION } from "@bazhen/protocol";
import { afterEach, expect, it } from "vitest";
import { holderEnv, runDir, testHome } from "../support/holder-home.ts";
import {
  closeHolder,
  HOLDER_BINARY,
  type SpawnedHolder,
  spawnHolder,
} from "../support/holder-spawn.ts";

const uid = process.getuid?.() ?? -1;
const running: SpawnedHolder[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((holder) => closeHolder(holder)));
});

function installed(result: HolderInstall) {
  if (result.installed === null) throw new Error(result.reason);
  return result.installed;
}

it("keeps a holder on the build it started from while the next installs, then prunes that build once it closes", async () => {
  const home = testHome();
  const dir = join(home, "install-state", "holder");
  const old = installed(await installHolder({ source: HOLDER_BINARY, dir, uid }));
  const holder = await spawnHolder("term_install", ["sleep", "300"], { binary: old.binary });
  running.push(holder);
  const inode = statSync(old.binary).ino;
  const bytes = readFileSync(old.binary);
  const runtime = new HolderRuntime({
    root: runDir(home),
    binary: old.binary,
    installDir: dir,
    env: holderEnv(),
  });

  mkdirSync(join(home, "next"));
  const nextSource = join(home, "next", "bazhen-holder");
  writeFileSync(nextSource, "the next build, which nothing here runs", { mode: 0o755 });
  const next = await installHolder({ source: nextSource, dir, uid });
  const whileRunning = {
    // Started outside any scope: not contained on Linux, unreadable where there are no cgroups.
    builds: (await runtime.builds())
      .filter((b) => b.terminalId === holder.terminalId)
      .map(({ contained, stats, ...build }) => ({
        ...build,
        scoped: contained === true,
        historyLines: stats?.historyLines,
      })),
    pruned: await pruneUnusedHolders(dir, uid, next),
    inode: statSync(old.binary).ino,
    same: readFileSync(old.binary).equals(bytes),
  };
  await closeHolder(holder);
  // As old as a build must be before a prune takes it, so only what runs it can keep it.
  const past = (Date.now() - FRESH_MS - 60_000) / 1000;
  utimesSync(join(dir, old.build), past, past);
  const afterClose = await pruneUnusedHolders(dir, uid, next);

  expect([whileRunning, afterClose, readdirSync(dir)]).toEqual([
    {
      builds: [
        {
          terminalId: holder.terminalId,
          build: old.build,
          protocol: [HOLDER_PROTOCOL_VERSION],
          scoped: false,
          socket: holder.socket,
          holderPid: holder.pid,
          historyLines: expect.any(Number),
        },
      ],
      pruned: [],
      inode,
      same: true,
    },
    [old.build],
    [installed(next).build],
  ]);
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterEnv, type RuntimeAdapter } from "@bazhen/core";
import { runtimeContract } from "@bazhen/core/testing";
import type { ConfiguredTmuxServer } from "@bazhen/host-guard";
import { TmuxRuntime } from "@bazhen/runtime-tmux";
import { nodePtySpawner } from "@bazhen/daemon/pty";
import { testServer, tmuxOut } from "./helpers.ts";

const servers = new Map<RuntimeAdapter, ConfiguredTmuxServer>();
let made = 0;

const runtimeOn = (server: ConfiguredTmuxServer) =>
  new TmuxRuntime({ server, pty: nodePtySpawner, env: filterEnv(process.env).env, exitPollMs: 50 });

function serverOf(runtime: RuntimeAdapter): ConfiguredTmuxServer {
  const server = servers.get(runtime);
  if (server === undefined) throw new Error("not a runtime this harness made");
  return server;
}

runtimeContract("TmuxRuntime", {
  make: () => {
    const server = testServer(`contract-${++made}`);
    const runtime = runtimeOn(server);
    servers.set(runtime, server);
    return { runtime, dispose: () => server.kill() };
  },
  unreachable: () => runtimeOn(testServer(`contract-none-${++made}`)),
  replacePane: (runtime, ref) => {
    const server = serverOf(runtime);
    tmuxOut(server, "split-window", "-d", "-t", String(ref.locator.sessionId), "sleep", "300");
    tmuxOut(server, "kill-pane", "-t", String(ref.locator.paneId));
  },
  vanish: (runtime, ref) => {
    tmuxOut(serverOf(runtime), "kill-session", "-t", String(ref.locator.sessionId));
  },
  cwd: mkdtempSync(join(tmpdir(), "bz-contract-")),
  // A loaded CI runner can take a second or more to reap a pane's process.
  waitMs: 10_000,
});

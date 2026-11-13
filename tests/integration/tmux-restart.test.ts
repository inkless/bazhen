// A tmux server that died, and one whose socket was deleted under it (foundation-design §7.1).
// Recreating a socket sends the recorded server SIGUSR1, whose default action ends any process
// that is not tmux, so every way a recorded identity can be wrong is shown to send nothing.
//
// The user's own default server is not started here: no test may run tmux on a default socket.
// Its refusal is pinned by host-guard's tmux.test.ts, on both forms ps gives its arguments, and
// a live tmux server on another socket stands in for it below.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { filterEnv, newId, type RuntimeRef, type TerminalSpec } from "@bazhen/core";
import { isAlive, type ConfiguredTmuxServer } from "@bazhen/host-guard";
import { TmuxRuntime } from "@bazhen/runtime-tmux";
import { nodePtySpawner } from "@bazhen/daemon/pty";
import { sleep, testServer } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "bz-restart-"));
let made = 0;
/** Every runtime a test made, with what it took to stop its server whatever state it was left in. */
const cleanups: (() => Promise<void>)[] = [];

const spec = (): TerminalSpec => ({
  terminalId: newId("term"),
  tags: { kind: "agent", agentId: newId("agent") },
  argv: ["sleep", "300"],
  cwd: dir,
  env: {},
  size: { cols: 80, rows: 24 },
  generation: 0,
});

/** A runtime on a server of its own, holding one terminal, and that terminal's ref. */
async function started(): Promise<{
  server: ConfiguredTmuxServer;
  runtime: TmuxRuntime;
  ref: RuntimeRef;
}> {
  const server = testServer(`restart-${++made}`);
  const runtime = new TmuxRuntime({ server, pty: nodePtySpawner, env: filterEnv(process.env).env });
  const ref = await runtime.create(spec());
  cleanups.push(async () => {
    // A server whose socket a test deleted is unreachable to kill: bring the socket back first.
    if (!existsSync(server.socket)) await runtime.health([ref]);
    if (await waitFor(() => existsSync(server.socket), 2_000)) server.kill();
  });
  return { server, runtime, ref };
}

async function waitFor(condition: () => boolean, ms = 5_000): Promise<boolean> {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(50))
    if (condition()) return true;
  return condition();
}

/** A pid no process has just now, inside every system's range (macOS's ends at 99999). */
const freePid = () =>
  String([...Array(2000).keys()].map((i) => 32_767 - i).find((pid) => !isAlive(pid)));

const withIdentity = (ref: RuntimeRef, serverPid: string, serverStart: string): RuntimeRef => ({
  ...ref,
  locator: { ...ref.locator, serverPid, serverStart },
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("a tmux server that is gone", () => {
  it("is not running, even against the refs it recorded, and holds no terminals", async () => {
    const { server, runtime, ref } = await started();
    server.kill();
    expect([(await runtime.health([ref])).state, await runtime.inventory()]).toEqual([
      "not-running",
      [],
    ]);
  });
});

describe("a live tmux server whose socket was deleted", () => {
  it("keeps its terminals from being counted closed, until the server itself is gone", async () => {
    const { server, runtime, ref } = await started();
    rmSync(server.socket);
    const whileLive = await runtime.close(ref).then(
      () => "closed",
      () => "refused",
    );
    await runtime.health([ref]);
    await waitFor(() => existsSync(server.socket));
    const kept = (await runtime.inventory()).map((e) => e.ref.terminalId);
    server.kill();
    const onceGone = await runtime.close(ref).then(
      () => "closed",
      () => "refused",
    );
    expect([whileLive, kept, onceGone]).toEqual(["refused", [ref.terminalId], "closed"]);
  });

  it("is unreachable against the refs it recorded, and gets its socket back", async () => {
    const { server, runtime, ref } = await started();
    rmSync(server.socket);
    expect((await runtime.health([ref])).state).toBe("unreachable");
    expect(await waitFor(() => existsSync(server.socket))).toBe(true);
    expect((await runtime.inventory()).map((e) => e.ref.terminalId)).toEqual([ref.terminalId]);
  });

  // Not running only where the recorded server is provably gone; anything that can't be told
  // apart from it concludes nothing. Either way nothing is sent, and each case ends with the true
  // ref recovering the server, so what held it back was the identity.
  const thisStart = String(Math.round(Date.now() / 1000 - process.uptime()));
  const forged: [string, "not-running" | "unreachable", (ref: RuntimeRef) => RuntimeRef][] = [
    ["a pid no process has", "not-running", (ref) => withIdentity(ref, freePid(), "1")],
    [
      "a process neither the server nor started when it did",
      "not-running",
      (ref) => withIdentity(ref, String(process.pid), "1"),
    ],
    [
      "a live process started when the server did that is not tmux",
      "unreachable",
      (ref) => withIdentity(ref, String(process.pid), thisStart),
    ],
    [
      "the server itself, started more than two seconds off",
      "unreachable",
      (ref) =>
        withIdentity(
          ref,
          String(ref.locator.serverPid),
          String(Number(ref.locator.serverStart) + 5),
        ),
    ],
  ];
  it.each(forged)("sends nothing against %s, and reads %s", async (_, expected, forge) => {
    const { server, runtime, ref } = await started();
    rmSync(server.socket);
    const read = (await runtime.health([forge(ref)])).state;
    await sleep(500);
    const untouched = !existsSync(server.socket);
    expect([read, untouched, (await runtime.health([ref])).state]).toEqual([
      expected,
      true,
      "unreachable",
    ]);
  });

  it("sends nothing against a live tmux server on another socket, and concludes nothing", async () => {
    const ours = await started();
    const other = await started();
    rmSync(ours.server.socket);
    rmSync(other.server.socket);
    const theirs = withIdentity(
      ours.ref,
      String(other.ref.locator.serverPid),
      String(other.ref.locator.serverStart),
    );
    const read = (await ours.runtime.health([theirs])).state;
    await sleep(500);
    const untouched = [existsSync(ours.server.socket), existsSync(other.server.socket)];
    expect([read, untouched, (await ours.runtime.health([ours.ref])).state]).toEqual([
      "unreachable",
      [false, false],
      "unreachable",
    ]);
  });
});

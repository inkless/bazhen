import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { filterEnv, newId, type RuntimeRef, type TerminalSpec } from "@bazhen/core";
import { isAlive } from "@bazhen/host-guard";
import { TmuxRuntime } from "@bazhen/runtime-tmux";
import { nodePtySpawner } from "@bazhen/daemon/pty";
import { testServer, tmuxOut } from "./helpers.ts";

// Generous, because a loaded CI runner can take a second or more to reap a pane's process.
const WAIT = 10_000;
const dir = mkdtempSync(join(tmpdir(), "bz-lifecycle-"));
const server = testServer("lifecycle");
const runtime = new TmuxRuntime({
  server,
  pty: nodePtySpawner,
  env: filterEnv({ ...process.env, BZ_USER_VALUE: "kept" }).env,
  exitPollMs: 50,
});
const spec = (argv: [string, ...string[]]): TerminalSpec => ({
  terminalId: newId("term"),
  tags: { kind: "agent", agentId: newId("agent") },
  argv,
  cwd: dir,
  env: {},
  size: { cols: 80, rows: 24 },
  generation: 0,
});

afterAll(() => server.kill());

const names = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.split("=")[0]);

/** How the runtime reports the pane's process ended, or null while it runs. */
const exitOf = async (ref: RuntimeRef) =>
  (await runtime.inventory()).find(
    (e) => e.ref.terminalId === ref.terminalId && e.ref.locator.paneId === ref.locator.paneId,
  )?.exit ?? null;

// Asks for the background as it starts, in raw mode first as a TUI is, and writes the reply, or
// nothing after 2 s. Raw mode after the query would flush a reply that came back quickly.
const oscProbe = (out: string): [string, ...string[]] => [
  "python3",
  "-c",
  `import os, select, sys, time, tty
tty.setraw(0)
os.write(1, b"\\x1b]11;?\\x1b\\\\")
got, end = b"", time.time() + 2
while time.time() < end and not got.endswith(b"\\x1b\\\\"):
    if select.select([0], [], [], max(0, end - time.time()))[0]:
        got += os.read(0, 256)
open(sys.argv[1], "wb").write(got)`,
  out,
];

const oscOut = () => join(dir, `osc-${newId("term")}`);

const deadOf = async (ref: RuntimeRef) => {
  await expect.poll(() => exitOf(ref), { timeout: WAIT }).not.toBeNull();
};

describe("tmux runtime lifecycle on a private server", () => {
  // The child ignores the hangup that follows its parent's exit, as a long-running tool may, so
  // only a signal to the whole group reaches it.
  it("signals the pane's whole process group, so the tools it started stop with it", async () => {
    const childPid = join(dir, `child-${newId("term")}`);
    const ref = await runtime.create(
      spec(["sh", "-c", `nohup sleep 300 >/dev/null 2>&1 & echo $! > ${childPid}; wait`]),
    );
    await expect.poll(() => readFileSync(childPid, "utf8").trim(), { timeout: WAIT }).not.toBe("");
    const child = Number(readFileSync(childPid, "utf8"));
    await runtime.signal(ref, "SIGTERM");
    await expect.poll(() => isAlive(child), { timeout: WAIT }).toBe(false);
  });

  it("refuses to signal a process replaced outside Bazhen, under the same generation", async () => {
    const ref = await runtime.create(spec(["sleep", "300"]));
    tmuxOut(server, "respawn-pane", "-k", "-t", String(ref.locator.paneId), "sleep", "300");
    await expect(runtime.signal(ref, "SIGKILL")).rejects.toMatchObject({
      reason: "process-replaced",
    });
    const [pid = "", dead = ""] = tmuxOut(
      server,
      "display-message",
      "-p",
      "-t",
      String(ref.locator.paneId),
      "#{pane_pid} #{pane_dead}",
    )
      .trim()
      .split(" ");
    expect([pid === ref.locator.panePid, dead]).toEqual([false, "0"]);
  });

  it("passes a variable whose value ends in ; through tmux whole", async () => {
    const out = join(dir, `semi-${newId("term")}`);
    await runtime.create({
      ...spec(["sh", "-c", `printf %s "$BZ_SEMI" > ${out}`]),
      env: { BZ_SEMI: "a;" },
    });
    await expect.poll(() => readFileSync(out, "utf8"), { timeout: WAIT }).toBe("a;");
  });

  it("gives a terminal no TMUX of its own, created or respawned, and keeps the user's variables", async () => {
    const created = join(dir, `env-${newId("term")}`);
    const respawned = join(dir, `env-${newId("term")}`);
    const s = spec(["sh", "-c", `env > ${created}`]);
    const ref = await runtime.create(s);
    await deadOf(ref);
    await runtime.respawn(ref, {
      ...s,
      generation: 1,
      argv: ["sh", "-c", `env > ${respawned}; sleep 300`],
    });
    await expect
      .poll(() => readFileSync(respawned, "utf8"), { timeout: WAIT })
      .toContain("BZ_USER_VALUE=kept");
    expect([names(created), names(respawned)]).toEqual([
      expect.not.arrayContaining(["TMUX", "TMUX_PANE"]),
      expect.not.arrayContaining(["TMUX", "TMUX_PANE"]),
    ]);
    expect(readFileSync(created, "utf8")).toContain("BZ_USER_VALUE=kept");
  });

  it("tells a program asking at its first instruction its terminal's theme, after a launch and a respawn into the other, and nothing once a respawn names none", async () => {
    const [first, second, third] = [oscOut(), oscOut(), oscOut()];
    const unthemed = spec(oscProbe(first));
    const ref = await runtime.create({ ...unthemed, theme: "light" });
    await deadOf(ref);
    const dark = await runtime.respawn(ref, {
      ...unthemed,
      generation: 1,
      theme: "dark",
      argv: oscProbe(second),
    });
    await deadOf(dark);
    // No theme, so no style, and no client attached to answer in its place.
    await runtime.respawn(dark, { ...unthemed, generation: 2, argv: oscProbe(third) });
    await expect.poll(() => existsSync(third), { timeout: WAIT }).toBe(true);
    expect([first, second, third].map((f) => readFileSync(f, "latin1"))).toEqual([
      "\x1b]11;rgb:fdfd/fdfd/fdfd\x1b\\",
      "\x1b]11;rgb:0f0f/0f0f/1010\x1b\\",
      "",
    ]);
  });
});

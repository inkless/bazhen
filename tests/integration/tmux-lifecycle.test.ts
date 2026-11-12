import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExitStatus } from "@bazhen/protocol";
import {
  filterEnv,
  newId,
  StaleIncarnation,
  type RuntimeRef,
  type TerminalSpec,
} from "@bazhen/core";
import { TmuxRuntime } from "@bazhen/runtime-tmux";
import { nodePtySpawner } from "@bazhen/daemon/pty";
import { killServer, sleep, testSocket, tmuxOut } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "bz-lifecycle-"));
const socket = testSocket("lifecycle");
const runtimeOn = (name: string) =>
  new TmuxRuntime({
    socket: name,
    pty: nodePtySpawner,
    configFile: join(dir, `${name}.conf`),
    env: filterEnv({ ...process.env, BZ_USER_VALUE: "kept" }).env,
    exitPollMs: 50,
  });
const runtime = runtimeOn(socket);
const spec = (argv: [string, ...string[]]): TerminalSpec => ({
  terminalId: newId("term"),
  tags: { kind: "agent", agentId: newId("agent") },
  argv,
  cwd: dir,
  env: {},
  size: { cols: 80, rows: 24 },
});

afterAll(() => killServer(socket));

/** The pane's process id and whether it has exited, read straight from tmux. */
const pane = (ref: RuntimeRef) => {
  const [pid = "", dead = ""] = tmuxOut(
    socket,
    "display-message",
    "-p",
    "-t",
    ref.locator.paneId ?? "",
    "#{pane_pid} #{pane_dead}",
  )
    .trim()
    .split(" ");
  return { pid, dead: dead === "1" };
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Exits reported for `terminalId`, collected until the returned stop is called. */
function exitsOf(terminalId: string) {
  const seen: { panePid: string | undefined; status: ExitStatus }[] = [];
  const stop = runtime.onExit((ref, status) => {
    if (ref.terminalId === terminalId) seen.push({ panePid: ref.locator.panePid, status });
  });
  return { seen, stop };
}

const names = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.split("=")[0]);

const deadOf = async (ref: RuntimeRef) => {
  await expect.poll(() => pane(ref).dead, { timeout: 3000 }).toBe(true);
};

describe("tmux runtime lifecycle on a private server", () => {
  it("reports an exit code, and a signal by name, for the pane's own process", async () => {
    const coded = await runtime.create(spec(["sh", "-c", "exit 3"]));
    const killed = await runtime.create(spec(["sleep", "300"]));
    const codes = exitsOf(coded.terminalId);
    const signals = exitsOf(killed.terminalId);
    await runtime.signal(killed, "SIGTERM");
    await expect.poll(() => codes.seen.at(-1)?.status).toEqual({ code: 3, signal: null });
    await expect.poll(() => signals.seen.at(-1)?.status).toEqual({ code: null, signal: "SIGTERM" });
    codes.stop();
    signals.stop();
  });

  it("respawns a dead pane in place, with a new process and the same pane", async () => {
    const s = spec(["sh", "-c", "exit 0"]);
    const ref = await runtime.create(s);
    await deadOf(ref);
    const next = await runtime.respawn(ref, { ...s, argv: ["sleep", "300"] });
    expect(next.locator.paneId).toBe(ref.locator.paneId);
    expect(next.locator.panePid).not.toBe(ref.locator.panePid);
    expect(pane(next)).toEqual({ pid: next.locator.panePid, dead: false });
  });

  it("reports a respawned pane's next exit under its new process", async () => {
    const s = spec(["sh", "-c", "exit 1"]);
    const ref = await runtime.create(s);
    await deadOf(ref);
    const next = await runtime.respawn(ref, { ...s, argv: ["sh", "-c", "sleep 0.5; exit 2"] });
    const running = pane(next).pid;
    const exits = exitsOf(ref.terminalId);
    await expect
      .poll(() => exits.seen.at(-1), { timeout: 3000 })
      .toEqual({ panePid: running, status: { code: 2, signal: null } });
    exits.stop();
  });

  it("refuses to respawn a pane whose process is still running, and leaves it running", async () => {
    const s = spec(["sleep", "300"]);
    const ref = await runtime.create(s);
    await expect(runtime.respawn(ref, s)).rejects.toMatchObject({ expected: "exited" });
    expect(pane(ref)).toEqual({ pid: ref.locator.panePid, dead: false });
  });

  // The child ignores the hangup that follows its parent's exit, as a long-running tool may, so
  // only a signal to the whole group reaches it.
  it("signals the pane's whole process group, so the tools it started stop with it", async () => {
    const childPid = join(dir, `child-${newId("term")}`);
    const ref = await runtime.create(
      spec(["sh", "-c", `nohup sleep 300 >/dev/null 2>&1 & echo $! > ${childPid}; wait`]),
    );
    await expect.poll(() => readFileSync(childPid, "utf8").trim(), { timeout: 3000 }).not.toBe("");
    const child = Number(readFileSync(childPid, "utf8"));
    await runtime.signal(ref, "SIGTERM");
    await expect.poll(() => alive(child), { timeout: 3000 }).toBe(false);
  });

  it("touches nothing when the server is not the one the terminal was created on", async () => {
    const ref = await runtime.create(spec(["sleep", "300"]));
    const forged = { ...ref, locator: { ...ref.locator, serverStart: "1" } };
    await expect(runtime.close(forged)).rejects.toThrow(StaleIncarnation);
    await expect(runtime.signal(forged, "SIGKILL")).rejects.toThrow(StaleIncarnation);
    expect(pane(ref).dead).toBe(false);
  });

  it("refuses to signal a process that has been replaced by a respawn", async () => {
    const s = spec(["sh", "-c", "exit 0"]);
    const ref = await runtime.create(s);
    await deadOf(ref);
    const next = await runtime.respawn(ref, { ...s, argv: ["sleep", "300"] });
    await expect(runtime.signal(ref, "SIGKILL")).rejects.toMatchObject({
      reason: "process-replaced",
    });
    expect(pane(next).dead).toBe(false);
  });

  it("closes a terminal, and counts one the server no longer has as closed", async () => {
    await runtime.create(spec(["sleep", "300"])); // keeps the server up once the others are gone
    const ref = await runtime.create(spec(["sleep", "300"]));
    const gone = await runtime.create(spec(["sleep", "300"]));
    tmuxOut(socket, "kill-session", "-t", String(gone.locator.sessionId));
    await runtime.close(ref);
    await runtime.close(gone);
    const left = tmuxOut(socket, "list-sessions", "-F", "#{session_id}").split("\n");
    expect(left).not.toContain(ref.locator.sessionId);
  });

  it("reports no exit while the server cannot be read", async () => {
    const unreachable = runtimeOn(testSocket("lifecycle-none"));
    const seen: string[] = [];
    const stop = unreachable.onExit((ref) => seen.push(ref.terminalId));
    await sleep(300);
    stop();
    expect(seen).toEqual([]);
  });

  it("gives a terminal no TMUX of its own, created or respawned, and keeps the user's variables", async () => {
    const created = join(dir, `env-${newId("term")}`);
    const respawned = join(dir, `env-${newId("term")}`);
    const s = spec(["sh", "-c", `env > ${created}`]);
    const ref = await runtime.create(s);
    await deadOf(ref);
    await runtime.respawn(ref, { ...s, argv: ["sh", "-c", `env > ${respawned}; sleep 300`] });
    await expect
      .poll(() => readFileSync(respawned, "utf8"), { timeout: 3000 })
      .toContain("BZ_USER_VALUE=kept");
    expect([names(created), names(respawned)]).toEqual([
      expect.not.arrayContaining(["TMUX", "TMUX_PANE"]),
      expect.not.arrayContaining(["TMUX", "TMUX_PANE"]),
    ]);
    expect(readFileSync(created, "utf8")).toContain("BZ_USER_VALUE=kept");
  });
});

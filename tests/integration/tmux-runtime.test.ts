import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { TerminalTags } from "@bazhen/core";
import { filterEnv, newId } from "@bazhen/core";
import { TmuxError, TmuxRuntime } from "@bazhen/runtime-tmux";
import { nodePtySpawner } from "@bazhen/daemon/pty";
import { killServer, ptyHandleCount, sleep, testSocket, tmuxOut } from "./helpers.ts";

const socket = testSocket("runtime");
// Only in the daemon's own environment: a pane that shows it inherited the daemon instead of the
// environment the runtime was given.
process.env["BZ_DAEMON_ONLY"] = "leaked";
const runtime = new TmuxRuntime({
  socket,
  pty: nodePtySpawner,
  configFile: join(mkdtempSync(join(tmpdir(), "bz-tmux-conf-")), "tmux.conf"),
  env: { ...filterEnv(process.env, { deny: ["BZ_DAEMON_ONLY"] }).env, BZ_USER_VALUE: "kept" },
});
const size = { cols: 100, rows: 30 };
const spec = (argv: [string, ...string[]], tags: TerminalTags = { kind: "agent" }) => ({
  terminalId: newId("term"),
  tags,
  argv,
  cwd: process.cwd(),
  env: {},
  size,
});

afterAll(() => killServer(socket));

const screen = (session: string | undefined) =>
  tmuxOut(socket, "capture-pane", "-p", "-t", `${String(session)}:0`);

describe("tmux runtime on a private server", () => {
  it("reports not-running before any terminal exists", async () => {
    expect((await runtime.health()).state).toBe("not-running");
  });

  it("finds a created terminal again by its Bazhen id, not by tmux numbering", async () => {
    const s = spec(["cat"]);
    await runtime.create(s);
    const found = (await runtime.inventory()).find((e) => e.ref.terminalId === s.terminalId);
    expect(found?.dead).toBe(false);
    expect((await runtime.health()).state).toBe("healthy");
  });

  it("keeps an exited terminal with its exit status", async () => {
    const s = spec(["sh", "-c", "exit 3"]);
    await runtime.create(s);
    await expect
      .poll(async () => (await runtime.inventory()).find((e) => e.ref.terminalId === s.terminalId))
      .toMatchObject({ dead: true, exitStatus: 3 });
  });

  it("round-trips input through an attached terminal", async () => {
    const ref = await runtime.create(spec(["cat"]));
    const stream = await runtime.attach(ref, size);
    let seen = "";
    stream.onData((b) => (seen += Buffer.from(b).toString("utf8")));
    stream.write(Buffer.from("ping-你好\r"));
    await expect.poll(() => seen, { timeout: 3000 }).toContain("ping-你好");
    stream.close();
  });

  it("passes Ctrl-B to the program instead of treating it as a tmux prefix", async () => {
    const ref = await runtime.create(spec(["cat"]));
    const stream = await runtime.attach(ref, size);
    let seen = "";
    stream.onData((b) => (seen += Buffer.from(b).toString("utf8")));
    stream.write(Buffer.from("\x02c"));
    await expect.poll(() => seen, { timeout: 3000 }).toContain("^B");
    const session = ref.locator.session;
    expect(session).toBeTypeOf("string");
    const windows = tmuxOut(socket, "list-windows", "-t", String(session));
    expect(windows.trim().split("\n")).toHaveLength(1);
    stream.close();
  });

  it("keeps a trailing semicolon in an argv element", async () => {
    const ref = await runtime.create(spec(["sh", "-c", 'printf "<%s>" "$1"; sleep 30', "_", "x;"]));
    const stream = await runtime.attach(ref, size);
    let seen = "";
    stream.onData((b) => (seen += Buffer.from(b).toString("utf8")));
    await expect.poll(() => seen, { timeout: 3000 }).toContain("<x;>");
    stream.close();
  });

  it("gives a pane the runtime's environment and its own variables, never the daemon's", async () => {
    const ref = await runtime.create({
      ...spec([
        "sh",
        "-c",
        'printf "<%s|%s|%s>" "$BZ_USER_VALUE" "$BAZHEN_AGENT_ID" "${BZ_DAEMON_ONLY-unset}"; sleep 30',
      ]),
      env: { BAZHEN_AGENT_ID: "agent-x" },
    });
    await expect
      .poll(() => screen(ref.locator.session), { timeout: 3000 })
      .toContain("<kept|agent-x|unset>");
  });

  it("copies no attaching client's variables into the session", () => {
    // An empty array option prints only its name; the default lists DISPLAY, SSH_AUTH_SOCK, …
    expect(tmuxOut(socket, "show-options", "-g", "update-environment").trim()).toBe(
      "update-environment",
    );
  });

  it("reads back an agent's and a linked shell's tags from the runtime", async () => {
    const agentId = newId("agent");
    const agentSpec = spec(["cat"], { kind: "agent", agentId });
    const shellSpec = spec(["cat"], { kind: "shell", linkedAgentId: agentId });
    await runtime.create(agentSpec);
    await runtime.create(shellSpec);
    const all = await runtime.inventory();
    const tagsOf = (id: string) => all.find((e) => e.ref.terminalId === id)?.tags;
    expect([tagsOf(agentSpec.terminalId), tagsOf(shellSpec.terminalId)]).toEqual([
      { kind: "agent", agentId },
      { kind: "shell", linkedAgentId: agentId },
    ]);
  });

  it("ignores a session it did not create, even one carrying a terminal id", async () => {
    const forged = newId("term");
    tmuxOut(socket, "new-session", "-d", "-s", "foreign", "cat");
    tmuxOut(socket, "set-option", "-t", "foreign", "@bazhen_terminal_id", forged);
    const ids = (await runtime.inventory()).map((e) => e.ref.terminalId);
    expect(ids).not.toContain(forged);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("reports a failed tmux command as a TmuxError carrying what tmux said", async () => {
    const ref = await runtime.create(spec(["cat"]));
    await runtime.close(ref);
    const error: unknown = await runtime.close(ref).catch((e: unknown) => e);
    expect(error).toMatchObject({
      args: ["kill-session", "-t", ref.locator.session],
      stderr: expect.stringMatching(/session/),
    });
    expect(error).toBeInstanceOf(TmuxError);
  });

  it("reports a resize that fails, instead of dropping the error", async () => {
    const ref = await runtime.create(spec(["cat"]));
    const stream = await runtime.attach(ref, size);
    await runtime.close(ref);
    await expect(stream.resize({ cols: 80, rows: 24 })).rejects.toThrow(TmuxError);
    stream.close();
  });

  it("returns to its PTY handle baseline after repeated attach and detach", async () => {
    const ref = await runtime.create(spec(["cat"]));
    const baseline = ptyHandleCount();
    let closes = 0;
    for (let i = 0; i < 30; i++) {
      const stream = await runtime.attach(ref, size);
      stream.onClose(() => closes++);
      await sleep(20);
      stream.close();
    }
    await expect.poll(ptyHandleCount, { timeout: 3000 }).toBeLessThanOrEqual(baseline);
    expect(closes).toBe(30);
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { newId, toTerminalId } from "@bazhen/core";
import { TmuxRuntime } from "@bazhen/runtime-tmux";
import { nodePtySpawner } from "@bazhen/daemon/pty";
import { killServer, ptyHandleCount, sleep, testSocket, waitFor } from "./helpers.ts";

const socket = testSocket("runtime");
const runtime = new TmuxRuntime({
  socket,
  pty: nodePtySpawner,
  configFile: join(mkdtempSync(join(tmpdir(), "bz-tmux-conf-")), "tmux.conf"),
});
const size = { cols: 100, rows: 30 };
const spec = (argv: [string, ...string[]]) => ({
  terminalId: toTerminalId(newId("term"))!,
  argv,
  cwd: process.cwd(),
  env: {},
  size,
});

afterAll(() => killServer(socket));

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
    let entry;
    for (let i = 0; i < 100 && !entry?.dead; i++) {
      entry = (await runtime.inventory()).find((e) => e.ref.terminalId === s.terminalId);
      if (!entry?.dead) await sleep(20);
    }
    expect(entry).toMatchObject({ dead: true, exitStatus: 3 });
  });

  it("round-trips input through an attached terminal", async () => {
    const ref = await runtime.create(spec(["cat"]));
    const stream = await runtime.attach(ref, size);
    let seen = "";
    stream.onData((b) => (seen += Buffer.from(b).toString("utf8")));
    stream.write(Buffer.from("ping-你好\r"));
    expect(await waitFor(() => seen.includes("ping-你好"))).toBe(true);
    stream.close();
  });

  it("passes Ctrl-B to the program instead of treating it as a tmux prefix", async () => {
    const ref = await runtime.create(spec(["cat"]));
    const stream = await runtime.attach(ref, size);
    let seen = "";
    stream.onData((b) => (seen += Buffer.from(b).toString("utf8")));
    stream.write(Buffer.from("\x02c"));
    expect(await waitFor(() => seen.includes("^B"))).toBe(true);
    const session = ref.locator.session ?? "";
    const windows = execFileSync("tmux", ["-L", socket, "list-windows", "-t", session]).toString();
    expect(windows.trim().split("\n")).toHaveLength(1);
    stream.close();
  });

  it("keeps a trailing semicolon in an argv element", async () => {
    const ref = await runtime.create(spec(["sh", "-c", 'printf "<%s>" "$1"; sleep 30', "_", "x;"]));
    const stream = await runtime.attach(ref, size);
    let seen = "";
    stream.onData((b) => (seen += Buffer.from(b).toString("utf8")));
    expect(await waitFor(() => seen.includes("<x;>"))).toBe(true);
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
    await waitFor(() => ptyHandleCount() <= baseline, 3000);
    expect(ptyHandleCount()).toBeLessThanOrEqual(baseline);
    expect(closes).toBe(30);
  });
});

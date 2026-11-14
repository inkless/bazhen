import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listenFakeHolder, type FakeHolderServer } from "@bazhen/runtime-holder/testing";
import { afterEach, describe, expect, it } from "vitest";
import { holdersDir } from "../support/holder-home.ts";
import {
  closeLiveHolders,
  RUN_PREFIX,
  setup,
  teardown,
  teardownReport,
} from "../support/holder-setup.ts";

const dirs: string[] = [];
const fakes: FakeHolderServer[] = [];

// A scratch home, not the run's own, whose leaks would fail the run.
function scratchHome(): string {
  const home = mkdtempSync(`${RUN_PREFIX}leak-`);
  dirs.push(home);
  mkdirSync(holdersDir(home), { recursive: true });
  mkdirSync(join(home, "tmux"));
  return home;
}

async function fakeAt(...args: Parameters<typeof listenFakeHolder>) {
  const fake = await listenFakeHolder(...args);
  fakes.push(fake);
  return fake;
}

/** Sets up a run of its own, whose home `afterEach` removes whatever its test leaves. */
function ownRun(): string {
  setup();
  const home = String(process.env["BAZHEN_HOME"]);
  dirs.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("closeLiveHolders", () => {
  it("closes a holder still answering, through the protocol, and names it with its pid", async () => {
    const dir = holdersDir(scratchHome());
    const socket = join(dir, "t1.sock");
    await fakeAt(socket, { hello: { terminalId: "t1", holderPid: 777 } });
    await expect(closeLiveHolders(dir)).resolves.toEqual([
      { socket, terminalId: "t1", holderPid: 777, closed: true, hello: null },
    ]);
    expect(existsSync(socket)).toBe(false);
  });

  it("names a holder that answers close but doesn't hang up, as one that may still run", async () => {
    const dir = holdersDir(scratchHome());
    const socket = join(dir, "t3.sock");
    await fakeAt(socket, { hello: { terminalId: "t3", holderPid: 779 }, close: "stays" });
    await expect(closeLiveHolders(dir, 200)).resolves.toEqual([
      { socket, terminalId: "t3", holderPid: 779, closed: false, hello: null },
    ]);
  });

  it("doesn't count a holder as closed when its connection ends by breaking the protocol", async () => {
    const dir = holdersDir(scratchHome());
    const socket = join(dir, "bad.sock");
    const fake = await fakeAt(socket, {
      hello: { terminalId: "bad", holderPid: 780 },
      close: "ignores",
    });
    const closing = closeLiveHolders(dir, 500);
    const holder = await fake.connection();
    const close = await holder.request();
    holder.send({ type: "ok", id: close.id, body: { request: "close" } });
    holder.sendRaw(Uint8Array.of(0, 0, 0, 0));
    await expect(closing).resolves.toEqual([
      { socket, terminalId: "bad", holderPid: 780, closed: false, hello: null },
    ]);
  });

  it("names a holder that answers hello but ignores close", async () => {
    const dir = holdersDir(scratchHome());
    const socket = join(dir, "t2.sock");
    await fakeAt(socket, { hello: { terminalId: "t2", holderPid: 778 }, close: "ignores" });
    await expect(closeLiveHolders(dir, 200)).resolves.toEqual([
      { socket, terminalId: "t2", holderPid: 778, closed: false, hello: null },
    ]);
  });

  it("passes over a socket whose holder is gone", async () => {
    const dir = holdersDir(scratchHome());
    const live = join(dir, "gone.live");
    const fake = await listenFakeHolder(live);
    linkSync(live, join(dir, "gone.sock"));
    await fake.close();
    await expect(closeLiveHolders(dir)).resolves.toEqual([]);
  });

  it("names a holder that takes the connection but never answers hello", async () => {
    const dir = holdersDir(scratchHome());
    const socket = join(dir, "stuck.sock");
    await fakeAt(socket, { hello: false });
    await expect(closeLiveHolders(dir, 200)).resolves.toEqual([
      { socket, terminalId: null, holderPid: null, closed: false, hello: expect.any(String) },
    ]);
  });

  it("names a holder whose hello this build can't read", async () => {
    const dir = holdersDir(scratchHome());
    const socket = join(dir, "newer.sock");
    await fakeAt(socket, { hello: { version: "9.0" } });
    await expect(closeLiveHolders(dir, 200)).resolves.toEqual([
      expect.objectContaining({ socket, closed: false, hello: expect.stringContaining("9.0") }),
    ]);
  });

  it("refuses a directory outside the holder tests' own, however it is spelled", async () => {
    await expect(closeLiveHolders("/run/user/1000/bazhen/holders")).rejects.toThrow(/Refusing/);
    await expect(closeLiveHolders(`${RUN_PREFIX}x/../../run/user`)).rejects.toThrow(/Refusing/);
  });
});

describe("teardownReport", () => {
  it("reports nothing for a home left clean, and lets it go", async () => {
    await expect(teardownReport(scratchHome())).resolves.toEqual({ problems: [], keep: false });
  });

  it("fails the run naming a holder it had to close, and lets the home go", async () => {
    const home = scratchHome();
    await fakeAt(join(holdersDir(home), "t1.sock"), { hello: { terminalId: "t1", holderPid: 7 } });
    const report = await teardownReport(home);
    expect(report.keep).toBe(false);
    expect(report.problems).toEqual([expect.stringContaining("t1 (pid 7, closed)")]);
  });

  it("keeps the home in place while a holder in it may still be running", async () => {
    const home = scratchHome();
    const socket = join(holdersDir(home), "t2.sock");
    await fakeAt(socket, { hello: { terminalId: "t2", holderPid: 8 }, close: "ignores" });
    const report = await teardownReport(home, 200);
    expect(report.keep).toBe(true);
    expect(report.problems).toEqual([
      expect.stringContaining("t2 (pid 8, didn't close in time; may still run)"),
      expect.stringContaining(`Left ${home} in place`),
    ]);
  });

  it("fails the run, keeping the home, when anything appears in tmux's socket directory", async () => {
    const home = scratchHome();
    writeFileSync(join(home, "tmux", "tmux-1000"), "");
    await expect(teardownReport(home)).resolves.toEqual({
      problems: [
        expect.stringContaining(`Left ${home} in place`),
        `A holder test ran tmux, which made tmux-1000 in ${home}/tmux: stop its server by its socket there.`,
      ],
      keep: true,
    });
  });
});

describe("setup and teardown", () => {
  const runEnv = { ...process.env };

  afterEach(() => {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, runEnv);
  });

  it("drops inherited Bazhen variables, which would reach a real daemon", () => {
    process.env["BAZHEN_SOCKET"] = "/run/user/1000/bazhen/bazhen.sock";
    ownRun();
    expect(process.env["BAZHEN_SOCKET"]).toBeUndefined();
  });

  it("removes a home left clean without failing the run", async () => {
    const home = ownRun();
    await expect(teardown()).resolves.toBeUndefined();
    expect(existsSync(home)).toBe(false);
  });

  it("fails the run naming a holder left in its home, once it has closed it", async () => {
    const home = ownRun();
    await fakeAt(join(holdersDir(home), "left.sock"), {
      hello: { terminalId: "left", holderPid: 9 },
    });
    await expect(teardown()).rejects.toThrow("left (pid 9, closed)");
    expect(existsSync(home)).toBe(false);
  });

  it("keeps the home, tmux refusal included, while a holder in it may still run", async () => {
    const home = ownRun();
    await fakeAt(join(holdersDir(home), "stuck.sock"), {
      hello: { terminalId: "stuck", holderPid: 10 },
      close: "stays",
    });
    await expect(teardown()).rejects.toThrow("may still run");
    expect(existsSync(join(home, "bin", "tmux"))).toBe(true);
  });
});

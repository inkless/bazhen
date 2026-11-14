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

  it("names a holder that answers hello but ignores close", async () => {
    const dir = holdersDir(scratchHome());
    const socket = join(dir, "t2.sock");
    await fakeAt(socket, { hello: { terminalId: "t2", holderPid: 778 }, answersClose: false });
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

  it("refuses a directory outside the holder tests' own", async () => {
    await expect(closeLiveHolders("/run/user/1000/bazhen/holders")).rejects.toThrow(/Refusing/);
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
    await fakeAt(socket, { hello: { terminalId: "t2", holderPid: 8 }, answersClose: false });
    const report = await teardownReport(home, 200);
    expect(report.keep).toBe(true);
    expect(report.problems).toEqual([
      expect.stringContaining("t2 (pid 8, ignored close; may still run)"),
      `Left ${home} in place, as a holder in it may still be running.`,
    ]);
  });

  it("fails the run when anything appears in tmux's socket directory", async () => {
    const home = scratchHome();
    writeFileSync(join(home, "tmux", "tmux-1000"), "");
    await expect(teardownReport(home)).resolves.toEqual({
      problems: ["A holder test ran tmux, which made tmux-1000."],
      keep: false,
    });
  });
});

describe("setup and teardown", () => {
  const runEnv = { ...process.env };

  afterEach(() => {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, runEnv);
  });

  it("removes a home left clean without failing the run", async () => {
    setup();
    const home = String(process.env["BAZHEN_HOME"]);
    await expect(teardown()).resolves.toBeUndefined();
    expect(existsSync(home)).toBe(false);
  });

  it("fails the run naming a holder left in its home, once it has closed it", async () => {
    setup();
    const home = String(process.env["BAZHEN_HOME"]);
    const socket = join(holdersDir(home), "left.sock");
    await fakeAt(socket, { hello: { terminalId: "left", holderPid: 9 } });
    await expect(teardown()).rejects.toThrow("left (pid 9, closed)");
    expect(existsSync(home)).toBe(false);
  });
});

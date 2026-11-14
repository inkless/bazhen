import { existsSync, linkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { listenFakeHolder, type FakeHolderServer } from "@bazhen/runtime-holder/testing";
import { afterEach, describe, expect, it } from "vitest";
import { closeLiveHolders } from "../support/holder-setup.ts";

const dirs: string[] = [];
const fakes: FakeHolderServer[] = [];

// A scratch directory, not the run's own holders' directory, whose leaks would fail the run.
function scratch(): string {
  const dir = mkdtempSync("/tmp/bz-h-leak-");
  dirs.push(dir);
  return dir;
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
    const dir = scratch();
    const socket = join(dir, "t1.sock");
    await fakeAt(socket, { hello: { terminalId: "t1", holderPid: 777 } });
    await expect(closeLiveHolders(dir)).resolves.toEqual([
      { socket, terminalId: "t1", holderPid: 777, closed: true },
    ]);
    expect(existsSync(socket)).toBe(false);
  });

  it("passes over a socket whose holder is gone", async () => {
    const dir = scratch();
    const live = join(dir, "gone.live");
    const fake = await listenFakeHolder(live);
    linkSync(live, join(dir, "gone.sock"));
    await fake.close();
    await expect(closeLiveHolders(dir)).resolves.toEqual([]);
  });

  it("names a holder that takes the connection but never answers hello", async () => {
    const dir = scratch();
    const socket = join(dir, "stuck.sock");
    await fakeAt(socket, { hello: false });
    await expect(closeLiveHolders(dir, 200)).resolves.toEqual([
      { socket, terminalId: null, holderPid: null, closed: false },
    ]);
  });
});

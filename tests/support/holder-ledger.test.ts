import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  entryText,
  inTestHome,
  ownerGone,
  parseEntry,
  type Start,
  sweep,
  type SweepDeps,
} from "./holder-ledger.ts";

// The Rust binary tests read and write this ledger too, held to the same checked-in entry.
const FIXTURE = readFileSync(new URL("fixtures/holder-ledger-entry", import.meta.url), "utf8");
const ENTRY = {
  holder: 4242,
  holderStart: 1_794_630_000,
  owner: 4243,
  ownerStart: 1_794_629_990,
  socket: "/tmp/bz-h-abc/run/holders/t1.sock",
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A ledger directory of the test's own, holding `entries` by file name. */
function ledgerWith(entries: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bz-ledger-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(entries)) writeFileSync(join(dir, name), text);
  return dir;
}

/** Sweep effects that kill nothing, recording what would have been. */
function fakes(owner: Start, overrides: Partial<SweepDeps> = {}) {
  const killed: number[] = [];
  const deps: SweepDeps = {
    list: (dir) => readdirSync(dir),
    startOf: async () => owner,
    vouch: async (holder) => holder,
    killHolder: (proof) => {
      killed.push(proof.pid);
      return true;
    },
    now: Date.now,
    sandboxed: () => true,
    ...overrides,
  };
  return { deps, killed };
}

describe("the holder ledger", () => {
  it("refuses to sweep off a disposable host, before it reads the ledger", async () => {
    const listed: string[] = [];
    const { deps, killed } = fakes("absent", {
      sandboxed: () => false,
      list: (dir) => {
        listed.push(dir);
        return [];
      },
    });
    await expect(sweep("/nonexistent/ledger", deps)).rejects.toThrow("pnpm test:real holder");
    expect([listed, killed]).toEqual([[], []]);
  });

  it("reads and writes the entry the Rust binary tests do", () => {
    expect(parseEntry("4242", FIXTURE)).toEqual(ENTRY);
    expect(entryText(ENTRY)).toBe(FIXTURE);
  });

  it("reads nothing from a file that isn't an entry", () => {
    for (const [name, text] of [
      ["4242", "1794630000\n4243\n1794629990\n"],
      ["4242", FIXTURE.slice(0, -1)],
      ["x", FIXTURE],
      ["4242", FIXTURE.replace("4243", "-1")],
      ["4242", "1794630000\n4243\n1794629990\n\n"],
    ] as const) {
      expect(parseEntry(name, text)).toBeUndefined();
    }
  });

  it("counts an owner gone only when no process, or another, has its pid", () => {
    expect(ownerGone(ENTRY, "absent")).toBe(true);
    expect(ownerGone(ENTRY, ENTRY.ownerStart + 60)).toBe(true);
    expect(ownerGone(ENTRY, ENTRY.ownerStart + 2)).toBe(false);
    expect(ownerGone(ENTRY, "unreadable")).toBe(false);
  });

  it("knows a test holder by its socket", () => {
    expect(inTestHome(ENTRY.socket)).toBe(true);
    expect(inTestHome("/tmp/bz-hb-1-x/t1.sock")).toBe(true);
    expect(inTestHome("/home/u/.bazhen/run/holders/t1.sock")).toBe(false);
    expect(inTestHome("/tmp/bz-h-x/../../home/u/t1.sock")).toBe(false);
  });

  it("kills a gone owner's holder and forgets it", async () => {
    const dir = ledgerWith({ "4242": FIXTURE });
    const { deps, killed } = fakes("absent");
    expect(await sweep(dir, deps)).toBe(1);
    expect(killed).toEqual([4242]);
    expect(existsSync(join(dir, "4242"))).toBe(false);
  });

  it("spares a holder whose owner may live, or whose socket isn't a test's", async () => {
    const outside = entryText({ ...ENTRY, socket: "/home/u/.bazhen/run/holders/t1.sock" });
    for (const [owner, text] of [
      ["unreadable", FIXTURE],
      [ENTRY.ownerStart, FIXTURE],
      ["absent", outside],
    ] as const) {
      const { deps, killed } = fakes(owner);
      await sweep(ledgerWith({ "4242": text }), deps);
      expect(killed).toEqual([]);
    }
  });

  it("goes on past an entry removed while it sweeps", async () => {
    const dir = ledgerWith({ "4242": FIXTURE });
    const { deps, killed } = fakes("absent", {
      list: () => ["4241", "4242"],
    });
    expect(await sweep(dir, deps)).toBe(1);
    expect(killed).toEqual([4242]);
  });

  it("keeps an entry rewritten while it sweeps, a new holder's at the same pid", async () => {
    const dir = ledgerWith({ "4242": FIXTURE });
    const renewed = entryText({
      ...ENTRY,
      owner: process.pid,
      holderStart: ENTRY.holderStart + 60,
    });
    const { deps } = fakes("absent", {
      killHolder: () => {
        writeFileSync(join(dir, "4242"), renewed);
        return true;
      },
    });
    await sweep(dir, deps);
    expect(readFileSync(join(dir, "4242"), "utf8")).toBe(renewed);
  });

  it("removes what isn't an entry once it is a day old, and not before", async () => {
    const dir = ledgerWith({ "4242.99.partial": "half" });
    const fresh = fakes("absent");
    await sweep(dir, fresh.deps);
    expect(existsSync(join(dir, "4242.99.partial"))).toBe(true);
    const later = fakes("absent", { now: () => Date.now() + 2 * 24 * 60 * 60 * 1000 });
    await sweep(dir, later.deps);
    expect(existsSync(join(dir, "4242.99.partial"))).toBe(false);
  });
});

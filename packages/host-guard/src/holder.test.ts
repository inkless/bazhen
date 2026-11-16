import { describe, expect, it } from "vitest";
import { holderSocket, holderSocketRefusal, vouchHolder } from "./holder.ts";
import { killHolder, rebindHolder } from "./signal.ts";
import type { PsReading } from "./tmux.ts";

// Above every system's pid limit, so even a broken guard reaches no process.
const holder = { pid: 2 ** 22 + 1, start: 1_794_630_000 };
const reads = (reading: PsReading) => async (): Promise<PsReading> => reading;
const facts = (comm: string, start: number): PsReading => ({ comm, start, args: comm });

describe("the holder kill guard", () => {
  it("vouches for a bazhen-holder that started when the ledger says", async () => {
    const proof = await vouchHolder(holder, reads(facts("/x/bazhen-holder", holder.start + 2)));
    expect(proof).toEqual(holder);
  });

  it("vouches for nothing else at the pid", async () => {
    const others: PsReading[] = [
      facts("bazhen-holderx", holder.start),
      facts("sleep", holder.start),
      facts("bazhen-holder", holder.start + 3),
      facts("bazhen-holder", holder.start - 3),
      "absent",
      "unreadable",
    ];
    for (const reading of others) {
      expect(await vouchHolder(holder, reads(reading))).toBeNull();
    }
  });

  it("kills only a holder vouched for in the last second, and only once", async () => {
    expect(() => killHolder(holder)).toThrow("unvouched");
    const stale = await vouchHolder(holder, reads(facts("bazhen-holder", holder.start)), () => 0);
    expect(() => killHolder(stale!, 1_001)).toThrow("stale proof");
    const proof = await vouchHolder(holder, reads(facts("bazhen-holder", holder.start)));
    expect(killHolder(proof!)).toBe(false);
    expect(() => killHolder(proof!)).toThrow("unvouched");
  });
});

describe("the holder rebind guard", () => {
  it("signals only a holder vouched for in the last second, and only once", async () => {
    expect(() => rebindHolder(holder)).toThrow("unvouched");
    const stale = await vouchHolder(holder, reads(facts("bazhen-holder", holder.start)), () => 0);
    expect(() => rebindHolder(stale!, 1_001)).toThrow("stale proof");
    expect(await vouchHolder(holder, reads(facts("sleep", holder.start)))).toBeNull();
    const proof = await vouchHolder(holder, reads(facts("bazhen-holder", holder.start)));
    expect(rebindHolder(proof!)).toBe(false);
    expect(() => rebindHolder(proof!)).toThrow("unvouched");
  });

  it("takes no proof made for a kill twice: one proof, one signal", async () => {
    const proof = await vouchHolder(holder, reads(facts("bazhen-holder", holder.start)));
    expect(killHolder(proof!)).toBe(false);
    expect(() => rebindHolder(proof!)).toThrow("unvouched");
  });
});

describe("a holder's socket", () => {
  const root = "/run/bz";

  it("may be only the terminal's own socket in the run root's holders directory", () => {
    expect(holderSocketRefusal(holderSocket(root, "term_1"), root, "term_1")).toBeUndefined();
    const refused: [string, string][] = [
      ["/run/bz/holders/term_2.sock", "term_1"],
      ["/run/bz/term_1.sock", "term_1"],
      ["/run/bz/holders/x/../term_1.sock", "term_1"],
      ["run/bz/holders/term_1.sock", "term_1"],
      ["/tmp/holders/term_1.sock", "term_1"],
      ["/run/bz/holders/a/b.sock", "a/b"],
      ["/run/bz/holders/.sock", ""],
    ];
    const allowed = refused.filter(
      ([socket, id]) => holderSocketRefusal(socket, root, id) === undefined,
    );
    expect(allowed).toEqual([]);
  });

  it("is refused over 103 bytes, which macOS can't bind", () => {
    const fits = `/${"r".repeat(103 - "/holders/".length - "x.sock".length - 1)}`;
    expect(holderSocketRefusal(holderSocket(fits, "x"), fits, "x")).toBeUndefined();
    expect(holderSocketRefusal(holderSocket(`${fits}r`, "x"), `${fits}r`, "x")).toMatch(/103/);
  });

  it("is refused under a root that isn't absolute and normalized", () => {
    expect(holderSocketRefusal("/run/bz/holders/t.sock", "/run/bz/", "t")).toMatch(/root/);
  });
});

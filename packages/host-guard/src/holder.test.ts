import { afterEach, describe, expect, it, vi } from "vitest";
import {
  holderBuildOf,
  holderSocket,
  holderSocketRefusal,
  rebindHolderWith,
  vouchHolderWith,
} from "./holder.ts";
import { killHolder, killHolderAt, rebindHolder, rebindHolderAt } from "./signal.ts";
import type { PsReading } from "./tmux.ts";

// Above every system's pid limit, so even a broken guard reaches no process.
const holder = { pid: 2 ** 22 + 1, start: 1_794_630_000 };
const reads = (reading: PsReading) => async (): Promise<PsReading> => reading;
const facts = (comm: string, start: number): PsReading => ({ comm, start, args: comm });
const theHolder = reads(facts("/x/bazhen-holder", holder.start));

afterEach(() => vi.restoreAllMocks());

/** Whatever would be sent, recorded instead. */
const stubKill = () => vi.spyOn(process, "kill").mockImplementation(() => true);

describe("the holder kill guard", () => {
  it("vouches for a bazhen-holder that started when the ledger says", async () => {
    const proof = await vouchHolderWith(
      holder,
      "kill",
      reads(facts("/x/bazhen-holder", holder.start + 2)),
    );
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
    const vouched = await Promise.all(others.map((r) => vouchHolderWith(holder, "kill", reads(r))));
    expect(vouched).toEqual(others.map(() => null));
  });

  it("kills only a holder vouched for in the last second, and only once", async () => {
    const kill = stubKill();
    expect(() => killHolder(holder)).toThrow("unvouched");
    const stale = await vouchHolderWith(holder, "kill", theHolder, () => 0);
    expect(() => killHolderAt(stale!, 1_001)).toThrow("stale proof");
    const proof = await vouchHolderWith(holder, "kill", theHolder);
    expect(killHolder(proof!)).toBe(true);
    expect(() => killHolder(proof!)).toThrow("unvouched");
    expect(kill.mock.calls).toEqual([[holder.pid, "SIGKILL"]]);
  });
});

describe("the holder rebind guard", () => {
  it("sends SIGUSR1 only to a holder vouched for a rebind in the last second, and only once", async () => {
    const kill = stubKill();
    expect(() => rebindHolder(holder)).toThrow("unvouched");
    const stale = await vouchHolderWith(holder, "rebind", theHolder, () => 0);
    expect(() => rebindHolderAt(stale!, 1_001)).toThrow("stale proof");
    const proof = await vouchHolderWith(holder, "rebind", theHolder);
    expect(rebindHolder(proof!)).toBe(true);
    expect(() => rebindHolder(proof!)).toThrow("unvouched");
    expect(kill.mock.calls).toEqual([[holder.pid, "SIGUSR1"]]);
  });

  it("never takes a proof made for the other kind of signal", async () => {
    const kill = stubKill();
    const forKill = await vouchHolderWith(holder, "kill", theHolder);
    expect(() => rebindHolder(forKill!)).toThrow("unvouched");
    const forRebind = await vouchHolderWith(holder, "rebind", theHolder);
    expect(() => killHolder(forRebind!)).toThrow("unvouched");
    expect(kill).not.toHaveBeenCalled();
  });

  it("rebinds a holder ps shows, and nothing else at its pid", async () => {
    const sent: unknown[] = [];
    const send = (proof: unknown) => (sent.push(proof), true);
    const others = [
      facts("sleep", holder.start),
      facts("bazhen-holder", holder.start + 9),
      "absent" as const,
    ];
    for (const reading of others) {
      expect(await rebindHolderWith(holder, reads(reading), send)).toBe(false);
    }
    expect(await rebindHolderWith(holder, theHolder, send)).toBe(true);
    expect(sent).toEqual([holder]);
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

describe("the build a holder runs", () => {
  const dir = "/home/u/.local/state/bazhen/holder";
  const build = "0123456789abcdef";

  it("is read from an argv[0] installed under the directory, with or without arguments", () => {
    expect([
      holderBuildOf(`${dir}/${build}/bazhen-holder`, dir),
      holderBuildOf(`${dir}/${build}/bazhen-holder --flag`, dir),
    ]).toEqual([build, build]);
  });

  it("is null for any other process, however close its path", () => {
    const others = [
      `/bin/sh -c ulimit -t 5 && exec "$0" "$@" ${dir}/${build}/bazhen-holder`,
      `vim ${dir}/${build}/bazhen-holder`,
      `${dir}x/${build}/bazhen-holder`,
      `${dir}/${build}0/bazhen-holder`,
      `${dir}/0123456789ABCDEF/bazhen-holder`,
      `${dir}/${build}/bazhen-holderx`,
      `${dir}/${build}/sub/bazhen-holder`,
      `${dir}/${build}`,
      `${dir}/.tmp-01234567/bazhen-holder`,
    ];
    expect(others.map((args) => holderBuildOf(args, dir))).toEqual(others.map(() => null));
  });
});

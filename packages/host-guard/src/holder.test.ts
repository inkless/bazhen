import { describe, expect, it } from "vitest";
import { vouchHolder } from "./holder.ts";
import { killHolder } from "./signal.ts";
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

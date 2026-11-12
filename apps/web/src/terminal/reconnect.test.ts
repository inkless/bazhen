import { describe, expect, it } from "vitest";
import { Backoff } from "./reconnect.ts";

const take = (backoff: Backoff, count: number) =>
  Array.from({ length: count }, () => backoff.next());

describe("reattach backoff", () => {
  it("waits a quarter of a second, doubling up to five seconds and staying there", () => {
    expect(take(new Backoff(), 7)).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000]);
  });

  it("starts over once a view is attached again", () => {
    const backoff = new Backoff();
    take(backoff, 4);
    backoff.reset();
    expect(backoff.next()).toBe(250);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "@bazhen/core";
import { ExitWatch, type DeadTerminal } from "./exit-watch.ts";

const dead: DeadTerminal = {
  ref: { terminalId: newId("term"), runtime: "fake", locator: { panePid: "41" } },
  status: { code: null, signal: "SIGTERM" },
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("exit watch", () => {
  it("reports a dead terminal again on every tick, so a missed report is never lost", async () => {
    const watch = new ExitWatch(async () => [dead], 1000);
    const seen: string[] = [];
    const stop = watch.subscribe((ref, status) =>
      seen.push(`${ref.locator.panePid}:${status.signal}`),
    );
    await vi.advanceTimersByTimeAsync(2000);
    stop();
    expect(seen).toEqual(["41:SIGTERM", "41:SIGTERM"]);
  });

  it("stops reading the runtime once the last listener leaves", async () => {
    const read = vi.fn<() => Promise<DeadTerminal[]>>(async () => []);
    const watch = new ExitWatch(read, 1000);
    const stopFirst = watch.subscribe(() => {});
    const stopSecond = watch.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(1000);
    stopFirst();
    await vi.advanceTimersByTimeAsync(1000);
    stopSecond();
    await vi.advanceTimersByTimeAsync(3000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("never overlaps a slow read with the next tick", async () => {
    let inFlight = 0;
    let most = 0;
    const watch = new ExitWatch(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 2500));
      inFlight--;
      return [];
    }, 1000);
    const stop = watch.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(6000);
    stop();
    expect(most).toBe(1);
  });
});

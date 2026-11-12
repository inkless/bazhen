import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExitStatus } from "@bazhen/protocol";
import { newId } from "@bazhen/core";
import { ExitWatch, type DeadTerminal, type ExitWatchOptions } from "./exit-watch.ts";

const deadWith = (status: ExitStatus): DeadTerminal => ({
  ref: { terminalId: newId("term"), runtime: "fake", locator: { incarnation: "1" } },
  status,
});
const dead = deadWith({ type: "signalled", signal: "SIGTERM" });

const watch = (opts: Partial<ExitWatchOptions>) =>
  new ExitWatch({
    read: async () => [dead],
    intervalMs: 1000,
    onError: (err) => {
      throw err;
    },
    ...opts,
  });

/** Every report a watch makes over `ms`, as `<terminal>:<status type>`. */
async function reportsOver(w: ExitWatch, ms: number): Promise<string[]> {
  const seen: string[] = [];
  const stop = w.subscribe((ref, status) => seen.push(`${ref.terminalId}:${status.type}`));
  await vi.advanceTimersByTimeAsync(ms);
  stop();
  return seen;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("exit watch", () => {
  it("reports a dead terminal again on every tick, so a missed report is never lost", async () => {
    const seen = await reportsOver(watch({}), 2000);
    expect(seen).toEqual([`${dead.ref.terminalId}:signalled`, `${dead.ref.terminalId}:signalled`]);
  });

  it("stops reading the runtime once the last listener leaves", async () => {
    const read = vi.fn<() => Promise<DeadTerminal[]>>(async () => []);
    const w = watch({ read });
    const stopFirst = w.subscribe(() => {});
    const stopSecond = w.subscribe(() => {});
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
    const read = async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 2500));
      inFlight--;
      return [];
    };
    await reportsOver(watch({ read }), 6000);
    expect(most).toBe(1);
  });

  it("keeps reporting to every listener when one throws, and hands the error on", async () => {
    const errors: unknown[] = [];
    const w = watch({ onError: (err) => errors.push(err) });
    const stopThrowing = w.subscribe(() => {
      throw new Error("listener bug");
    });
    const seen = await reportsOver(w, 2000);
    stopThrowing();
    expect(seen).toHaveLength(2);
    expect(errors).toHaveLength(2);
  });

  it("hands a failed read on and keeps polling", async () => {
    const errors: unknown[] = [];
    const read = vi.fn<() => Promise<DeadTerminal[]>>(() => Promise.reject(new Error("read bug")));
    await reportsOver(watch({ read, onError: (err) => errors.push(err) }), 2000);
    expect([read.mock.calls.length, errors.length]).toEqual([2, 2]);
  });
});

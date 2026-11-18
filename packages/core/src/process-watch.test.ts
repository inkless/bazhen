import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExitStatus } from "@bazhen/protocol";
import { newId } from "./ids.ts";
import { ProcessWatch, type ObservedProcess, type ProcessWatchOptions } from "./process-watch.ts";

const observed = (exit: ExitStatus | null): ObservedProcess => ({
  ref: { terminalId: newId("term"), runtime: "fake", locator: { incarnation: "1" } },
  exit,
});
const dead = observed({ type: "signalled", signal: "SIGTERM" });
const live = observed(null);

const watch = (opts: Partial<ProcessWatchOptions>) =>
  new ProcessWatch({
    read: async () => [dead],
    intervalMs: 1000,
    onError: (err) => {
      throw err;
    },
    ...opts,
  });

/** Every report a watch makes over `ms`, as `<terminal>:<exit type, or running>`. */
async function reportsOver(w: ProcessWatch, ms: number): Promise<string[]> {
  const seen: string[] = [];
  const stop = w.subscribe((ref, exit) =>
    seen.push(`${ref.terminalId}:${exit?.type ?? "running"}`),
  );
  await vi.advanceTimersByTimeAsync(ms);
  stop();
  return seen;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("process watch", () => {
  it("reports a dead terminal again on every tick, so a missed report is never lost", async () => {
    const seen = await reportsOver(watch({}), 2000);
    expect(seen).toEqual([`${dead.ref.terminalId}:signalled`, `${dead.ref.terminalId}:signalled`]);
  });

  it("reports a live terminal on every tick too, as running", async () => {
    const seen = await reportsOver(watch({ read: async () => [live, dead] }), 1000);
    expect(seen).toEqual([`${live.ref.terminalId}:running`, `${dead.ref.terminalId}:signalled`]);
  });

  it("reads nothing while inactive, and reports a death from then on the next active tick", async () => {
    let active = false;
    const read = vi.fn<() => Promise<ObservedProcess[]>>(async () => [dead]);
    const w = watch({ read, active: () => active });
    const seen: string[] = [];
    const stop = w.subscribe((ref) => seen.push(ref.terminalId));
    await vi.advanceTimersByTimeAsync(3000);
    const whileInactive = read.mock.calls.length;
    active = true;
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    expect([whileInactive, seen]).toEqual([0, [dead.ref.terminalId]]);
  });

  it("stops reading the runtime once the last listener leaves", async () => {
    const read = vi.fn<() => Promise<ObservedProcess[]>>(async () => []);
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
    const read = vi.fn<() => Promise<ObservedProcess[]>>(() =>
      Promise.reject(new Error("read bug")),
    );
    await reportsOver(watch({ read, onError: (err) => errors.push(err) }), 2000);
    expect([read.mock.calls.length, errors.length]).toEqual([2, 2]);
  });
});

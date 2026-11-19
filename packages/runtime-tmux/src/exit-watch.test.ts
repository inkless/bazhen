import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExitWatch } from "./exit-watch.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const sleep = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const code = (n: number) => ({ type: "exited", code: n }) as const;

function watching(quietMs: number, maxWaitMs: number, generation = 0) {
  const watch = new ExitWatch(quietMs, maxWaitMs, generation);
  const told: number[] = [];
  watch.onExit((exit) => told.push(exit.generation));
  return { watch, told };
}

describe("a tmux client's exits", () => {
  it("tells an exit only once the client's output has been quiet since it was seen", async () => {
    const { watch, told } = watching(60, 2000);
    watch.report(0, code(0));
    await sleep(30);
    watch.output();
    await sleep(40);
    const beforeQuiet = [...told];
    await sleep(80);
    expect([beforeQuiet, told, watch.exited]).toEqual([
      [],
      [0],
      { generation: 0, status: code(0) },
    ]);
    watch.dispose();
  });

  it("tells it by the longest wait while the client's output never pauses", async () => {
    const { watch, told } = watching(40, 120);
    watch.report(0, code(0));
    for (let i = 0; i < 20; i++) {
      watch.output();
      await sleep(10);
    }
    expect(told).toEqual([0]);
    watch.dispose();
  });

  it("tells each process's exit once, however often it is reported", async () => {
    const { watch, told } = watching(10, 100);
    watch.report(0, code(1));
    watch.report(0, code(1));
    await sleep(30);
    watch.report(0, code(1));
    await sleep(30);
    watch.respawned(1);
    watch.report(1, code(2));
    await sleep(30);
    expect(told).toEqual([0, 1]);
    watch.dispose();
  });

  it("never tells an exit a respawn here has replaced, pending or reported late", async () => {
    const { watch, told } = watching(30, 100);
    watch.report(0, code(1));
    watch.respawned(1);
    await sleep(60);
    watch.report(0, code(1));
    await sleep(60);
    expect([told, watch.exited]).toEqual([[], null]);
    watch.dispose();
  });

  it("forgets a told exit once the next process is seen running, and drops the old one after", async () => {
    const { watch, told } = watching(10, 100);
    watch.report(0, code(1));
    await sleep(30);
    watch.report(1, null);
    watch.report(0, code(1));
    await sleep(30);
    expect([told, watch.exited]).toEqual([[0], null]);
    watch.dispose();
  });

  it("waits out the quiet after a respawned process's exit, whatever its predecessor's timers", async () => {
    const { watch, told } = watching(200, 300);
    watch.report(0, code(0));
    watch.output();
    await sleep(150);
    watch.output();
    await sleep(100);
    watch.respawned(1);
    watch.report(1, code(1));
    await sleep(100);
    const pastTheOldDeadline = [...told];
    await sleep(150);
    expect([pastTheOldDeadline, told]).toEqual([[], [1]]);
    watch.dispose();
  });

  it("drops an exit of a process older than the one running when the client attached", async () => {
    const { watch, told } = watching(10, 100, 3);
    watch.report(2, code(0));
    await sleep(30);
    expect(told).toEqual([]);
    watch.dispose();
  });
});

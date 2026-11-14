import { describe, expect, it, onTestFinished } from "vitest";
import type { StreamFailure } from "@bazhen/core";
import { ScreenWatch } from "./screen-watch.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A watch whose checks a test can answer from `screen`, fail, stall, or answer one at a time. */
function watched() {
  let checks = 0;
  let screen = false;
  let mode: "answer" | "fail" | "hang" | "hold" = "answer";
  const held: { answer: (alternate: boolean) => void; fail: (err: Error) => void }[] = [];
  const watch = new ScreenWatch({
    quietMs: 10,
    maxWaitMs: 50,
    alternate: false,
    check: async () => {
      checks++;
      if (mode === "fail") throw new Error("tmux gone");
      if (mode === "hang") return new Promise<boolean>(() => {});
      if (mode === "hold") {
        return new Promise<boolean>((answer, fail) => held.push({ answer, fail }));
      }
      return screen;
    },
  });
  onTestFinished(() => watch.dispose());
  const pushes: boolean[] = [];
  const failures: StreamFailure[] = [];
  watch.onAlternate((alternate) => pushes.push(alternate));
  watch.onFailure((failure) => failures.push(failure));
  return {
    watch,
    pushes,
    failures,
    checks: () => checks,
    switchTo: (alternate: boolean) => (screen = alternate),
    failChecks: () => (mode = "fail"),
    hangChecks: () => (mode = "hang"),
    /** From now on each check waits until answered, oldest first. */
    holdChecks: () => (mode = "hold"),
    answerCheck: (answer: boolean) => held.shift()?.answer(answer),
    failCheck: (message: string) => held.shift()?.fail(new Error(message)),
  };
}

describe("watching tmux's alternate screen", () => {
  it("pushes a switch of screens once, after the output settles", async () => {
    const w = watched();
    w.switchTo(true);
    w.watch.poke();
    w.watch.poke();
    await expect.poll(() => w.pushes).toEqual([true]);
    w.watch.poke();
    await sleep(40);
    expect([w.pushes, w.checks()]).toEqual([[true], 2]);
  });

  it("starts no check while one is still running", async () => {
    const w = watched();
    w.hangChecks();
    for (let i = 0; i < 3; i++) {
      w.watch.poke();
      await sleep(30);
    }
    expect(w.checks()).toBe(1);
  });

  it("checks again when output arrived while a check was running", async () => {
    const w = watched();
    w.holdChecks();
    w.watch.poke();
    await expect.poll(() => w.checks()).toBe(1);
    w.watch.poke();
    await sleep(30);
    w.answerCheck(false);
    await expect.poll(() => w.checks()).toBe(2);
    w.answerCheck(true);
    await expect.poll(() => w.pushes).toEqual([true]);
  });

  it("reports nothing, and checks no more, once it is disposed while a check runs", async () => {
    const w = watched();
    w.holdChecks();
    w.watch.poke();
    await expect.poll(() => w.checks()).toBe(1);
    w.watch.poke();
    await sleep(30);
    w.watch.dispose();
    w.answerCheck(true);
    await sleep(30);
    expect([w.pushes, w.checks()]).toEqual([[], 1]);
  });

  it("reports no failure of a check that fails after it is disposed", async () => {
    const w = watched();
    w.holdChecks();
    w.watch.poke();
    await expect.poll(() => w.checks()).toBe(1);
    w.watch.dispose();
    w.failCheck("tmux gone");
    await sleep(30);
    expect(w.failures).toEqual([]);
  });

  it("reports a check that keeps failing once, not every time", async () => {
    const w = watched();
    w.failChecks();
    for (let i = 0; i < 3; i++) {
      w.watch.poke();
      await sleep(30);
    }
    expect([w.checks() >= 3, w.failures]).toEqual([
      true,
      [{ what: "screen check", cause: new Error("tmux gone") }],
    ]);
  });
});

import { describe, expect, it } from "vitest";
import type { RunOutcome } from "@bazhen/host-guard";
import { desktopNotifier, notificationCommand } from "./desktop.ts";

/** A run that holds each call until `finish` answers it, and the commands it was given. */
function runs() {
  const calls: string[][] = [];
  const pending: ((outcome: RunOutcome) => void)[] = [];
  const run = (command: string, args: readonly string[]) => {
    calls.push([command, ...args]);
    return new Promise<RunOutcome>((resolve) => pending.push(resolve));
  };
  const finish = async (outcome: RunOutcome) => {
    pending.shift()?.(outcome);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { run, calls, finish };
}

describe("desktop notifications", () => {
  it("keeps a title or body that starts with a dash as text, and never uses osascript", () => {
    const sneaky = '-edo shell script "touch /tmp/x"';
    expect([
      notificationCommand("linux", sneaky, sneaky),
      notificationCommand("darwin", sneaky, sneaky),
      notificationCommand("win32", sneaky, sneaky),
    ]).toEqual([
      { command: "notify-send", args: ["--app-name=Bazhen", "--", sneaky, sneaky] },
      null,
      null,
    ]);
  });

  it("shows one at a time, and gathers what opens meanwhile into one that counts them", async () => {
    const { run, calls, finish } = runs();
    const notify = desktopNotifier("linux", run, () => undefined);
    for (const project of ["a", "b", "c", "d"]) notify?.(project, "A turn failed");
    await finish("ok");
    await finish("ok");
    expect(calls.map((c) => c.slice(-2))).toEqual([
      ["a", "A turn failed"],
      ["Bazhen", "3 items need you"],
    ]);
  });

  it("turns itself off where the command isn't installed, and says so once", async () => {
    const { run, calls, finish } = runs();
    const logged: string[] = [];
    const notify = desktopNotifier("linux", run, (m) => logged.push(m));
    notify?.("a", "b");
    await finish("missing");
    notify?.("c", "d");
    expect([calls.length, logged.length]).toEqual([1, 1]);
  });

  it("says once that notifications fail, and keeps trying them", async () => {
    const { run, calls, finish } = runs();
    const logged: string[] = [];
    const notify = desktopNotifier("linux", run, (m) => logged.push(m));
    notify?.("a", "b");
    await finish("failed");
    notify?.("c", "d");
    await finish("timed_out");
    expect([calls.length, logged.length]).toEqual([2, 1]);
  });

  it("offers none on a platform it has no notifier for yet", () => {
    expect([desktopNotifier("darwin", runs().run), desktopNotifier("win32", runs().run)]).toEqual([
      null,
      null,
    ]);
  });
});

import { describe, expect, it } from "vitest";
import type { DesktopNotification, RunOutcome } from "@bazhen/host-guard";
import { desktopNotifier, hostNotifier } from "./desktop.ts";

/** A notifier that holds each notification until `finish` answers it, and what it was shown. */
function notifier() {
  const shown: DesktopNotification[] = [];
  const pending: ((outcome: RunOutcome) => void)[] = [];
  const show = (n: DesktopNotification) => {
    shown.push(n);
    return new Promise<RunOutcome>((resolve) => pending.push(resolve));
  };
  const finish = async (outcome: RunOutcome) => {
    pending.shift()?.(outcome);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { show, shown, finish };
}

const none = { notifySend: null, macApp: null };

describe("desktop notifications", () => {
  it("uses notify-send on Linux and Bazhen.app on macOS, each only where it was found", () => {
    const found = { notifySend: "/usr/bin/notify-send", macApp: "/b/Bazhen.app" };
    expect([
      typeof hostNotifier("linux", found, 7900),
      typeof hostNotifier("darwin", found, 7900),
      hostNotifier("linux", none, 7900),
      hostNotifier("darwin", none, 7900),
      hostNotifier("win32", found, 7900),
    ]).toEqual(["function", "function", null, null, null]);
  });

  it("shows one at a time, and gathers what opens meanwhile into one that counts them", async () => {
    const { show, shown, finish } = notifier();
    const notify = desktopNotifier(show, () => undefined);
    for (const project of ["a", "b", "c", "d"]) notify(project, "A turn failed");
    await finish("ok");
    await finish("ok");
    expect(shown).toEqual([
      { title: "a", body: "A turn failed" },
      { title: "Bazhen", body: "3 items need you" },
    ]);
  });

  it("turns itself off when its notifier won't start, and says so once", async () => {
    const { show, shown, finish } = notifier();
    const logged: string[] = [];
    const notify = desktopNotifier(show, (m) => logged.push(m));
    notify("a", "b");
    await finish("missing");
    notify("c", "d");
    expect([shown.length, logged.length]).toEqual([1, 1]);
  });

  it("says once that notifications fail, and keeps trying them", async () => {
    const { show, shown, finish } = notifier();
    const logged: string[] = [];
    const notify = desktopNotifier(show, (m) => logged.push(m));
    notify("a", "b");
    await finish("failed");
    notify("c", "d");
    await finish("timed_out");
    expect([shown.length, logged.length]).toEqual([2, 1]);
  });
});

import { describe, expect, it } from "vitest";
import {
  findNotifySend,
  linuxNotifier,
  macNotifier,
  macNotifierArgs,
  notifySendArgs,
} from "./notify.ts";

const sneaky = { title: "-a Terminal", body: '--url "file:///etc/passwd"' };

describe("desktop notifiers", () => {
  it("keeps a title or body that looks like an option as text, for either notifier", () => {
    expect([notifySendArgs(sneaky), macNotifierArgs("/b/Bazhen.app", 7900, sneaky)]).toEqual([
      ["--app-name=Bazhen", "--", sneaky.title, sneaky.body],
      [
        "-nW",
        "/b/Bazhen.app",
        "--args",
        "--title",
        sneaky.title,
        "--body",
        sneaky.body,
        "--port",
        "7900",
        "--timeout",
        "5",
      ],
    ]);
  });

  it("finds notify-send only where distributions install it, never on PATH", () => {
    expect([
      findNotifySend((path) => path === "/usr/local/bin/notify-send"),
      findNotifySend(() => false),
    ]).toEqual(["/usr/local/bin/notify-send", null]);
  });

  it("refuses to run anything but notify-send and Bazhen.app, or on a port that isn't one", () => {
    expect(() => linuxNotifier("/bin/sh")).toThrow(RangeError);
    expect(() => macNotifier("/Applications/Terminal.app", 7900)).toThrow(RangeError);
    expect(() => macNotifier("Bazhen.app", 7900)).toThrow(RangeError);
    expect(() => macNotifier("/b/Bazhen.app", 0)).toThrow(RangeError);
    expect(typeof macNotifier("/b/Bazhen.app", 7900)).toBe("function");
  });
});

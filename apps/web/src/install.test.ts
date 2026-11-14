import { describe, expect, it } from "vitest";
import { closeNotice, offersInstall, suggestsApp, type Here, type Platform } from "./install.ts";

const desktop = (userAgent: string, maxTouchPoints = 0): Platform => ({
  coarse: false,
  maxTouchPoints,
  userAgent,
  mobile: false,
});
const touch = (userAgent: string): Platform => ({
  coarse: true,
  maxTouchPoints: 5,
  userAgent,
  mobile: true,
});

const LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/157.0.0.0 Safari/537.36";
const CHROME_OS =
  "Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 Chrome/157.0.0.0 Safari/537.36";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/157.0.0.0 Mobile Safari/537.36";

describe("offering Bazhen as an installed app", () => {
  it("offers it on a desktop whose browser tabs keep Ctrl+W, a touch-screen laptop included", () => {
    expect(
      [desktop(LINUX), desktop(WINDOWS), desktop(CHROME_OS), desktop(LINUX, 10)].map(offersInstall),
    ).toEqual([true, true, true, true]);
  });

  it("leaves a Mac, an iPad, an iPhone and an Android phone as they were", () => {
    expect(
      [desktop(MAC), desktop(MAC, 5), touch(IPHONE), touch(ANDROID)].map(offersInstall),
    ).toEqual([false, false, false, false]);
  });

  it("leaves Android with a mouse, as in a desktop mode, as it was", () => {
    expect(offersInstall(desktop(ANDROID))).toBe(false);
  });

  it("leaves an Android tablet asking for the desktop site, with a Linux user agent, as it was", () => {
    const withTrackpad: Platform = { ...desktop(LINUX, 5), mobile: true };
    expect([touch(LINUX), withTrackpad].map(offersInstall)).toEqual([false, false]);
  });
});

describe("suggesting the app to a user who lost Ctrl+W to the tab", () => {
  const installable: Here = { secure: true, prompts: true, linked: true, inApp: false };

  it("suggests it where the browser can install Bazhen from this page", () => {
    expect(suggestsApp(installable)).toBe(true);
  });

  it("doesn't on a plain-http origin, in Firefox, without the manifest, or in the app itself", () => {
    expect(
      [
        { ...installable, secure: false },
        { ...installable, prompts: false },
        { ...installable, linked: false },
        { ...installable, inApp: true },
      ].map(suggestsApp),
    ).toEqual([false, false, false, false]);
  });
});

describe("what a terminal says after the user stays through a close", () => {
  const tab: Here = { secure: true, prompts: true, linked: true, inApp: false };

  it("in the app's window, that Ctrl+Shift+W closes it, since Ctrl+W already gets through", () => {
    expect(closeNotice({ ...tab, inApp: true })).toBe(
      "Ctrl+Shift+W closes this window. Ctrl+W alone reaches the terminal.",
    );
  });

  it("in a tab, that the tab took Ctrl+W, and the app where it can be installed", () => {
    expect([closeNotice(tab), closeNotice({ ...tab, prompts: false })]).toEqual([
      "Ctrl+W closes the tab, so the terminal can't get it. In Bazhen installed as an app, it can.",
      "Ctrl+W closes the tab, so the terminal can't get it.",
    ]);
  });
});

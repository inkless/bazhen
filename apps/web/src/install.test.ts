import { describe, expect, it } from "vitest";
import type { Device } from "./terminal/bar-keys.ts";
import { offersInstall } from "./install.ts";

const desktop = (userAgent: string, maxTouchPoints = 0): Device => ({
  coarse: false,
  maxTouchPoints,
  userAgent,
});
const touch = (userAgent: string): Device => ({ coarse: true, maxTouchPoints: 5, userAgent });

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

  it("leaves an Android tablet asking for the desktop site, with a Linux user agent, as it was", () => {
    expect(offersInstall(touch(LINUX))).toBe(false);
  });
});

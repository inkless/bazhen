import { describe, expect, it } from "vitest";
import { offersInstall } from "./install.ts";

const agents = {
  linux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/157.0.0.0 Safari/537.36",
  chromeOs:
    "Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 Chrome/157.0.0.0 Safari/537.36",
  iPhone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
  iPad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15",
  android:
    "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/157.0.0.0 Mobile Safari/537.36",
};

describe("offering Bazhen as an installed app", () => {
  it("offers it where a browser tab keeps Ctrl+W for itself", () => {
    expect([agents.linux, agents.windows, agents.chromeOs].map(offersInstall)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("leaves a phone, an iPad and a Mac as they were, Home Screen included", () => {
    expect([agents.iPhone, agents.iPad, agents.android].map(offersInstall)).toEqual([
      false,
      false,
      false,
    ]);
  });
});

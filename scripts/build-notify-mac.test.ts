import { describe, expect, it } from "vitest";
import { buildSteps, cannotBuild } from "./build-notify-mac.ts";

describe("building the macOS notifier", () => {
  it("compiles the app into the output directory, runs its self-test, then signs it", () => {
    expect(buildSteps("/src", "/out")).toEqual([
      {
        command: "swiftc",
        args: ["-O", "-o", "/out/Bazhen.app/Contents/MacOS/bazhen-notify", "/src/main.swift"],
      },
      { command: "/out/Bazhen.app/Contents/MacOS/bazhen-notify", args: ["--self-test"] },
      { command: "codesign", args: ["--force", "--sign", "-", "/out/Bazhen.app"] },
    ]);
  });

  it("skips the build off macOS, and on a Mac without a Swift compiler", () => {
    expect([
      cannotBuild("linux", () => true),
      cannotBuild("darwin", () => false),
      cannotBuild("darwin", () => true),
    ]).toEqual(["not macOS", "swiftc not found (xcode-select --install)", null]);
  });
});

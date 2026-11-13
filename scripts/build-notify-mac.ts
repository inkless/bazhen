// `pnpm build:notify [<dir>]`: builds Bazhen.app, the macOS notifier the daemon launches, into
// `<dir>` (apps/notify-mac/dist by default). Skipped, and still exiting 0, off macOS or without
// Xcode's command-line tools: notifications are optional, and `bazhen doctor` says when the app
// is missing. Never committed; it is built on the machine that runs it.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.ts";

const SOURCE = fileURLToPath(new URL("../apps/notify-mac/", import.meta.url));
export const DEFAULT_OUT = join(SOURCE, "dist");
export const APP_NAME = "Bazhen.app";

/** The commands that build the app into `out`, in order: compile, check itself, then sign. */
export function buildSteps(source: string, out: string): { command: string; args: string[] }[] {
  const app = join(out, APP_NAME);
  const binary = join(app, "Contents", "MacOS", "bazhen-notify");
  return [
    { command: "swiftc", args: ["-O", "-o", binary, join(source, "main.swift")] },
    // Its parser and inbox URL checks, run straight from the binary: no LaunchServices, so no
    // notification and no permission prompt.
    { command: binary, args: ["--self-test"] },
    // macOS keys the notification permission by bundle id, not by signature: an ad-hoc one has
    // no identity of its own. It seals the bundle, since Apple silicon runs only signed code.
    { command: "codesign", args: ["--force", "--sign", "-", app] },
  ];
}

/** Why the app can't be built here, or null when it can. */
export function cannotBuild(platform: NodeJS.Platform, hasSwiftc: () => boolean): string | null {
  if (platform !== "darwin") return "not macOS";
  return hasSwiftc() ? null : "swiftc not found (xcode-select --install)";
}

const hasSwiftc = () => {
  try {
    execFileSync("swiftc", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    // No compiler is an answer, not an error: the build is skipped.
    return false;
  }
};

if (isMain(import.meta)) {
  const out = process.argv[2] ?? DEFAULT_OUT;
  const skip = cannotBuild(process.platform, hasSwiftc);
  if (skip !== null) {
    console.log(`build:notify: skipped (${skip}); no desktop notifications on this machine`);
  } else {
    const app = join(out, APP_NAME);
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    copyFileSync(join(SOURCE, "Info.plist"), join(app, "Contents", "Info.plist"));
    for (const step of buildSteps(SOURCE, out)) {
      execFileSync(step.command, step.args, { stdio: "inherit" });
    }
    console.log(`build:notify: built ${app}`);
  }
}

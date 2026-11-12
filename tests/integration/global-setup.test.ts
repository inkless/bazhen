import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setup, teardown } from "../support/global-setup.ts";

const saved = { ...process.env };
let outer = "";
afterEach(() => {
  tmuxAt(fakeDefault(), "kill-server");
  rmSync(outer, { recursive: true, force: true });
  process.env = { ...saved };
});

const uid = process.getuid?.() ?? 0;
/** A server called `default`, the name of the user's own, in a directory standing in for /tmp. */
const fakeDefault = () => join(outer, `tmux-${uid}`, "default");

function tmuxAt(socket: string, ...args: string[]): boolean {
  try {
    execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

describe("the test run's tmux isolation", () => {
  it("leaves every server alone when setup fails before the run starts", () => {
    outer = mkdtempSync("/tmp/bz-outer-");
    mkdirSync(join(outer, `tmux-${uid}`), { mode: 0o700 });
    expect(tmuxAt(fakeDefault(), "new-session", "-d", "sleep 600")).toBe(true);
    // The user's environment as a run inherits it, and a PTY check that refuses to run.
    process.env["TMUX_TMPDIR"] = outer;
    process.env["BZ_PTY_CUTOFF"] = "0.5";
    expect(() => setup()).toThrow("Refusing to run");
    teardown();
    expect(tmuxAt(fakeDefault(), "has-session")).toBe(true);
  });
});

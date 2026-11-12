import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TmuxServer } from "@bazhen/host-guard";
import { setup, teardown } from "../support/global-setup.ts";

const saved = { ...process.env };
let outer = "";
let own: TmuxServer | undefined;
afterEach(() => {
  own?.kill();
  rmSync(outer, { recursive: true, force: true });
  process.env = { ...saved };
});

const uid = process.getuid?.() ?? 0;
/** A server of the user's own, in a directory standing in for /tmp. */
const usersOwn = () =>
  TmuxServer.at(join(outer, `tmux-${uid}`, "users-own"), { root: outer, config: "/dev/null" });

describe("the test run's tmux isolation", () => {
  it("leaves every server alone when setup fails before the run starts", () => {
    outer = mkdtempSync("/tmp/bz-outer-");
    mkdirSync(join(outer, `tmux-${uid}`), { mode: 0o700 });
    // Named before TMUX_TMPDIR points at `outer`, which makes its directory a shared one.
    own = usersOwn();
    own.runSync(["new-session", "-d", "sleep 600"]);
    // The user's environment as a run inherits it, and a PTY check that refuses to run.
    process.env["TMUX_TMPDIR"] = outer;
    process.env["BZ_PTY_CUTOFF"] = "0.5";
    expect(() => setup()).toThrow("Refusing to run");
    teardown();
    expect(own.alive()).toBe(true);
  });
});

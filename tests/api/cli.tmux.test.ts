import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tmuxVersion } from "@bazhen/host-guard";
import { Daemon, bazhen } from "./daemon.ts";

const [tmuxMajor, tmuxMinor] = tmuxVersion();
const crashesOnDeadPaneFocus = tmuxMajor < 3 || (tmuxMajor === 3 && tmuxMinor < 5);

describe("bazhen doctor on tmux", () => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.startWithCli("", {}, "tmux");
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("warns of the dead-pane crash on a tmux before 3.5, and only there", async () => {
    const { code, out } = await bazhen(["doctor"], daemon.env);
    expect(code).toBe(0);
    expect(out.includes("  warning: tmux before 3.5 crashes")).toBe(crashesOnDeadPaneFocus);
  });
});

describe("bazhen env refresh with agents on tmux", () => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.startWithCli("", { BZ_STALE: "from-start" }, "tmux");
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  // A value that would end the command, or run another, if tmux ever read it as code.
  const fresh = `it's "x" $HOME; run-shell 'id' #{pane_id} a\\b`;

  it("gives agents started afterwards the refreshing shell's environment, and no other", async () => {
    const first = await daemon.launch("before");
    await expect.poll(() => daemon.hasTerminal(first.agentId)).toBe(true);

    const refreshed = await bazhen(["env", "refresh"], {
      ...daemon.env,
      BZ_FRESH: fresh,
      BZ_MULTI: "one\ntwo",
      CLAUDECODE: "1",
    });
    expect(refreshed.code).toBe(0);
    expect(refreshed.out).toContain("left as they were (tmux can't take them as data): BZ_MULTI");
    expect(refreshed.out).toContain(first.agentId);

    const second = await daemon.launch("after");
    await expect.poll(() => daemon.hasTerminal(second.agentId)).toBe(true);
    const env = await daemon.agentEnv(second.agentId);
    expect([env["BZ_FRESH"], env["BZ_STALE"], env["BZ_MULTI"], env["CLAUDECODE"]]).toEqual([
      fresh,
      undefined,
      undefined,
      undefined,
    ]);
    // The agent already running keeps what it started with.
    expect((await daemon.agentEnv(first.agentId))["BZ_STALE"]).toBe("from-start");
  });
});

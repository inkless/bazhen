import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bazhen, Daemon } from "./daemon.ts";
import { openShell, runtimeStates, snapshot, terminals } from "./runtime-states.ts";

/** What a holder daemon reports of tmux, besides it being unused: nothing, on either daemon. */
const tmuxInUse = (lines: string[]) =>
  lines.filter((line) => line.startsWith("tmux") && line !== "tmux: unused");
const besidesTmux = (states: string[]) => states.filter((state) => !state.startsWith("tmux: "));
/** Every tmux command run but asking its version. */
const beyondVersion = (ran: string[]) => ran.filter((line) => !line.endsWith(" -V"));

describe("a holder daemon on a machine without tmux", () => {
  let daemon: Daemon;

  beforeAll(async () => {
    daemon = await Daemon.start({ runtime: "holder", withoutTmux: true });
  }, 60_000);
  afterAll(async () => {
    await daemon?.stop();
  });

  it("reports its holders not running, any tmux unused, and passes doctor", async () => {
    const doctor = await bazhen(["doctor"], daemon.env);
    const states = await runtimeStates(daemon);
    expect([
      besidesTmux(states),
      tmuxInUse(states),
      doctor.code,
      tmuxInUse(doctor.out.split("\n")),
    ]).toEqual([["holder: not-running"], [], 0, []]);
  });

  it("runs no tmux command but its version while a holder shell runs", async () => {
    const shell = await openShell(daemon, "no-tmux-shell");
    await expect
      .poll(async () => (await terminals(daemon))[shell], { timeout: 30_000 })
      .toBe("running on holder");
    const view = await daemon.view(shell, "interactive");
    await view.drive();
    view.type("sleep 300\r");
    // The shell's foreground is read through every runtime that is read, so once it says sleep
    // the foregrounds have been read at least once, and the runtimes have watched its process.
    await expect
      .poll(
        async () =>
          (await snapshot(daemon)).shells.find((s) => s.id === shell)?.foreground?.command,
        { timeout: 15_000 },
      )
      .toBe("sleep");
    view.close();
    expect(beyondVersion(daemon.tmuxRan())).toEqual([]);
  });
});

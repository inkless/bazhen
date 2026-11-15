import { afterEach, describe, expect, it } from "vitest";
import { ErrorResponse, ShellCommandResponse, StateSnapshot } from "@bazhen/protocol";
import { bazhen, Daemon, waitUntil } from "./daemon.ts";

const daemons: Daemon[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
});

let keys = 0;
const open = (on: Daemon) =>
  on.request("/v1/shells", {
    method: "POST",
    body: { idempotencyKey: `open-${++keys}`, cwd: on.work },
  });
const opened = async (on: Daemon) => ShellCommandResponse.parse((await open(on)).body).terminalId;
const shellStates = async (on: Daemon) =>
  StateSnapshot.parse((await on.request("/v1/state")).body).shells.map((s) => s.state);

/** Sets `terminals.max_open`, which the daemon reads when it next starts. */
const budget = (on: Daemon, max: number) => on.writeConfig(`[terminals]\nmax_open = ${max}\n`);

/** A daemon running with `terminals.max_open = max`. */
async function budgeted(max: number): Promise<Daemon> {
  const daemon = await Daemon.start();
  daemons.push(daemon);
  await daemon.kill();
  budget(daemon, max);
  await daemon.restart();
  return daemon;
}

describe("the terminal budget", () => {
  it("refuses a shell past terminals.max_open, saying why, until one is closed", async () => {
    const daemon = await budgeted(2);
    const first = await opened(daemon);
    await opened(daemon);
    const refused = await open(daemon);
    expect([refused.status, ErrorResponse.parse(refused.body)]).toEqual([
      409,
      {
        error: "terminal_limit",
        message:
          "2 terminals are open, the most at once (terminals.max_open = 2): close one you no longer need to open another",
      },
    ]);
    await daemon.request(`/v1/shells/${first}/close`, {
      method: "POST",
      body: { idempotencyKey: "close", generation: 0, confirmBusy: true },
    });
    expect((await open(daemon)).status).toBe(200);
  });

  it("shows the open count against the budget in bazhen doctor", async () => {
    const daemon = await budgeted(3);
    await opened(daemon);
    expect((await bazhen(["doctor"], daemon.env)).out).toContain(
      "terminals: 1 open, at most 3 (terminals.max_open)\n",
    );
  });

  it("keeps the terminals open above a budget lowered across a restart, and refuses new ones", async () => {
    const daemon = await Daemon.start();
    daemons.push(daemon);
    await opened(daemon);
    await opened(daemon);
    await waitUntil(
      async () => (await shellStates(daemon)).every((s) => s === "running"),
      "both shells running",
    );
    await daemon.kill();
    budget(daemon, 1);
    await daemon.restart();
    expect(await shellStates(daemon)).toEqual(["running", "running"]);
    expect((await open(daemon)).status).toBe(409);
    expect(daemon.log()).toContain(
      "2 terminals are open, above terminals.max_open (1): they keep running, and a new one opens once 2 of them have closed",
    );
  });
});

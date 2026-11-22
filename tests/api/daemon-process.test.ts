// The daemon as a process, whichever one runs: one per home, and stopping none succeeds.
// Both daemons pass it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Daemon, bazhen, cliHome, overSocket } from "./daemon.ts";

describe("a daemon on its own home", () => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.start();
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("exits already running when a second starts, and leaves the first answering", async () => {
    const second = await daemon.startAnother();
    expect(second).toMatchObject({ code: 1, out: expect.stringContaining("already running") });
    expect((await overSocket(daemon.socket, "GET", "/v1/health")).status).toBe(200);
  });
});

describe("two daemons started at once on one home", () => {
  let race: Awaited<ReturnType<typeof Daemon.startTwoAtOnce>> | undefined;
  afterAll(async () => {
    for (const daemon of race?.both ?? []) await daemon.stop();
  });

  it("serves with one, and the other exits 1 without taking its socket", async () => {
    race = await Daemon.startTwoAtOnce();
    expect(race.exited).toMatchObject({
      code: 1,
      out: expect.stringMatching(/already running|another daemon holds/),
    });
    expect((await overSocket(race.serving.socket, "GET", "/v1/health")).status).toBe(200);
  });
});

describe("bazhen stop with no daemon", () => {
  let home: Awaited<ReturnType<typeof cliHome>>;
  beforeAll(async () => {
    home = await cliHome();
  });
  afterAll(async () => {
    await home?.cleanup();
  });

  it("says it isn't running, and succeeds: stopping is idempotent", async () => {
    expect(await bazhen(["stop"], home.env)).toEqual({ code: 0, out: "bazhen is not running\n" });
  });
});

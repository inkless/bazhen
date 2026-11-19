// The daemon as a process, whichever one runs: one per home, and stopped only over its socket.
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

  it("serves stop on the socket only, never over HTTP", async () => {
    const overHttp = await daemon.request("/v1/daemon/stop", { method: "POST", cookie: null });
    expect(overHttp.status).toBe(404);
    expect((await overSocket(daemon.socket, "GET", "/v1/health")).status).toBe(200);
  });

  it("exits already running when a second starts, and leaves the first answering", async () => {
    const second = await daemon.startAnother();
    expect(second).toMatchObject({ code: 1, out: expect.stringContaining("already running") });
    expect((await overSocket(daemon.socket, "GET", "/v1/health")).status).toBe(200);
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

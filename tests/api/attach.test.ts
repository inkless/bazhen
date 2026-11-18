import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ShellCommandResponse, StateSnapshot } from "@bazhen/protocol";
import { attachInScript, Daemon, DETACH } from "./daemon.ts";

const state = async (daemon: Daemon) =>
  StateSnapshot.parse((await daemon.request("/v1/state")).body);

describe("bazhen terminals attach, on a holder terminal", () => {
  let daemon: Daemon;
  let left: (() => void)[] = [];
  beforeAll(async () => {
    daemon = await Daemon.start();
  });
  afterEach(() => {
    for (const leave of left) leave();
    left = [];
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  async function shell(key: string): Promise<string> {
    const opened = await daemon.request("/v1/shells", {
      method: "POST",
      body: { idempotencyKey: key, cwd: daemon.work },
    });
    return ShellCommandResponse.parse(opened.body).terminalId;
  }

  it("types into the terminal, shows what it prints, and detaches leaving it running", async () => {
    const terminalId = await shell("typed");
    const attached = attachInScript(daemon, terminalId);
    left.push(attached.leave);
    attached.type("printf 'attached-%s\\n' 42\r");
    await attached.shows("attached-42", "the command's output");
    attached.type(DETACH);
    const code = await attached.exited;
    const shells = (await state(daemon)).shells;
    expect([code, attached.shown().includes(`detached from ${terminalId}`)]).toEqual([0, true]);
    expect(shells.find((s) => s.id === terminalId)?.state).toBe("running");
  });

  it("with --direct while the daemon runs, only views: the web app's keys still land", async () => {
    const terminalId = await shell("viewed");
    const direct = attachInScript(daemon, `${terminalId} --direct`);
    left.push(direct.leave);
    direct.type("printf 'direct-%s\\n' 9\r");
    const view = await daemon.socketView(terminalId, "interactive");
    await view.drive();
    view.type("printf 'viewed-%s\\n' 7\r");
    await direct.shows("viewed-7", "the web's command, seen directly");
    direct.type(DETACH);
    const code = await direct.exited;
    view.close();
    expect([
      code,
      direct.shown().includes("direct-9"),
      direct.shown().includes("--direct only viewed the terminal"),
    ]).toEqual([0, false, true]);
  });

  it("ends, saying so, when the terminal exits", async () => {
    const terminalId = await shell("exits");
    const attached = attachInScript(daemon, terminalId);
    left.push(attached.leave);
    attached.type("exit\r");
    await attached.shows(
      `${terminalId}: the terminal exited`,
      "the attach saying the terminal exited",
    );
    const code = await attached.exited;
    expect([code, attached.shown().includes(`${terminalId}: the terminal exited`)]).toEqual([
      0,
      true,
    ]);
  });
});

describe("bazhen terminals attach, straight to the holder while the daemon is down", () => {
  let daemon: Daemon;
  let left: (() => void)[] = [];
  beforeAll(async () => {
    daemon = await Daemon.start();
  });
  afterEach(() => {
    for (const leave of left) leave();
    left = [];
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("types there, and lets go of the input once the daemon is back", async () => {
    const opened = await daemon.request("/v1/shells", {
      method: "POST",
      body: { idempotencyKey: "straight", cwd: daemon.work },
    });
    const terminalId = ShellCommandResponse.parse(opened.body).terminalId;
    await daemon.crash();
    const direct = attachInScript(daemon, terminalId);
    left.push(direct.leave);
    direct.type("printf 'straight-%s\\n' 5\r");
    await direct.shows("straight-5", "the command's output");
    await daemon.restart();
    expect([
      await direct.exited,
      direct.shown().includes("bazhen is not running: attaching straight"),
      direct.shown().includes("the daemon is back, so this attachment let go"),
    ]).toEqual([0, true, true]);
  });
});

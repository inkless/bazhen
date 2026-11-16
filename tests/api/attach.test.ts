import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ShellCommandResponse, StateSnapshot } from "@bazhen/protocol";
import { attachInScript, Daemon, DETACH } from "./daemon.ts";

const state = async (daemon: Daemon) =>
  StateSnapshot.parse((await daemon.request("/v1/state")).body);

describe("bazhen attach, on a holder terminal", () => {
  let daemon: Daemon;
  let left: (() => void)[] = [];
  beforeAll(async () => {
    daemon = await Daemon.start({ config: '[runtime]\ndefault = "holder"\n' });
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

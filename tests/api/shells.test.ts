import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorResponse, ShellCommandResponse, StateSnapshot } from "@bazhen/protocol";
import { Daemon, waitUntil, type View } from "./daemon.ts";
import { closeHoldersUnder } from "../support/holder-close.ts";

let daemon: Daemon;
beforeAll(async () => {
  daemon = await Daemon.start();
});
afterAll(async () => {
  await daemon?.stop();
});

let keys = 0;
const open = async (on: Daemon, body: Record<string, unknown> = {}) => {
  const res = await on.request("/v1/shells", {
    method: "POST",
    body: { idempotencyKey: `open-${++keys}`, cwd: on.work, ...body },
  });
  return ShellCommandResponse.parse(res.body).terminalId;
};
const close = (on: Daemon, terminalId: string, body: Record<string, unknown> = {}) =>
  on.request(`/v1/shells/${terminalId}/close`, {
    method: "POST",
    body: { idempotencyKey: `close-${++keys}`, generation: 0, ...body },
  });
const shellOf = async (on: Daemon, terminalId: string) =>
  StateSnapshot.parse((await on.request("/v1/state")).body).shells.find((s) => s.id === terminalId);

/** A view driving the shell, once its prompt has drawn. */
async function driving(terminalId: string): Promise<View> {
  const view = await daemon.view(terminalId, "interactive");
  await view.drive();
  return view;
}

describe("a shell terminal", () => {
  it("runs the user's shell in the directory asked for, told its terminal but no agent", async () => {
    const terminalId = await open(daemon);
    await waitUntil(() => daemon.terminalOpen(terminalId), "the shell's terminal");
    const env = await daemon.terminalEnv(terminalId);
    expect(await daemon.terminalCwd(terminalId)).toBe(daemon.work);
    expect([env.BAZHEN_TERMINAL_ID, env.BAZHEN_AGENT_ID]).toEqual([terminalId, undefined]);
    expect((await shellOf(daemon, terminalId))?.state).toBe("running");
  });

  it("refuses to close while a program runs in it, naming it, and ends it once confirmed", async () => {
    const terminalId = await open(daemon);
    const view = await driving(terminalId);
    view.type("sleep 300\r");
    await waitUntil(
      async () => (await shellOf(daemon, terminalId))?.foreground?.command === "sleep",
      "sleep in the foreground",
    );
    const refused = await close(daemon, terminalId);
    const error = ErrorResponse.parse(refused.body);
    expect([refused.status, error.error, error.message]).toEqual([
      409,
      "busy",
      expect.stringContaining("sleep"),
    ]);
    expect(await daemon.terminalOpen(terminalId)).toBe(true);
    const confirmed = await close(daemon, terminalId, { confirmBusy: true });
    expect([confirmed.status, await daemon.terminalOpen(terminalId)]).toEqual([200, false]);
    expect(await shellOf(daemon, terminalId)).toBeUndefined();
    view.close();
  });

  it("shows what runs in it by name, and nothing once it ends", async () => {
    const terminalId = await open(daemon);
    const view = await driving(terminalId);
    view.type("sleep 301\r");
    await expect
      .poll(async () => (await shellOf(daemon, terminalId))?.foreground?.command, {
        timeout: 15_000,
      })
      .toBe("sleep");
    view.type("\x03");
    await expect
      .poll(async () => (await shellOf(daemon, terminalId))?.foreground, { timeout: 15_000 })
      .toBeNull();
    view.close();
  });

  it("closes a shell at its prompt without asking first", async () => {
    const terminalId = await open(daemon);
    const view = await driving(terminalId);
    view.type("echo ready-$((40+2))\r");
    await waitUntil(() => view.output().includes("ready-42"), "the shell's answer");
    const closed = await close(daemon, terminalId);
    expect([closed.status, await daemon.terminalOpen(terminalId)]).toEqual([200, false]);
    view.close();
  });

  it("closes at once, with nothing asked, when exit is typed in it", async () => {
    const terminalId = await open(daemon);
    const view = await driving(terminalId);
    view.type("exit\r");
    await expect
      .poll(async () => (await shellOf(daemon, terminalId))?.state, { timeout: 10_000 })
      .toBeUndefined();
    expect(await daemon.terminalOpen(terminalId)).toBe(false);
    view.close();
  });
});

describe("a shell whose terminal ended while the daemon was down", () => {
  let restarted: Daemon;
  let terminalId: string;
  beforeAll(async () => {
    restarted = await Daemon.start();
    terminalId = await open(restarted);
    const view = await restarted.view(terminalId, "interactive");
    await view.drive();
    // Seen in a directory of its own, which a restart then opens in: the read that sees sleep
    // start there is the one that records the directory.
    view.type("mkdir -p moved && cd moved && sleep 30\r");
    await waitUntil(
      async () => (await shellOf(restarted, terminalId))?.foreground?.command === "sleep",
      "a foreground read in the new directory",
    );
    view.close();
    await restarted.crash();
    await closeHoldersUnder(restarted.home);
    await restarted.restart();
  });
  afterAll(async () => {
    await restarted?.stop();
  });

  it("shows as lost, and restarts in the directory it was last seen in", async () => {
    expect((await shellOf(restarted, terminalId))?.state).toBe("lost");
    const res = await restarted.request(`/v1/shells/${terminalId}/restart`, {
      method: "POST",
      body: { idempotencyKey: `restart-${++keys}`, generation: 0 },
    });
    const replacement = ShellCommandResponse.parse(res.body).terminalId;
    await waitUntil(() => restarted.terminalOpen(replacement), "the new shell's terminal");
    expect(await restarted.terminalCwd(replacement)).toBe(`${restarted.work}/moved`);
    expect(await shellOf(restarted, terminalId)).toBeUndefined();
  });
});

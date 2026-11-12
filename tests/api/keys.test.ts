import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Daemon, waitUntil, type View } from "./daemon.ts";
import { readKeyLog } from "./fixtures/key-log.ts";

const probe = fileURLToPath(new URL("fixtures/key-probe.ts", import.meta.url));

let daemon: Daemon;
let terminalId = "";
let log = "";
beforeAll(async () => {
  daemon = await Daemon.start();
  log = join(daemon.work, "keys.log");
  const program = await daemon.program([process.execPath, probe, log]);
  terminalId = program.terminalId;
  await waitUntil(
    () => daemon.screen(program.agentId).includes("key-probe ready"),
    "the key probe",
  );
});
afterAll(async () => {
  await daemon?.stop();
});

/** The input the probe received since `since`, as one hex string. */
function receivedSince(since: number): string {
  return readKeyLog(log)
    .filter((a) => a.at >= since)
    .map((a) => a.hex)
    .join("");
}

const hex = (text: string) => Buffer.from(text, "latin1").toString("hex");

/** When the probe first received a lone Esc at or after `since`. */
function escArrivedAt(since: number): number {
  return (
    readKeyLog(log).find((a) => a.at >= since && a.hex === "1b")?.at ?? Number.POSITIVE_INFINITY
  );
}

async function driver(): Promise<View> {
  const view = await daemon.view(terminalId, "interactive");
  await view.drive();
  return view;
}

describe("keys through the terminal stream", () => {
  it("delivers a lone Esc at once, because the daemon answers tmux's terminal queries", async () => {
    const view = await driver();
    const sent = Date.now();
    view.type("\x1b");
    await expect
      .poll(() => escArrivedAt(sent), { timeout: 3000 })
      .toBeLessThan(Number.POSITIVE_INFINITY);
    expect(escArrivedAt(sent) - sent).toBeLessThan(50);
    view.close();
  });

  it("never delivers a terminal reply that comes in as input", async () => {
    const view = await driver();
    const since = Date.now();
    view.type("\x1b[?2004;1$y");
    view.type("after");
    await expect.poll(() => receivedSince(since), { timeout: 3000 }).toContain(hex("after"));
    expect(receivedSince(since)).toBe(hex("after"));
    view.close();
  });

  it("drops a stray key from a view that isn't driving, and gives that view the lease", async () => {
    const laptop = await driver();
    const phone = await daemon.view(terminalId, "interactive");
    await phone.attached();
    const since = Date.now();
    phone.type("stray");
    await expect.poll(() => phone.driving()).toBe(true);
    phone.type("typed");
    await expect.poll(() => receivedSince(since), { timeout: 3000 }).toContain(hex("typed"));
    expect(receivedSince(since)).toBe(hex("typed"));
    laptop.close();
    phone.close();
  });

  it("keeps the lease with the driver when another view reports losing focus", async () => {
    const laptop = await driver();
    const phone = await daemon.view(terminalId, "interactive");
    await phone.attached();
    const since = Date.now();
    phone.type("\x1b[O");
    laptop.type("still-driving");
    await expect
      .poll(() => receivedSince(since), { timeout: 3000 })
      .toContain(hex("still-driving"));
    expect([receivedSince(since), laptop.driving(), phone.driving()]).toEqual([
      hex("still-driving"),
      true,
      false,
    ]);
    laptop.close();
    phone.close();
  });

  it("delivers the driver's focus reports to the program", async () => {
    const view = await driver();
    const since = Date.now();
    view.type("\x1b[O");
    view.type("\x1b[I");
    await expect.poll(() => receivedSince(since), { timeout: 3000 }).toBe(hex("\x1b[O\x1b[I"));
    view.close();
  });

  it("keeps the lease with the driver when another view's mouse wheel turns", async () => {
    const laptop = await driver();
    const phone = await daemon.view(terminalId, "interactive");
    await phone.attached();
    const since = Date.now();
    phone.type("\x1b[<65;10;5M");
    laptop.type("still-driving");
    await expect
      .poll(() => receivedSince(since), { timeout: 3000 })
      .toContain(hex("still-driving"));
    expect([receivedSince(since), laptop.driving(), phone.driving()]).toEqual([
      hex("still-driving"),
      true,
      false,
    ]);
    laptop.close();
    phone.close();
  });
});

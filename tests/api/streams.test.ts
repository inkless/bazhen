import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Daemon, waitUntil, type View } from "./daemon.ts";

let daemon: Daemon;
beforeAll(async () => {
  daemon = await Daemon.start();
});
afterAll(async () => {
  await daemon?.stop();
});

async function opened(
  terminalId: string,
  mode: "observe" | "interactive",
  size = { cols: 100, rows: 30 },
): Promise<View> {
  const view = await daemon.view(terminalId, mode, undefined, size);
  await view.attached();
  return view;
}

/**
 * Output fast enough to back up a stalled view: a large screen of distinct lines, which a runtime
 * that redraws a busy screen rather than stream every line still sends a lot of.
 */
const FLOOD = ["sh", "-c", "while :; do seq -f '%0990g' 1 100000; done"];
const BIG = { cols: 1000, rows: 500 };

const screens = (view: View) =>
  view.frames.flatMap((f) => (f.type === "screen" ? [f.alternate] : []));

/**
 * What `count` reads once it has read the same for 3 s: longer than the daemon keeps the client of
 * a terminal no view shows (`lingerMs`, 2 s), so none is parked, and any closing has closed.
 */
async function steady(count: () => number): Promise<number> {
  const reads: number[] = [];
  await waitUntil(
    () => reads.push(count()) > 30 && new Set(reads.slice(-31)).size === 1,
    "a steady count",
  );
  return Number(reads.at(-1));
}

describe("a view's stream over time", () => {
  it("tells a view when the program enters and leaves its alternate screen", async () => {
    const { terminalId } = await daemon.program([
      "sh",
      "-c",
      "sleep 1; printf '\\033[?1049hfull screen'; sleep 1; printf '\\033[?1049lback'; sleep 600",
    ]);
    const view = await opened(terminalId, "observe");
    await expect.poll(() => screens(view), { timeout: 5000 }).toEqual([false, true, false]);
    view.close();
  });

  it("ends a view whose socket stops reading, and keeps serving the others", async () => {
    const { terminalId } = await daemon.program(FLOOD);
    const stalled = await opened(terminalId, "observe", BIG);
    const live = await opened(terminalId, "interactive", BIG);
    stalled.stall();
    await waitUntil(() => live.received().length > 16 * 1024 * 1024, "16 MiB of output", 30_000);
    live.close();
    // Far more than a view may fall behind by has gone out since the stall, so the stalled view has
    // been ended: resumed, it reads what was sent before that, then why.
    stalled.resume();
    await expect
      .poll(() => stalled.frames.at(-1), { timeout: 30_000 })
      .toEqual({ type: "ended", reason: "evicted_slow" });
  });

  it("refuses a view of a terminal whose program's session is gone", async () => {
    const { agentId, terminalId } = await daemon.program(["sleep", "600"]);
    await daemon.endTerminal(agentId);
    const view = await daemon.view(terminalId, "observe");
    await view.closed();
    expect(view.frames.at(-1)).toEqual({
      type: "error",
      message: expect.stringContaining(`terminal ${terminalId}: gone`),
    });
  });

  it("leaves its holder no connection of a view after views come, go and fall behind", async () => {
    const { terminalId } = await daemon.program(FLOOD);
    const once = await opened(terminalId, "observe");
    once.close();
    await once.closed();
    const sockets = await daemon.holderSocketCounter(terminalId);
    const settled = await steady(sockets);
    for (let i = 0; i < 20; i++) {
      const view = await opened(terminalId, "observe");
      view.close();
      await view.closed();
    }
    const stalled = await opened(terminalId, "interactive", BIG);
    stalled.stall();
    const live = await opened(terminalId, "observe", BIG);
    await waitUntil(() => live.received().length > 16 * 1024 * 1024, "16 MiB of output", 30_000);
    live.close();
    stalled.resume();
    await stalled.closed();
    await expect.poll(sockets, { timeout: 10_000 }).toBe(settled);
  });
});

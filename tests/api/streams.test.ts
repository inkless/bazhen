import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVENTS, StateSnapshot } from "@bazhen/protocol";
import { Daemon, waitUntil, type EventClient, type View } from "./daemon.ts";

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

/** The daemon's event stream, from the next event on. */
async function eventsFromNow(): Promise<EventClient> {
  const { epoch, eventId } = StateSnapshot.parse((await daemon.request("/v1/state")).body);
  return daemon.events({ epoch, eventId });
}

/**
 * More output than a stalled view's kernel buffers can hold, many times over: one not evicted by
 * the time another view has had this much never will be.
 */
const PAST_ANY_BUFFER = 256 * 1024 * 1024;

/**
 * Resolves once the daemon has published that it ended `stalled` for falling behind. Output on
 * `live` doesn't prove that by any fixed amount, since how far behind a stalled view falls for it
 * depends on how much of its backlog the kernel holds; it only bounds the wait, which would
 * otherwise fill this process with `live`'s output.
 */
async function evicted(events: EventClient, stalled: View, live: View): Promise<void> {
  const id = stalled.attachmentId();
  const published = () =>
    events.frames.some(
      (f) =>
        f.type === "event" &&
        f.event.type === "attachment.ended" &&
        f.event.entityId === id &&
        EVENTS[f.event.type].payload.parse(f.event.payload).reason === "evicted_slow",
    );
  await waitUntil(
    () => published() || live.receivedBytes() > PAST_ANY_BUFFER,
    "the daemon to publish the stalled view's eviction",
    30_000,
  );
  if (!published()) {
    throw new Error(
      `the daemon never published the stalled view's eviction, though another view received ` +
        `${live.receivedBytes()} bytes`,
    );
  }
}

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
  it("carries the program's switches of screen in a view's bytes, with no screen frame", async () => {
    const { terminalId } = await daemon.program([
      "sh",
      "-c",
      "sleep 1; printf '\\033[?1049hfull screen'; sleep 1; printf '\\033[?1049lback'; sleep 600",
    ]);
    const view = await opened(terminalId, "observe");
    await expect.poll(() => view.output(), { timeout: 5000 }).toContain("back");
    const output = view.output();
    const entered = output.indexOf("\x1b[?1049hfull screen");
    const left = output.indexOf("\x1b[?1049lback");
    expect([entered >= 0, left > entered, view.frames.filter((f) => f.type === "screen")]).toEqual([
      true,
      true,
      [],
    ]);
    view.close();
  });

  it("ends a view whose socket stops reading, and keeps serving the others", async () => {
    const { terminalId } = await daemon.program(FLOOD);
    const stalled = await opened(terminalId, "observe", BIG);
    const live = await opened(terminalId, "interactive", BIG);
    const events = await eventsFromNow();
    try {
      stalled.stall();
      await evicted(events, stalled, live);
    } finally {
      events.close();
    }
    const served = live.receivedBytes();
    await waitUntil(
      () => live.receivedBytes() > served,
      "output for the live view after the eviction",
    );
    live.close();
    stalled.resume();
    await expect
      .poll(() => stalled.frames.at(-1), {
        timeout: 30_000,
        message: "the daemon published the eviction, but the stalled view was never told why",
      })
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
    const events = await eventsFromNow();
    try {
      stalled.stall();
      const live = await opened(terminalId, "observe", BIG);
      await evicted(events, stalled, live);
      live.close();
    } finally {
      events.close();
    }
    stalled.resume();
    await stalled.closed();
    await expect.poll(sockets, { timeout: 10_000 }).toBe(settled);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Daemon, waitUntil, type View } from "./daemon.ts";

let daemon: Daemon;
/** The daemon's PTYs before any view has opened, so with no tmux client of its own. */
let baseline = 0;
beforeAll(async () => {
  daemon = await Daemon.start({ runtime: "tmux" });
  baseline = daemon.ptyHandles();
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
 * Output fast enough to back up a stalled view. tmux redraws a busy pane's screen rather than
 * stream every line, so a large screen of distinct lines is what makes it send a lot.
 */
const FLOOD = ["sh", "-c", "while :; do seq -f '%0990g' 1 100000; done"];
const BIG = { cols: 1000, rows: 500 };

describe("a view's stream of a tmux terminal over time", () => {
  it("ends a view whose socket stops reading, and keeps serving the others", async () => {
    const { terminalId } = await daemon.program(FLOOD);
    const stalled = await opened(terminalId, "observe", BIG);
    const live = await opened(terminalId, "interactive", BIG);
    stalled.stall();
    await waitUntil(() => live.received().length > 16 * 1024 * 1024, "16 MiB of output", 30_000);
    live.close();
    // The daemon's client closes, and its PTY goes, only once the stalled view has been ended too.
    await expect.poll(() => daemon.ptyHandles(), { timeout: 30_000 }).toBeLessThanOrEqual(baseline);
    stalled.resume();
    await expect
      .poll(() => stalled.frames.at(-1), { timeout: 10_000 })
      .toEqual({ type: "ended", reason: "evicted_slow" });
  });

  it("ends views as disconnected when the daemon's tmux client is lost", async () => {
    const { agentId, terminalId } = await daemon.program(["sleep", "600"]);
    const view = await opened(terminalId, "observe");
    daemon.detachClients(agentId);
    await view.closed();
    expect(view.frames.at(-1)).toEqual({ type: "ended", reason: "disconnected" });
  });

  it("returns to its PTY baseline after views come, go and fall behind", async () => {
    const { terminalId } = await daemon.program(FLOOD);
    for (let i = 0; i < 20; i++) {
      const view = await opened(terminalId, "observe");
      view.close();
      await view.closed();
    }
    const stalled = await opened(terminalId, "interactive", BIG);
    stalled.stall();
    // The stalled view is evicted, and its client closed, once it falls far enough behind.
    await expect.poll(() => daemon.ptyHandles(), { timeout: 30_000 }).toBeLessThanOrEqual(baseline);
    stalled.resume();
    await stalled.closed();
    await expect.poll(() => daemon.ptyHandles(), { timeout: 5000 }).toBe(baseline);
  });
});

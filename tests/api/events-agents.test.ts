// The events an agent's launch records, streamed to a paired browser over HTTP. It needs agents, so
// it runs on the TypeScript daemon only until the Rust one launches them.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LaunchAgentResponse, StateSnapshot } from "@bazhen/protocol";
import { Daemon, waitUntil } from "./daemon.ts";

let daemon: Daemon;
beforeAll(async () => {
  daemon = await Daemon.start();
});
afterAll(async () => {
  await daemon?.stop();
});

const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);
const launch = async (key: string) =>
  LaunchAgentResponse.parse(
    (
      await daemon.request("/v1/agents", {
        method: "POST",
        body: { idempotencyKey: key, harness: "claude-code", cwd: daemon.work },
      })
    ).body,
  );
const consecutive = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => from + 1 + i);

describe("the event stream", () => {
  it("sends a client every event after the snapshot it read, in order, then the new ones", async () => {
    const before = await state();
    const client = await daemon.events(before);
    const launched = await launch("streamed");
    await expect.poll(() => client.ids()).toEqual(expect.arrayContaining(launched.eventIds));
    await daemon.caughtUp(client);
    expect(client.ids()).toEqual(consecutive(before.eventId, client.last()));
    expect(client.types()).toContain("agent.launched");
    client.close();
  });

  it("loses nothing a client saw across a kill -9, and resumes it where it stopped", async () => {
    const before = await state();
    const client = await daemon.events({ ...before, eventId: 0 });
    await daemon.caughtUp(client);
    const seen = client.ids();
    const stopped = client.last();
    await daemon.crash();
    await waitUntil(() => client.ended(), "the stream to drop");
    await daemon.restart();
    await launch("after the restart");
    const after = await state();
    const resumed = await daemon.events({ epoch: before.epoch, eventId: stopped });
    const full = await daemon.events({ ...after, eventId: 0 });
    await daemon.caughtUp(full);
    await daemon.caughtUp(resumed);
    expect(after.epoch).toBe(before.epoch);
    expect(full.ids().slice(0, seen.length)).toEqual(seen);
    expect(resumed.ids()).toEqual(consecutive(stopped, resumed.last()));
    resumed.close();
    full.close();
  });
});

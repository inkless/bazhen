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
/** The newest event a stream has delivered, or 0 before any. */
const lastOf = (ids: readonly number[]) => ids.at(-1) ?? 0;
const consecutive = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => from + 1 + i);

describe("the event stream", () => {
  it("sends a client every event after the snapshot it read, in order, then the new ones", async () => {
    const before = await state();
    const client = await daemon.events(before);
    const launched = await launch("streamed");
    await expect.poll(() => client.ids()).toEqual(expect.arrayContaining(launched.eventIds));
    await expect.poll(async () => client.ids().at(-1)).toBe((await state()).eventId);
    expect(client.ids()).toEqual(consecutive(before.eventId, (await state()).eventId));
    expect(client.types()).toContain("agent.launched");
    client.close();
  });

  it("resumes a client that reconnects after the last event it saw, with exactly the rest", async () => {
    const all = await daemon.events({ ...(await state()), eventId: 0 });
    const newest = (await state()).eventId;
    await expect.poll(() => all.ids().at(-1)).toBe(newest);
    const seen = Math.floor(newest / 2);
    const resumed = await daemon.events({ ...(await state()), eventId: seen });
    await expect.poll(() => resumed.ids().at(-1)).toBe(newest);
    expect(resumed.ids()).toEqual(all.ids().filter((id) => id > seen));
    all.close();
    resumed.close();
  });

  it("tells a client whose cursor this store never issued to start again from the snapshot", async () => {
    const now = await state();
    const clients = await Promise.all([
      daemon.events({ epoch: "0".repeat(32), eventId: 0 }),
      daemon.events({ epoch: now.epoch, eventId: now.eventId + 1000 }),
    ]);
    for (const client of clients) {
      await expect.poll(() => client.frames).toEqual([{ type: "reset", reason: "foreign" }]);
      await expect.poll(() => client.ended()).toBe(true);
    }
  });

  it("refuses a stream from another origin, a client of another major version, and a bad path", async () => {
    const cursor = await state();
    const refusals = await Promise.all(
      [
        daemon.events(cursor, { origin: "http://evil.example" }),
        daemon.events(cursor, { version: "2.0" }),
        daemon.events(cursor, { path: "/v1/eventz" }),
      ].map((p) =>
        p.then(
          () => "open",
          (err: unknown) => String(err),
        ),
      ),
    );
    expect(refusals).toEqual(["Error: refused: 403", "Error: refused: 400", "Error: refused: 404"]);
  });

  it("loses nothing a client saw across a kill -9, and resumes it where it stopped", async () => {
    // The agents launched so far go on recording events, after a restart too, as the daemon
    // reconciles them: a stream is caught up when it reaches the newest event, not a snapshot's.
    const newest = async () => (await state()).eventId;
    const before = await state();
    const client = await daemon.events({ ...before, eventId: 0 });
    await expect.poll(async () => client.ids().at(-1) === (await newest())).toBe(true);
    const seen = client.ids();
    const stopped = lastOf(seen);
    await daemon.kill();
    await waitUntil(() => client.ended(), "the stream to drop");
    await daemon.restart();
    await launch("after the restart");
    const after = await state();
    const resumed = await daemon.events({ epoch: before.epoch, eventId: stopped });
    const full = await daemon.events({ ...after, eventId: 0 });
    await expect.poll(async () => full.ids().at(-1) === (await newest())).toBe(true);
    await expect.poll(async () => resumed.ids().at(-1) === (await newest())).toBe(true);
    expect(after.epoch).toBe(before.epoch);
    expect(full.ids().slice(0, seen.length)).toEqual(seen);
    expect(resumed.ids()).toEqual(consecutive(stopped, lastOf(resumed.ids())));
    resumed.close();
    full.close();
  });
});

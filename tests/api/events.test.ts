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
// CONTROL: the store goes on recording, an event every 100 ms, while the cases read it.
let forced = 0;
let trickle: ReturnType<typeof setInterval> | undefined;
beforeAll(() => {
  trickle = setInterval(() => {
    daemon
      .request("/v1/tasks", {
        method: "POST",
        body: {
          idempotencyKey: `trickle-${++forced}`,
          title: "Trickle",
          brief: "An event recorded while a stream is read.",
        },
      })
      .catch(() => undefined);
  }, 100);
});
afterAll(() => clearInterval(trickle));

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

  it("resumes a client that reconnects after the last event it saw, with exactly the rest", async () => {
    const all = await daemon.events({ ...(await state()), eventId: 0 });
    await daemon.caughtUp(all);
    const seen = Math.floor(all.last() / 2);
    const resumed = await daemon.events({ ...(await state()), eventId: seen });
    await daemon.caughtUp(resumed);
    expect(all.ids()).toEqual(consecutive(0, all.last()));
    expect(resumed.ids()).toEqual(consecutive(seen, resumed.last()));
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
    const before = await state();
    const client = await daemon.events({ ...before, eventId: 0 });
    await daemon.caughtUp(client);
    const seen = client.ids();
    const stopped = client.last();
    await daemon.kill();
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

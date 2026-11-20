// The event stream and the state it resumes from as a paired browser reads them, over HTTP. It
// runs on the TypeScript daemon only until the Rust one pairs browsers.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateSnapshot } from "@bazhen/protocol";
import { Daemon } from "./daemon.ts";

let daemon: Daemon;
beforeAll(async () => {
  daemon = await Daemon.start();
});
afterAll(async () => {
  await daemon?.stop();
});

const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);
const consecutive = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => from + 1 + i);

describe("the event stream", () => {
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

  it("takes a stream that names no protocol version, and refuses another origin and a bad path", async () => {
    const cursor = await state();
    const outcomes = await Promise.all(
      [
        daemon.events(cursor),
        daemon.events(cursor, { origin: "http://evil.example" }),
        daemon.events(cursor, { path: "/v1/eventz" }),
      ].map((p) =>
        p.then(
          (client) => {
            client.close();
            return "open";
          },
          (err: unknown) => String(err),
        ),
      ),
    );
    expect(outcomes).toEqual(["open", "Error: refused: 403", "Error: refused: 404"]);
  });
});

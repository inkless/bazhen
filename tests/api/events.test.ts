// The event stream as the CLI reads it, over the socket, with tasks the human makes as the events.
// Both daemons pass it. A paired browser's stream is in events-browser.test.ts, and the events an
// agent's launch records in events-agents.test.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreateTaskResponse, StateSnapshot } from "@bazhen/protocol";
import { Daemon, overSocket, waitUntil } from "./daemon.ts";

let daemon: Daemon;
beforeAll(async () => {
  daemon = await Daemon.start();
});
afterAll(async () => {
  await daemon?.stop();
});

const state = async () => {
  const res = await overSocket(daemon.socket, "GET", "/v1/state");
  expect(res.status).toBe(200);
  return StateSnapshot.parse(res.body);
};
const create = async (key: string) => {
  const body = { idempotencyKey: key, title: `task ${key}`, brief: "the brief" };
  const res = await overSocket(daemon.socket, "POST", "/v1/tasks", { body });
  expect(res.status).toBe(200);
  return CreateTaskResponse.parse(res.body);
};
const consecutive = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => from + 1 + i);

describe("the event stream", () => {
  it("sends a socket client every event after the snapshot it read, in order, then each new task's", async () => {
    const before = await state();
    const client = await daemon.socketEvents(before);
    const created = await create("streamed");
    await expect.poll(() => client.ids()).toEqual(expect.arrayContaining(created.eventIds));
    expect(await create("streamed")).toEqual(created);
    await create("streamed after");
    await daemon.caughtUp(client);
    expect(client.ids()).toEqual(consecutive(before.eventId, client.last()));
    expect(client.payloads("task.created")).toEqual([
      { title: "task streamed", ownerAgentId: null, parentTaskId: null, delegatedFrom: null },
      { title: "task streamed after", ownerAgentId: null, parentTaskId: null, delegatedFrom: null },
    ]);
    client.close();
  });

  it("resumes a socket client that reconnects after the last event it saw, with exactly the rest", async () => {
    for (const key of ["resumed 1", "resumed 2", "resumed 3"]) await create(key);
    const all = await daemon.socketEvents({ ...(await state()), eventId: 0 });
    await daemon.caughtUp(all);
    const seen = Math.floor(all.last() / 2);
    const resumed = await daemon.socketEvents({ ...(await state()), eventId: seen });
    await daemon.caughtUp(resumed);
    expect(all.ids()).toEqual(consecutive(0, all.last()));
    expect(resumed.ids()).toEqual(consecutive(seen, resumed.last()));
    all.close();
    resumed.close();
  });

  it("tells a socket client whose cursor this store never issued to start again from the snapshot", async () => {
    const now = await state();
    const clients = await Promise.all([
      daemon.socketEvents({ epoch: "0".repeat(32), eventId: 0 }),
      daemon.socketEvents({ epoch: now.epoch, eventId: now.eventId + 1000 }),
    ]);
    for (const client of clients) {
      await expect.poll(() => client.frames).toEqual([{ type: "reset", reason: "foreign" }]);
      await expect.poll(() => client.ended()).toBe(true);
    }
  });

  it("takes a socket stream naming no protocol version, and refuses another origin and a bad path", async () => {
    const cursor = await state();
    const outcomes = await Promise.all(
      [
        daemon.socketEvents(cursor),
        // The Host and Origin guard answers before pairing would, so no browser need pair.
        daemon.events(cursor, { origin: "http://evil.example", cookie: "" }),
        daemon.socketEvents(cursor, { path: "/v1/eventz" }),
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

  it("loses nothing a socket client saw across a kill -9, and resumes it where it stopped", async () => {
    await create("before the crash");
    const before = await state();
    const client = await daemon.socketEvents({ ...before, eventId: 0 });
    await daemon.caughtUp(client);
    const seen = client.ids();
    const stopped = client.last();
    await daemon.crash();
    await waitUntil(() => client.ended(), "the stream to drop");
    await daemon.restart();
    await create("after the restart");
    const after = await state();
    const resumed = await daemon.socketEvents({ epoch: before.epoch, eventId: stopped });
    const full = await daemon.socketEvents({ ...after, eventId: 0 });
    await daemon.caughtUp(full);
    await daemon.caughtUp(resumed);
    expect(after.epoch).toBe(before.epoch);
    expect(full.ids().slice(0, seen.length)).toEqual(seen);
    expect(resumed.ids()).toEqual(consecutive(stopped, resumed.last()));
    expect(resumed.ids().length).toBeGreaterThan(0);
    resumed.close();
    full.close();
  });
});

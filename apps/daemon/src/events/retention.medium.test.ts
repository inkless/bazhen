import { describe, expect, it } from "vitest";
import { age, visit, withAgent } from "../testing/fixtures.ts";
import { RETENTION_MS, retire } from "./retention.ts";

const AGED = "2026-01-01T00:00:00.000Z";
const after = (ms: number) => new Date(Date.parse(AGED) + ms);

describe("event retention", () => {
  it("retires events once they are 30 days old, past a single batch, and none sooner", async () => {
    const { path, store, terminalId } = await withAgent();
    const kept = store.events(0).length;
    for (let i = 0; i < 600; i++) visit(store, terminalId);
    age(path, AGED);
    await retire(store, after(RETENTION_MS - 1));
    const early = store.events(0, 5000).length;
    await retire(store, after(RETENTION_MS + 1));
    // What a projection points at stays, and so does the newest event.
    expect([early, store.events(0, 5000).length]).toEqual([kept + 1200, kept + 1]);
    store.close();
  });
});

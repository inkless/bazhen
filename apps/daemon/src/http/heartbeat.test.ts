import { describe, expect, it } from "vitest";
import { ViewHeartbeat } from "./heartbeat.ts";

const beats = (heart: ViewHeartbeat, unsent: readonly number[]) => unsent.map((u) => heart.beat(u));

describe("view heartbeat", () => {
  it("calls a view gone once a ping goes unanswered with nothing queued for it", () => {
    expect(beats(new ViewHeartbeat(4), [0, 0])).toEqual(["ping", "gone"]);
  });

  it("keeps a view that answers each ping", () => {
    const heart = new ViewHeartbeat(4);
    const seen = [heart.beat(0)];
    heart.heard();
    seen.push(heart.beat(0));
    expect(seen).toEqual(["ping", "ping"]);
  });

  it("waits its patience out for a view with output still queued, and no longer", () => {
    expect(beats(new ViewHeartbeat(3), [9, 9, 9, 9])).toEqual(["ping", "ping", "ping", "gone"]);
  });

  it("stays patient once the queue empties, while the last of it is on its way", () => {
    expect(beats(new ViewHeartbeat(3), [9, 0, 0, 0])).toEqual(["ping", "ping", "ping", "gone"]);
  });

  it("is impatient again once the view answers", () => {
    const heart = new ViewHeartbeat(3);
    const seen = beats(heart, [9, 0]);
    heart.heard();
    expect([...seen, ...beats(heart, [0, 0])]).toEqual(["ping", "ping", "ping", "gone"]);
  });
});

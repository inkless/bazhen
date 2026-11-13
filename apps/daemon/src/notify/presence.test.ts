import { describe, expect, it } from "vitest";
import { Presence, SEEN_FOR_MS } from "./presence.ts";

describe("presence", () => {
  it("counts a page in sight until it says otherwise, closes, or goes quiet", () => {
    const presence = new Presence();
    const [phone, laptop] = [{}, {}];
    presence.report(phone, true, 0);
    const shown = presence.seen(1_000);
    const quiet = presence.seen(SEEN_FOR_MS + 1);
    presence.gone(phone);
    presence.report(laptop, true, 0);
    presence.report(laptop, false, 10);
    const hidden = presence.seen(20);
    presence.report(laptop, true, 30);
    presence.gone(laptop);
    expect([shown, quiet, hidden, presence.seen(40)]).toEqual([true, false, false, false]);
  });
});

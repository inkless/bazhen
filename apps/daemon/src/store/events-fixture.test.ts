import { describe, expect, it } from "vitest";
import { z } from "zod";
import { eventRegistry } from "./events-fixture.ts";

const payload = z.object({
  title: z.string(),
  detail: z.object({ text: z.string(), at: z.number() }),
});

describe("the event registry the Rust daemon redacts by", () => {
  it("lists the streamed keys of a shape that only leaves top-level keys out", () => {
    const events = { "x.made": { entity: "x", payload, streamed: payload.omit({ detail: true }) } };
    expect(eventRegistry(events)).toEqual([{ type: "x.made", entity: "x", streamed: ["title"] }]);
  });

  it("refuses a streamed shape that changes a kept key, which a key filter can't redact", () => {
    const nested = payload.extend({ detail: payload.shape.detail.omit({ text: true }) });
    const transformed = payload.extend({ title: z.string().transform((t) => t.slice(0, 3)) });
    for (const streamed of [nested, transformed]) {
      expect(() => eventRegistry({ "x.made": { entity: "x", payload, streamed } })).toThrow(
        /x\.made: streams (detail|title) differently/,
      );
    }
  });

  it("refuses a payload that isn't an object, whose keys can't be listed", () => {
    expect(() => eventRegistry({ "x.made": { entity: "x", payload: z.string() } })).toThrow(
      /not an object/,
    );
  });
});

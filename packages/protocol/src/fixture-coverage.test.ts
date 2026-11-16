import { describe, expect, it } from "vitest";
import { z } from "zod";
import { enumPaths, type JsonSchema, replaceAt, uncovered } from "./fixture-coverage.ts";

const isSchema = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function schemaOf(schema: z.ZodType): JsonSchema {
  const json: unknown = z.toJSONSchema(schema, { io: "input" });
  if (!isSchema(json)) throw new Error("not an object");
  return json;
}

const Exit = z.discriminatedUnion("type", [
  z.object({ type: z.literal("exited"), code: z.number() }),
  z.object({ type: z.literal("unknown") }),
]);
const Thing = z.object({
  name: z.string(),
  note: z.string().optional(),
  owner: z.string().nullable(),
  state: z.enum(["on", "off"]),
  exit: Exit.nullable(),
  tags: z.array(z.object({ key: z.string() })),
  counts: z.record(z.string(), z.number()),
});

describe("uncovered", () => {
  it("names every property, optional, nullable, branch, enum value and record a set of values leaves out", () => {
    expect(uncovered(schemaOf(Thing), [])).toEqual(
      expect.arrayContaining([
        "present:name",
        "absent:note",
        "null:owner",
        'enum:state="on"',
        'enum:state="off"',
        "branch:exit.(type=exited)",
        "present:exit.(type=exited).code",
        "present:tags[].key",
        "present:counts{}",
      ]),
    );
  });

  it("leaves nothing out once the values exercise all of it", () => {
    const values = [
      {
        name: "a",
        note: "n",
        owner: "o",
        state: "on",
        exit: { type: "exited", code: 1 },
        tags: [{ key: "k" }],
        counts: { x: 1 },
      },
      { name: "b", owner: null, state: "off", exit: { type: "unknown" }, tags: [], counts: {} },
      { name: "c", owner: null, state: "off", exit: null, tags: [], counts: {} },
    ];
    expect(uncovered(schemaOf(Thing), values)).toEqual([]);
    expect(uncovered(schemaOf(Thing), values.slice(0, 2))).toEqual(["null:exit"]);
  });
});

describe("enumPaths and replaceAt", () => {
  it("finds each enum's place, through arrays and union branches", () => {
    const schema = schemaOf(
      z.object({
        items: z.array(
          z.object({
            exit: z.discriminatedUnion("type", [
              z.object({ type: z.literal("x"), how: z.enum(["a", "b"]) }),
            ]),
          }),
        ),
      }),
    );
    expect([...enumPaths(schema)]).toEqual([["items[].exit.(type=x).how", ["a", "b"]]]);
  });

  it("puts a value at every place a path names, and says when a value has no such place", () => {
    const value = { items: [{ exit: { type: "x", how: "a" } }, { exit: { type: "y" } }] };
    expect(replaceAt(value, "items[].exit.(type=x).how", "b")).toEqual({
      items: [{ exit: { type: "x", how: "b" } }, { exit: { type: "y" } }],
    });
    expect(replaceAt({ items: [] }, "items[].exit.(type=x).how", "b")).toBeUndefined();
    expect(replaceAt({ owner: null }, "owner.name", "b")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { messageProblems, methodsOf, problems, type Schema } from "./codex-schema.ts";

const valid = (schema: Schema, value: unknown) => problems(schema, value).length === 0;

describe("problems", () => {
  it("reads each type, an integer being a whole number", () => {
    expect(valid({ type: "integer" }, 3)).toBe(true);
    expect(valid({ type: "integer" }, 3.5)).toBe(false);
    expect(valid({ type: "number" }, 3.5)).toBe(true);
    expect(valid({ type: ["string", "null"] }, null)).toBe(true);
    expect(valid({ type: ["string", "null"] }, 1)).toBe(false);
    expect(valid({ type: "object" }, [])).toBe(false);
    expect(valid({ type: "array" }, [])).toBe(true);
    expect(valid({ type: "boolean" }, "true")).toBe(false);
  });

  it("holds a value to its enum, minLength and minimum", () => {
    expect(valid({ enum: ["a", "b"] }, "b")).toBe(true);
    expect(valid({ enum: ["a", "b"] }, "c")).toBe(false);
    expect(valid({ minLength: 2 }, "😀😀")).toBe(true);
    expect(valid({ minLength: 2 }, "😀")).toBe(false);
    expect(valid({ minimum: 0 }, 0)).toBe(true);
    expect(valid({ minimum: 0 }, -1)).toBe(false);
  });

  it("says which field of an object is missing or wrong", () => {
    const schema = {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, n: { type: "integer" } },
    };
    expect(problems(schema, { id: "x", n: 1, other: true })).toEqual([]);
    expect(problems(schema, { n: 1 })).toEqual(["$.id: missing"]);
    expect(problems(schema, { id: "x", n: "1" })).toEqual(["$.n: not integer"]);
    expect(problems({ additionalProperties: { type: "string" } }, { a: 1 })).toEqual([
      "$.a: not string",
    ]);
    expect(problems({ additionalProperties: false }, { a: 1 })).toEqual([
      "$.a: allowed by no schema",
    ]);
  });

  it("holds each item of a list", () => {
    expect(problems({ items: { type: "string" } }, ["a", 2])).toEqual(["$[1]: not string"]);
  });

  it("resolves a $ref in the root's definitions, and refuses one that names nothing", () => {
    const root = { definitions: { Id: { type: "string" } }, $ref: "#/definitions/Id" };
    expect(valid(root, "x")).toBe(true);
    expect(valid(root, 1)).toBe(false);
    expect(() => problems({ $ref: "#/definitions/Gone" }, 1)).toThrow(/names nothing/);
  });

  it("takes exactly one of oneOf, any of anyOf and all of allOf", () => {
    const oneOf = { oneOf: [{ type: "integer" }, { type: "number" }] };
    expect(valid(oneOf, 1.5)).toBe(true);
    expect(valid(oneOf, 1)).toBe(false);
    expect(valid({ anyOf: [{ type: "integer" }, { type: "number" }] }, 1)).toBe(true);
    expect(valid({ anyOf: [{ type: "string" }] }, 1)).toBe(false);
    expect(valid({ allOf: [{ type: "number" }, { minimum: 2 }] }, 1)).toBe(false);
  });

  it("refuses a keyword it doesn't read, so none goes unchecked", () => {
    expect(() => problems({ pattern: "^a" }, "b")).toThrow(/pattern/);
  });

  it("refuses a keyword in a form it doesn't read, so none is read as absent", () => {
    expect(() => problems({ items: [{ type: "string" }] }, ["a"])).toThrow(/items/);
    expect(() => problems({ enum: "a" }, "a")).toThrow(/enum/);
    expect(() => problems({ required: "id" }, {})).toThrow(/required/);
    expect(() => problems({ minimum: "0" }, 1)).toThrow(/minimum/);
  });

  it("takes a required field only as the object's own", () => {
    expect(problems({ required: ["toString"] }, {})).toEqual(["$.toString: missing"]);
  });
});

describe("Codex's own schema files", () => {
  it("name the methods the server sends", () => {
    expect(methodsOf({ oneOf: [{ properties: { method: { enum: ["a/b"] } } }] })).toEqual(["a/b"]);
  });

  it("hold a notification and a request to the branch their method names", () => {
    expect(messageProblems("thread/status/changed", { threadId: "t" })).toEqual([
      "$.params.status: missing",
    ]);
    expect(messageProblems("serverRequest/resolved", { threadId: "t", requestId: 1 })).toEqual([]);
    expect(messageProblems("item/tool/requestUserInput", { threadId: "t" })).not.toEqual([]);
    expect(messageProblems("thread/unknown", {})).toEqual([
      "$.method: Codex sends no thread/unknown",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import * as protocol from "./index.ts";
import { jsonSchemas } from "./json-schema.ts";

describe("jsonSchemas", () => {
  it("exports a file for every schema and nothing else", () => {
    const files = Object.keys(jsonSchemas());
    expect(files).toContain("HealthResponse.json");
    expect(files).not.toContain("isCompatible.json");
    expect(files).not.toContain("PROTOCOL_VERSION.json");
  });

  it("describes a schema's constraints, not just its shape", () => {
    const schema: unknown = JSON.parse(String(jsonSchemas()["TerminalState.json"]));
    expect(schema).toMatchObject({ $id: "TerminalState", enum: protocol.TerminalState.options });
  });

  it("leaves an object open to fields it doesn't know, since a newer peer adds them", () => {
    const schema: unknown = JSON.parse(String(jsonSchemas()["HolderStats.json"]));
    expect(schema).toMatchObject({
      type: "object",
      required: ["engineBytes", "rss", "ringBytes", "historyLines"],
    });
    expect(schema).not.toHaveProperty("additionalProperties");
  });

  it("publishes a version pattern every regex engine reads as ASCII digits", () => {
    const schema: unknown = JSON.parse(String(jsonSchemas()["ProtocolVersion.json"]));
    expect(schema).toMatchObject({ pattern: "^[0-9]+\\.[0-9]+$" });
  });

  it("keeps the schema of a record's values while opening objects", () => {
    const schema: unknown = JSON.parse(String(jsonSchemas()["HolderTags.json"]));
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: { type: "string", maxLength: 1024 },
    });
  });

  it("leaves a field with a default out of required, since an older peer omits it", () => {
    const schema: unknown = JSON.parse(String(jsonSchemas()["Environment.json"]));
    const properties: unknown = Reflect.get(Object(schema), "properties");
    expect([Object.keys(Object(properties)), Reflect.get(Object(schema), "required")]).toEqual([
      ["id", "kind", "host"],
      ["id", "kind"],
    ]);
  });
});

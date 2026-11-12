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
});

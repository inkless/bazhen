import { describe, expect, it } from "vitest";
import { HealthResponse } from "./index.ts";

describe("HealthResponse schema", () => {
  it("rejects a runtime state outside the declared set", () => {
    const parsed = HealthResponse.safeParse({
      status: "ok",
      appVersion: "0.1.0",
      protocolVersion: "1.0",
      schemaVersion: 1,
      runtime: { kind: "tmux", state: "dead", version: null },
    });
    expect(parsed.success).toBe(false);
  });
});

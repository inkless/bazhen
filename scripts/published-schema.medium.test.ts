import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// What a peer in another language relies on in the schema the Rust protocol publishes, read as
// committed.
describe("the published schema", () => {
  const dir = fileURLToPath(new URL("../packages/protocol/schema/", import.meta.url));
  const published = (name: string): unknown =>
    JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));

  it("leaves every object open, as a newer peer within the same major sends fields it adds", () => {
    const closed = readdirSync(dir).filter((name) =>
      readFileSync(join(dir, name), "utf8").includes('"additionalProperties": false'),
    );
    expect(closed).toEqual([]);
  });

  it("states a protocol version in ASCII digits, which a peer in any language reads alike", () => {
    expect(published("ProtocolVersion")).toMatchObject({ pattern: "^[0-9]+\\.[0-9]+$" });
  });

  it("keeps a schema for each holder tag's value", () => {
    expect(published("HolderTags")).toMatchObject({
      additionalProperties: { type: "string" },
    });
  });

  it("leaves a defaulted field out of required, as a peer older than it sends none", () => {
    expect(published("Environment")).toMatchObject({
      properties: { host: { default: "" } },
      required: ["id", "kind"],
    });
  });
});

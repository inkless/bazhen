import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Where a schema in `node`, at any depth, closes an object: each pointer below `at`. */
function closed(node: unknown, at: string): string[] {
  if (Array.isArray(node)) return node.flatMap((item, i) => closed(item, `${at}/${i}`));
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) =>
    ["additionalProperties", "unevaluatedProperties"].includes(key) && value === false
      ? [`${at}/${key}`]
      : closed(value, `${at}/${key}`),
  );
}

// What a peer in another language relies on in the schema the Rust protocol publishes, read as
// committed.
describe("the published schema", () => {
  const dir = fileURLToPath(new URL("../packages/protocol/schema/", import.meta.url));
  const published = (name: string): unknown =>
    JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));

  it("leaves every object open, as a newer peer within the same major sends fields it adds", () => {
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    expect(
      files.flatMap((name) => closed(JSON.parse(readFileSync(join(dir, name), "utf8")), name)),
    ).toEqual([]);
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

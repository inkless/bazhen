import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HOLDER_ERROR_CODES,
  HOLDER_PROTOCOL_VERSION,
  HOLDER_REPLY_CODES,
  HOLDER_REQUEST_CODES,
  HolderError,
} from "../packages/protocol/src/holder.ts";
import {
  type FrameFixture,
  FrameFixtures,
  frameOutcome,
  readSpawnSpec,
  SpawnSpecFixtures,
} from "../packages/protocol/src/holder-fixtures.ts";

const root = fileURLToPath(new URL("../packages/protocol/fixtures/holder/", import.meta.url));
const versions = readdirSync(root).toSorted((a, b) => a.localeCompare(b));
const read = (version: string, name: string): unknown =>
  JSON.parse(readFileSync(join(root, version, name), "utf8"));
const frames = (version: string) =>
  existsSync(join(root, version)) ? FrameFixtures.parse(read(version, "frames.json")) : [];
const specs = (version: string) => SpawnSpecFixtures.parse(read(version, "spawn-specs.json"));

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
const label = (fixture: FrameFixture) => `${fixture.direction} ${fixture.name}`;
const outcomeOf = (fixture: FrameFixture) =>
  frameOutcome(fixture.name, fixture.direction, fromHex(fixture.hex)).outcome;
const headOf = (fixture: FrameFixture) => {
  const outcome = outcomeOf(fixture);
  return "canonical" in outcome ? outcome.canonical.head : outcome;
};

const validFrames = (version: string) =>
  frames(version).flatMap((fixture) =>
    "canonical" in fixture.outcome
      ? [[label(fixture), fixture, fixture.outcome.canonical.head] as const]
      : [],
  );
const validSpecs = (version: string) =>
  specs(version).flatMap((fixture) =>
    "canonical" in fixture.outcome ? [[fixture.name, fixture.json] as const] : [],
  );

const codesOf = (direction: string) =>
  [
    ...new Set(
      frames(HOLDER_PROTOCOL_VERSION).flatMap((fixture) =>
        fixture.direction === direction && "canonical" in fixture.outcome
          ? [Number.parseInt(fixture.outcome.canonical.head.slice(0, 2), 16)]
          : [],
      ),
    ),
  ].toSorted((a, b) => a - b);
const sorted = (codes: Record<string, number>) => Object.values(codes).toSorted((a, b) => a - b);
const errorCodes = () =>
  frames(HOLDER_PROTOCOL_VERSION).flatMap((fixture) => {
    const json = "canonical" in fixture.outcome ? fixture.outcome.canonical.json : undefined;
    const error = HolderError.safeParse(json);
    return fixture.direction === "reply" && error.success ? [error.data.code] : [];
  });

describe("holder fixtures", () => {
  it("are kept for the current version", () => {
    expect(versions).toContain(HOLDER_PROTOCOL_VERSION);
  });

  // Every version this build has fixtures of, its own included. A newer build may add fields to
  // what it re-encodes, and accept what an older one refused, so only what was valid is held to,
  // and only its type and binary fields.
  describe.each(versions)("of %s", (version) => {
    it.each(validFrames(version))(
      "still decode %s to its type, id and offset",
      (_, fixture, head) => {
        expect(headOf(fixture)).toBe(head);
      },
    );

    it.each(validSpecs(version))("still read the spawn spec %s", (_, json) => {
      expect(readSpawnSpec(json)).toHaveProperty("canonical");
    });
  });

  describe("of the current version", () => {
    it.each(frames(HOLDER_PROTOCOL_VERSION).map((fixture) => [label(fixture), fixture] as const))(
      "decode %s as recorded",
      (_, fixture) => {
        expect(outcomeOf(fixture)).toEqual(fixture.outcome);
      },
    );

    it("hold every request and reply type, valid", () => {
      expect([codesOf("request"), codesOf("reply")]).toEqual([
        sorted(HOLDER_REQUEST_CODES),
        sorted(HOLDER_REPLY_CODES),
      ]);
    });

    it("hold every error code", () => {
      expect(errorCodes()).toEqual(expect.arrayContaining([...HOLDER_ERROR_CODES]));
    });
  });
});

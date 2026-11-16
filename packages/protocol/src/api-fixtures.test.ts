import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiFixtures, checkFixtures, messageFixtures } from "./api-fixtures.ts";
import { StateSnapshot } from "./agents.ts";
import { wellFormed } from "./fixture-coverage.ts";

describe("the API fixtures", () => {
  it("write one file per message, and the checks", () => {
    const files = Object.keys(apiFixtures());
    expect(files).toEqual(expect.arrayContaining(["StateSnapshot.json", "checks.json"]));
  });

  it("pair each wire value with what the protocol makes of it, and try every enum value", () => {
    const fixtures = messageFixtures("Thing", {
      schema: z.object({ state: z.enum(["on", "off"]), shells: z.array(z.string()).default([]) }),
      wire: [{ state: "on" }, { state: "off", shells: ["s"] }],
    });
    expect(fixtures.map((f) => [f.name, f.parsed])).toEqual([
      ["example 1", { state: "on", shells: [] }],
      ["example 2", { state: "off", shells: ["s"] }],
      ['state = "on"', { state: "on", shells: [] }],
      ['state = "off"', { state: "off", shells: [] }],
      [
        "example 1, with a field no version defines in each of its objects",
        { state: "on", shells: [] },
      ],
      [
        "example 2, with a field no version defines in each of its objects",
        { state: "off", shells: ["s"] },
      ],
    ]);
  });

  it("give what the protocol makes of a lone surrogate as UTF-8 holds it, and a printed message's text", () => {
    const [fixture] = messageFixtures("Thing", {
      schema: z.object({ b: z.string(), a: z.string() }),
      wire: [{ a: "x", b: "half \ud83d" }],
      printed: true,
    });
    expect(fixture).toEqual({
      name: "example 1",
      wire: { a: "x", b: "half \ud83d" },
      parsed: { b: "half \ufffd", a: "x" },
      text: '{"b":"half \ufffd","a":"x"}',
    });
  });

  it("refuse examples that leave part of a message unexercised", () => {
    expect(() =>
      messageFixtures("Thing", {
        schema: z.object({ owner: z.string().nullable() }),
        wire: [{ owner: "o" }],
      }),
    ).toThrow("fixtures for Thing leave unexercised: null:owner");
  });

  it("hold snapshots the protocol accepts as they are written", () => {
    const { "StateSnapshot.json": file } = apiFixtures();
    const fixtures: { wire: unknown; parsed: unknown }[] = JSON.parse(String(file));
    expect(fixtures.length).toBeGreaterThan(10);
    for (const f of fixtures) expect(wellFormed(StateSnapshot.parse(f.wire))).toEqual(f.parsed);
  });

  it("give each check's verdict as the protocol gives it", () => {
    const checks = checkFixtures();
    expect(checks.taskNoteText.find((c) => c.input === "  padded\n")).toEqual({
      input: "  padded\n",
      ok: true,
      value: "padded",
    });
    expect(checks.agentRef.find((c) => c.input === "../tasks")?.ok).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigFile } from "./config.ts";
import { configFixture, LEAVES } from "./fixture.ts";

const Fixture = z.object({
  file: z.string(),
  cases: z.array(
    z.object({
      name: z.string(),
      toml: z.string(),
      env: z.record(z.string(), z.string()),
      lan: z.boolean(),
      outcome: z.union([
        z.strictObject({ error: z.string(), syntax: z.literal(true).optional() }),
        z.strictObject({ config: z.record(z.string(), z.unknown()) }),
      ]),
    }),
  ),
});

const fixture = () => {
  const files = configFixture();
  expect(Object.keys(files)).toEqual(["typescript.json"]);
  return Fixture.parse(JSON.parse(files["typescript.json"] ?? ""));
};

const { file, cases } = fixture();

/** The dotted path of each table, the top level's empty, and of each key in one. */
function keys(schema: z.core.$ZodType, path = ""): { tables: string[]; leaves: string[] } {
  const inner = schema instanceof z.ZodOptional ? schema.unwrap() : schema;
  if (!(inner instanceof z.ZodObject)) return { tables: [], leaves: [path] };
  const below = Object.entries(inner.shape).map(([key, value]) =>
    keys(value, path === "" ? key : `${path}.${key}`),
  );
  return {
    tables: [path, ...below.flatMap((b) => b.tables)],
    leaves: below.flatMap((b) => b.leaves),
  };
}

const { tables, leaves } = keys(ConfigFile);

/** Each refusal of a case that doesn't reach the LAN, without the file's name. */
const refusals = cases.flatMap((c) =>
  "error" in c.outcome && !c.lan ? [c.outcome.error.replace(`${file}: `, "")] : [],
);
const taken = cases.filter((c) => "config" in c.outcome);

const takenAt = (key: string) => taken.filter((c) => c.name.startsWith(`${key} takes`)).length;
const refusedAt = (key: string) => refusals.filter((e) => e.startsWith(`${key}: `)).length;
const where = (table: string) => (table === "" ? "(top level)" : table);
const takenWith = (name: string) => taken.filter((c) => c.env[name] !== undefined).length;
const refusedFor = (name: string) =>
  refusals.filter((e) => e.startsWith(`${name}=`) || e.startsWith(`${name}: `)).length;
const reachesLan = (c: (typeof cases)[number]) =>
  c.toml.includes('listen = "lan"') || c.env.BAZHEN_WEB_LISTEN === "lan";

describe("configFixture", () => {
  it("lists every key the file holds", () => {
    expect(LEAVES.map((l) => `${l.table}.${l.key}`).toSorted()).toEqual(leaves.toSorted());
  });

  it.each(leaves)("takes, and refuses, %s", (key) => {
    expect(takenAt(key)).toBeGreaterThan(0);
    expect(refusedAt(key)).toBeGreaterThan(0);
  });

  it.each(tables.map(where))("refuses an unknown key in %s", (at) => {
    expect(refusals).toContain(`${at}: Unrecognized key: "nope"`);
  });

  it.each(tables.filter((t) => t !== ""))("refuses %s of the wrong type", (table) => {
    expect(refusals).toContain(`${table}: Invalid input: expected object, received number`);
  });

  it.each([
    "BAZHEN_PORT",
    "BAZHEN_AGENTS_SHELL",
    "BAZHEN_PAIRING",
    "BAZHEN_ALLOW_INSECURE_ORIGINS",
    "BAZHEN_WEB_LISTEN",
    "BAZHEN_EXTERNAL_ORIGINS",
  ])("takes %s, and refuses it", (name) => {
    expect(takenWith(name)).toBeGreaterThan(0);
    expect(refusedFor(name)).toBeGreaterThan(0);
  });

  it("refuses a login shell with no SHELL", () => {
    expect(refusals).toContain('agents.shell is "login", but SHELL is unset');
  });

  it("marks the cases that reach the LAN listener, and only those", () => {
    const lan = cases.filter((c) => c.lan);
    expect(lan.length).toBeGreaterThan(0);
    expect(lan.filter((c) => !reachesLan(c)).map((c) => c.name)).toEqual([]);
    expect(
      cases.find((c) => c.name === "BAZHEN_WEB_LISTEN=loopback over the file's lan"),
    ).toMatchObject({ lan: false });
  });
});

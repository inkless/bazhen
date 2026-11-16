import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentName, AgentRef, defaultName, nameBase } from "./agent-name.ts";

/** A well-formed id's body, after its prefix. */
const BODY = "019a7b2c3d4e7f00a1b2c3d4e5f60718";
const takes = (name: string) => AgentName.safeParse(name).success;
const refers = (ref: string) => AgentRef.safeParse(ref).success;
/** What a client in another language enforces: the generated schema's pattern, case and all. */
const schemaTakes = (name: string) => {
  const pattern = Reflect.get(z.toJSONSchema(AgentName), "pattern");
  return new RegExp(String(pattern)).test(name);
};

describe("AgentName", () => {
  it("takes letters, digits, - and _ up to 40, and nothing else", () => {
    expect([takes("BZ-127_a"), takes("x".repeat(40)), takes("x".repeat(41)), takes("a b")]).toEqual(
      [true, true, false, false],
    );
  });

  it("starts with a letter or digit, so a command line never reads it as an option", () => {
    expect([takes("-x"), takes("--help"), takes("_x"), takes("7x")]).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("is never a whole id of any kind, and may start as one does", () => {
    const kinds = ["host", "env", "agent", "task", "asgn", "attn", "ntc", "msg", "term", "dev"];
    const ids = [...kinds, "att", "lease"].map((p) => `${p}_${BODY}`);
    expect([ids.filter(takes), takes("agent_tools-1"), takes(`AGENT_${BODY}`)]).toEqual([
      [],
      true,
      true,
    ]);
  });

  it("holds every rule in the published schema too", () => {
    expect([
      schemaTakes("BZ-127"),
      schemaTakes("agent_tools"),
      schemaTakes(`task_${BODY}`),
      schemaTakes("-x"),
    ]).toEqual([true, true, false, false]);
  });
});

describe("AgentRef", () => {
  it("takes an agent's id or a name, and not a path", () => {
    expect([refers(`agent_${BODY}`), refers("BZ-127"), refers("../tasks")]).toEqual([
      true,
      true,
      false,
    ]);
  });
});

describe("nameBase", () => {
  it("keeps a project that is already a name as it is", () => {
    expect(nameBase("bazhen_web-2")).toBe("bazhen_web-2");
  });

  it("turns each run of other characters into one dash, trimmed at the ends", () => {
    expect(nameBase(" my.app (copy) ")).toBe("my-app-copy");
  });

  it("names a project of nothing a name can hold agent", () => {
    expect(nameBase("..·..")).toBe("agent");
  });

  it("starts with a letter or digit, whatever the project starts with", () => {
    expect(["agent_tools", ".agent_tools", "-x", "(x)", "__x__"].map(nameBase)).toEqual([
      "agent_tools",
      "agent_tools",
      "x",
      "x",
      "x",
    ]);
  });

  it("cuts a long project to one length, whatever follows the cut", () => {
    const long = "x".repeat(40);
    expect([nameBase(`${long}a`), nameBase(`${long}b`)]).toEqual(["x".repeat(32), "x".repeat(32)]);
  });

  it("makes a valid name with a seven-digit number from any project", () => {
    const fragment = fc.constantFrom("agent_", BODY, "-", "_", ".", " ", "a", "Z", "7", "é");
    const project = fc.oneof(
      fc.string({ unit: "grapheme", maxLength: 60 }),
      fc.array(fragment, { maxLength: 30 }).map((parts) => parts.join("")),
    );
    fc.assert(
      fc.property(project, (p) => {
        expect(defaultName(nameBase(p), 9_999_999)).toMatch(/^[A-Za-z0-9]/);
        expect(takes(defaultName(nameBase(p), 9_999_999))).toBe(true);
      }),
    );
  });
});

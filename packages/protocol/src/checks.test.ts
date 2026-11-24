import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  agentOrLaunch,
  linkedShellTakesNoCwd,
  noControl,
  refusingOwnProto,
  screenText,
  unmarkedPasteIsAscii,
  utf8AtMost1024Bytes,
  utf8AtMost32Bytes,
  utf8AtMost64Bytes,
  wellFormed,
} from "./checks.ts";

describe("the checks the Rust schema names", () => {
  it.each([
    [utf8AtMost32Bytes, 32],
    [utf8AtMost64Bytes, 64],
    [utf8AtMost1024Bytes, 1024],
  ])("counts UTF-8 bytes, not characters, up to the budget", (check, max) => {
    expect(check("a".repeat(max))).toBe(true);
    expect(check("a".repeat(max + 1))).toBe(false);
    expect(check("é".repeat(max / 2))).toBe(true);
    expect(check(`${"é".repeat(max / 2)}a`)).toBe(false);
    expect(check.message).toBe(`at most ${max} UTF-8 bytes`);
  });

  it("refuses a lone surrogate, which has no UTF-8, and takes a pair", () => {
    expect(wellFormed("\ud83d")).toBe(false);
    expect(wellFormed("a\ude00")).toBe(false);
    expect(wellFormed("\ud83d\ude00")).toBe(true);
  });

  it.each(["\n", "\t", "\u0000", "\u001b", "\u007f", "\u0080", "\u009f"])(
    "refuses the control %j, and a screen takes it only as a newline",
    (control) => {
      expect(noControl(`a${control}`)).toBe(false);
      expect(screenText(`a${control}`)).toBe(control === "\n");
    },
  );

  it("takes text past ASCII that holds no control", () => {
    expect(noControl("a\u00a0é")).toBe(true);
    expect(screenText("a\u00a0é\n")).toBe(true);
  });

  it("takes text beyond printable ASCII in a paste only marked with brackets", () => {
    expect(unmarkedPasteIsAscii({ text: " ~", brackets: false })).toBe(true);
    expect(unmarkedPasteIsAscii({ text: "é", brackets: false })).toBe(false);
    expect(unmarkedPasteIsAscii({ text: "é", brackets: true })).toBe(true);
  });

  it("refuses an own __proto__ key a record would skip, and nothing else", () => {
    const record = z.preprocess(refusingOwnProto, z.record(z.string(), z.string()));
    expect(
      z.record(z.string(), z.string()).safeParse(JSON.parse('{"__proto__":"x"}')).success,
    ).toBe(true);
    expect(record.safeParse(JSON.parse('{"__proto__":"x"}')).success).toBe(false);
    expect(record.safeParse({ a: "x", constructor: "y" }).success).toBe(true);
  });

  it("takes a delegation naming an agent or a launch, never both or neither", () => {
    expect(agentOrLaunch({ agentId: "agent_x" })).toBe(true);
    expect(agentOrLaunch({ launch: {} })).toBe(true);
    expect(agentOrLaunch({ agentId: "agent_x", launch: {} })).toBe(false);
    expect(agentOrLaunch({})).toBe(false);
  });

  it("takes a cwd only for a shell linked to no agent", () => {
    expect(linkedShellTakesNoCwd({})).toBe(true);
    expect(linkedShellTakesNoCwd({ cwd: "/tmp" })).toBe(true);
    expect(linkedShellTakesNoCwd({ linkedAgentId: "agent_x" })).toBe(true);
    expect(linkedShellTakesNoCwd({ linkedAgentId: "agent_x", cwd: "/tmp" })).toBe(false);
  });
});

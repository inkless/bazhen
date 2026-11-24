import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  agentOrLaunch,
  finishNoteText,
  linkedShellTakesNoCwd,
  newTaskTitle,
  refusingOwnProto,
  taskNoteText,
  utf8AtMost1024Bytes,
  utf8AtMost32Bytes,
  utf8AtMost64Bytes,
} from "./checks.ts";
import { FinishNoteText, NewTaskTitle, TASK_NOTE_MAX_BYTES, TaskNoteText } from "./tasks.ts";

/** Text each rule should judge: plain, each kind of control and invisible, and at the budgets. */
const TEXTS = [
  "plain",
  "two\nlines",
  "a\ttab",
  "a\rreturn",
  "bell\u0007",
  "escape\u001b[1m",
  "del\u007f",
  "c1\u0085",
  "over\u202eride",
  "isolate\u2066",
  "zero\u200bwidth",
  "word\u2060joiner",
  "bom\ufeff",
  "tag\u{e0041}",
  "lone\ud83d",
  "pair\ud83d\ude00",
  "a".repeat(TASK_NOTE_MAX_BYTES),
  "a".repeat(TASK_NOTE_MAX_BYTES + 1),
  `${"é".repeat(TASK_NOTE_MAX_BYTES / 2)}a`,
];

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
  });

  it("refuses a lone surrogate, which has no UTF-8, and takes a pair", () => {
    expect(utf8AtMost32Bytes("\ud83d")).toBe(false);
    expect(utf8AtMost32Bytes("\ud83d\ude00")).toBe(true);
  });

  it("refuses an own __proto__ key a record would skip, and nothing else", () => {
    const record = z.preprocess(refusingOwnProto, z.record(z.string(), z.string()));
    expect(
      z.record(z.string(), z.string()).safeParse(JSON.parse('{"__proto__":"x"}')).success,
    ).toBe(true);
    expect(record.safeParse(JSON.parse('{"__proto__":"x"}')).success).toBe(false);
    expect(record.safeParse({ a: "x", constructor: "y" }).success).toBe(true);
  });

  it.each([
    ["NewTaskTitle", z.string().trim().min(1).max(200).refine(newTaskTitle), NewTaskTitle],
    ["TaskNoteText", z.string().trim().min(1).refine(taskNoteText), TaskNoteText],
    ["FinishNoteText", z.string().max(20000).refine(finishNoteText), FinishNoteText],
  ] as const)(
    "%s as the Rust schema writes it judges text as the protocol does",
    (_, written, protocol) => {
      for (const text of TEXTS) {
        expect({ text, ok: written.safeParse(text).success }).toEqual({
          text,
          ok: protocol.safeParse(text).success,
        });
      }
    },
  );

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

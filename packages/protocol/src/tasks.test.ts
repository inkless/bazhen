import { describe, expect, it } from "vitest";
import { Event } from "./events.ts";
import { AddTaskNoteRequest, CreateTaskRequest, FinishTaskRequest, quoteNote } from "./tasks.ts";

const created = {
  id: 1,
  ts: "2026-11-12T00:00:00.000Z",
  type: "task.created",
  entityType: "task",
  entityId: "task_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d",
  actor: "human",
  causationId: null,
  correlationId: null,
  payload: { title: "t", brief: "secret plan", ownerAgentId: null, parentTaskId: null },
};

describe("task schemas", () => {
  it("refuses a brief longer than a message to the assignee may be", () => {
    const request = { idempotencyKey: "k", title: "t", brief: "x".repeat(20_001) };
    expect(CreateTaskRequest.safeParse(request).success).toBe(false);
  });

  it("refuses a blank title", () => {
    const request = { idempotencyKey: "k", title: "  ", brief: "b" };
    expect(CreateTaskRequest.safeParse(request).success).toBe(false);
  });

  it("can't finish a task as open", () => {
    expect(FinishTaskRequest.safeParse({ idempotencyKey: "k", outcome: "open" }).success).toBe(
      false,
    );
  });

  it("streams a created task without its brief", () => {
    const streamed = Event.parse(created);
    expect(streamed.payload).not.toHaveProperty("brief");
  });

  it("streams a note without its text", () => {
    const payload = { text: "secret", handoff: true, role: "worker" };
    const noted = { ...created, type: "task.noted", payload };
    expect(Event.parse(noted).payload).toEqual({ handoff: true, role: "worker" });
  });
});

const note = (text: string) => AddTaskNoteRequest.safeParse({ idempotencyKey: "k", text });

/** Whether a finish request takes the note. */
const finishes = (said: string) =>
  FinishTaskRequest.safeParse({ idempotencyKey: "k", outcome: "done", note: said }).success;

describe("a task note", () => {
  it("counts its limit in UTF-8 bytes, not characters", () => {
    expect([note("\u00e9".repeat(2000)).success, note("\u00e9".repeat(2001)).success]).toEqual([
      true,
      false,
    ]);
  });

  it("keeps newlines and tabs, and refuses every other control and a bidirectional override", () => {
    expect(note("line one\n\tline two").success).toBe(true);
    const bad = ["\u001b[2J", "a\rb", "\u0000", "\u007f", "\u009b31m", "\u202eevil"];
    expect(bad.filter((text) => note(`x${text}`).success)).toEqual([]);
  });

  it("refuses a character that draws as nothing, a tag character among them", () => {
    const hidden = [
      "\u2028",
      "\u2029",
      "\u200b",
      "\u200d",
      "\ufeff",
      "\u200e",
      "\u061c",
      "\u{e0041}",
      "\u{e007f}",
    ];
    expect(hidden.filter((text) => note(`x${text}y`).success)).toEqual([]);
    expect(note("caf\u00e9 \u{1f600}").success).toBe(true);
  });

  it("holds a finish note to the same characters, at a message's length", () => {
    const bad = ["\u001b[2J", "\u202e", "\u200b", "\u{e0041}"].map((c) => `a${c}b`);
    expect([bad.filter(finishes), finishes("line\n\tline"), finishes("x".repeat(20_001))]).toEqual([
      [],
      true,
      false,
    ]);
  });

  it("is trimmed, and refused when nothing is left", () => {
    expect([note("  done  ").data?.text, note(" \n\t ").success]).toEqual(["done", false]);
  });
});

describe("quoteNote", () => {
  it("marks every line, a blank one too, so none starts as text of its own", () => {
    expect(quoteNote("a\n\nb").split("\n")).toEqual(["> a", ">", "> b"]);
  });
});

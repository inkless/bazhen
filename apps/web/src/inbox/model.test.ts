import { describe, expect, it } from "vitest";
import type { Attention, AttentionKind, StateSnapshot } from "@bazhen/protocol";
import { closedRows, openRows, waited } from "./model.ts";

let serial = 0;
const id = <P extends string>(prefix: P) =>
  `${prefix}_0190000000007000800000000000${String(++serial).padStart(4, "0")}` as const;

const agentId = id("agent");

const item = (kind: AttentionKind, openedAt: string, over: Partial<Attention> = {}): Attention => ({
  id: id("attn"),
  agentId,
  state: "open",
  closeReason: null,
  summary: kind,
  kind,
  taskId: null,
  messageId: null,
  openedAt,
  actions: [],
  ...over,
});

const closed = (openedAt: string) =>
  item("failed", openedAt, { state: "closed", closeReason: "dismissed" });

const snapshot = (attention: Attention[]): StateSnapshot => ({
  epoch: "e",
  eventId: 1,
  environments: [],
  agents: [],
  attention,
  messages: [],
  shells: [],
});

describe("inbox rows", () => {
  it("puts what holds an agent up first, then failures, then the rest, newest first within each", () => {
    const rows = openRows(
      snapshot([
        item("escalation", "2026-11-12T10:00:00.000Z"),
        item("failed", "2026-11-12T09:00:00.000Z"),
        item("approval", "2026-11-12T08:00:00.000Z"),
        item("question", "2026-11-12T08:30:00.000Z"),
        item("approval", "2026-11-12T07:00:00.000Z", { state: "closed", closeReason: "answered" }),
      ]),
    );
    expect(rows.map((r) => r.item.kind)).toEqual(["question", "approval", "failed", "escalation"]);
  });

  it("shows only one agent's open items when asked for that agent", () => {
    const mine = item("approval", "2026-11-12T08:00:00.000Z");
    const theirs = item("approval", "2026-11-12T08:00:00.000Z", { agentId: id("agent") });
    expect(openRows(snapshot([mine, theirs]), agentId).map((r) => r.item.id)).toEqual([mine.id]);
  });

  it("lists closed items newest first, up to the limit", () => {
    const rows = closedRows(
      snapshot([closed("2026-11-12T08:00:00.000Z"), closed("2026-11-12T09:00:00.000Z")]),
      1,
    );
    expect(rows.map((r) => r.item.openedAt)).toEqual(["2026-11-12T09:00:00.000Z"]);
  });

  it("says how long an item has waited in the largest unit that fits", () => {
    const at = Date.parse("2026-11-12T00:00:00.000Z");
    const ago = (ms: number) => waited(new Date(at - ms).toISOString(), at);
    expect([ago(10_000), ago(5 * 60_000), ago(3 * 3_600_000), ago(50 * 3_600_000)]).toEqual([
      "now",
      "5 min",
      "3 h",
      "2 d",
    ]);
  });
});

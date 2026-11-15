import { describe, expect, it } from "vitest";
import type { Attention, AttentionKind, Notice, StateSnapshot } from "@bazhen/protocol";
import {
  closedNotices,
  closedRows,
  noticeClosed,
  noticeLabel,
  openNotices,
  openRows,
  pairedFrom,
  waited,
} from "./model.ts";

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
  tasks: [],
  assignments: [],
  notices: [],
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

const device = { id: id("dev"), name: "Phone", origin: "https://my-mac.local:7942", address: null };
const notice = (openedAt: string, over: Partial<Notice> = {}): Notice => ({
  id: id("ntc"),
  kind: "device_paired",
  state: "open",
  closeReason: null,
  summary: "A new device paired",
  openedAt,
  device,
  actions: ["dismiss"],
  closedBy: null,
  closedFrom: null,
  ...over,
});

const endedAs = (over: Partial<Notice>) =>
  noticeClosed(notice("2026-11-12T08:00:00.000Z", { state: "closed", ...over }));

describe("inbox notices", () => {
  it("lists open notices newest first, and leaves closed ones to the closed list", () => {
    const older = notice("2026-11-12T08:00:00.000Z");
    const newer = notice("2026-11-12T09:00:00.000Z");
    const gone = notice("2026-11-12T10:00:00.000Z", { state: "closed", closeReason: "revoked" });
    const state = { ...snapshot([]), notices: [older, gone, newer] };
    expect([openNotices(state).map((n) => n.id), closedNotices(state).map((n) => n.id)]).toEqual([
      [newer.id, older.id],
      [gone.id],
    ]);
  });

  it("calls a pairing a new device, and a kind it doesn't know a plain notice", () => {
    expect([noticeLabel("device_paired"), noticeLabel("certificate_expiring")]).toEqual([
      "New device",
      "Notice",
    ]);
  });

  it("says where a device paired from, with the address only when the daemon saw one", () => {
    expect([pairedFrom(device), pairedFrom({ ...device, address: "192.168.1.30" })]).toEqual([
      "https://my-mac.local:7942",
      "https://my-mac.local:7942 from 192.168.1.30",
    ]);
  });

  it("says how a closed notice ended, naming a device's shell only as where it came from", () => {
    expect([
      endedAs({ closeReason: "revoked", closedBy: "revoke" }),
      endedAs({ closeReason: "dismissed", closedBy: "owner-socket" }),
      endedAs({
        closeReason: "dismissed",
        closedBy: "owner-socket",
        closedFrom: { id: id("dev"), name: "Laptop" },
      }),
      endedAs({ closeReason: "expired", closedBy: "timer" }),
    ]).toEqual([
      "device revoked",
      "dismissed on this machine",
      "dismissed from Laptop's shell",
      "closed",
    ]);
  });
});

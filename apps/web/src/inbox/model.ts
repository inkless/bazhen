import type {
  Attention,
  AttentionKind,
  Notice,
  NoticeDevice,
  StateSnapshot,
} from "@bazhen/protocol";
import { shortId } from "../fleet/model.ts";

export interface InboxRow {
  readonly item: Attention;
  /** The project of the agent it is about, or null for an agent the snapshot doesn't hold. */
  readonly project: string | null;
  readonly agent: string;
}

/** What each kind says in the inbox, and the tone its badge takes. */
export const KINDS: Record<AttentionKind, { label: string; tone: "warn" | "danger" | "plain" }> = {
  approval: { label: "Approval", tone: "warn" },
  question: { label: "Question", tone: "warn" },
  failed: { label: "Failed", tone: "danger" },
  undeliverable: { label: "Not delivered", tone: "danger" },
  escalation: { label: "Escalation", tone: "plain" },
  task_done: { label: "Task done", tone: "plain" },
};

/** Approvals and questions hold an agent up, so they come first; then failures; then the rest. */
const URGENCY: Record<AttentionKind, number> = {
  approval: 0,
  question: 0,
  failed: 1,
  undeliverable: 1,
  escalation: 2,
  task_done: 2,
};

const rowOf = (state: StateSnapshot) => (item: Attention) => ({
  item,
  project: state.agents.find((a) => a.id === item.agentId)?.project ?? null,
  agent: shortId(item.agentId),
});

const newestFirst = (x: Attention, y: Attention) => y.openedAt.localeCompare(x.openedAt);

/** The open items, the most urgent kind first, and the newest first within a kind. */
export function openRows(state: StateSnapshot, agentId?: string): InboxRow[] {
  return state.attention
    .filter((i) => i.state === "open" && (agentId === undefined || i.agentId === agentId))
    .toSorted((x, y) => URGENCY[x.kind] - URGENCY[y.kind] || newestFirst(x, y))
    .map(rowOf(state));
}

/** The latest closed items, newest first, with how each ended. */
export function closedRows(state: StateSnapshot, limit = 20): InboxRow[] {
  return state.attention
    .filter((i) => i.state === "closed")
    .toSorted(newestFirst)
    .slice(0, limit)
    .map(rowOf(state));
}

/** How long an item has waited, at a glance: "now", "4 min", "3 h", "2 d". */
export function waited(openedAt: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(openedAt)) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

/** Why a closed item ended, as the inbox says it. */
export const CLOSED: Record<NonNullable<Attention["closeReason"]>, string> = {
  answered: "answered here",
  answered_in_tui: "answered in the terminal",
  timed_out: "left to the terminal",
  superseded: "no longer applies",
  agent_closed: "agent closed",
  stale: "the request is gone",
  replied: "replied",
  dismissed: "dismissed",
  resent: "sent again",
};

/** What the inbox calls each notice kind it knows; a later kind shows as a plain notice. */
const NOTICE_KINDS: ReadonlyMap<string, string> = new Map([["device_paired", "New device"]]);

export const noticeLabel = (kind: string) => NOTICE_KINDS.get(kind) ?? "Notice";

/**
 * How a closed notice ended, as the inbox says it. The device a dismissal came from is the claim
 * of the shell it ran in, so it is said as a lead: from that device's shell, not by the device.
 */
export function noticeClosed(notice: Notice): string {
  if (notice.closeReason === "revoked") return "device revoked";
  if (notice.closeReason !== "dismissed") return "closed";
  return notice.closedFrom === null
    ? "dismissed on this machine"
    : `dismissed from ${notice.closedFrom.name}'s shell`;
}

const newestNoticeFirst = (x: Notice, y: Notice) => y.openedAt.localeCompare(x.openedAt);

/** The open notices, newest first. */
export const openNotices = (state: StateSnapshot): Notice[] =>
  state.notices.filter((n) => n.state === "open").toSorted(newestNoticeFirst);

/** The latest closed notices, newest first. */
export const closedNotices = (state: StateSnapshot, limit = 20): Notice[] =>
  state.notices
    .filter((n) => n.state === "closed")
    .toSorted(newestNoticeFirst)
    .slice(0, limit);

/** Where a device paired from: its origin, and the address it connected from when known. */
export const pairedFrom = (device: NoticeDevice): string =>
  device.address === null ? device.origin : `${device.origin} from ${device.address}`;

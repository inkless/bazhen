import { useEffect, useRef, useState, type RefObject, type SubmitEvent } from "react";
import { SendMessageRequest, type ApprovalDecision, type StateSnapshot } from "@bazhen/protocol";
import { answer, dismiss, reply, resend } from "../api.ts";
import { Button } from "../ui/Button.tsx";
import { CLOSED, KINDS, closedRows, openRows, waited, type InboxRow } from "./model.ts";
import {
  disableNotifications,
  enableNotifications,
  notificationsOn,
  notifyAccess,
  type NotifyAccess,
} from "./notify.ts";

/** A reply goes as a message, so it is held to a message's length. */
const REPLY_MAX = SendMessageRequest.shape.body.maxLength ?? undefined;

interface Acting {
  readonly onOpen: (agentId: string) => void;
  readonly failed: (e: unknown) => void;
}

/** The time, moved on every half minute, which is as fine as "how long it waited" reads. */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * One open item, with exactly the actions the daemon offers for it. One request at a time: a
 * second tap, even in the same tick, sends nothing while the first is in flight.
 */
function ItemRow({
  row,
  onOpen,
  failed,
  showAgent,
  acted,
  rowRef,
}: Acting & {
  row: InboxRow;
  showAgent: boolean;
  acted: () => void;
  rowRef: (el: HTMLLIElement | null) => void;
}) {
  const { item } = row;
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const kind = KINDS[item.kind];
  const now = useNow();
  const act = (request: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const settle = () => {
      inFlight.current = false;
      setBusy(false);
    };
    request().then(
      () => {
        settle();
        setReplying(false);
        acted();
      },
      (e: unknown) => {
        settle();
        failed(e);
      },
    );
  };
  const decide = (decision: ApprovalDecision) => act(() => answer(item.id, decision));
  const send = (e: SubmitEvent) => {
    e.preventDefault();
    act(() => reply(item.id, text));
  };
  const offers = (a: (typeof item.actions)[number]) => item.actions.includes(a);

  return (
    <li
      ref={rowRef}
      tabIndex={-1}
      className="inbox-item"
      aria-label={`${kind.label}: ${item.summary}`}
    >
      <p className="inbox-line">
        <span className={`badge badge-${kind.tone}`}>{kind.label}</span>
        {showAgent && (
          <Button variant="link" onPress={() => onOpen(item.agentId)}>
            {row.project ?? "An agent"} <span className="id">{row.agent}</span>
          </Button>
        )}
        <span className="summary">{item.summary}</span>
        <span className="waited">{waited(item.openedAt, now)}</span>
      </p>
      <p className="inbox-actions">
        {offers("allow") && (
          <Button variant="primary" isDisabled={busy} onPress={() => decide("allow")}>
            Allow
          </Button>
        )}
        {offers("deny") && (
          <Button isDisabled={busy} onPress={() => decide("deny")}>
            Deny
          </Button>
        )}
        {offers("reply") && !replying && (
          <Button isDisabled={busy} onPress={() => setReplying(true)}>
            {item.kind === "undeliverable" ? "Reply with new text" : "Reply"}
          </Button>
        )}
        {offers("resend") && (
          <Button isDisabled={busy} onPress={() => act(() => resend(item.id))}>
            Send the message again
          </Button>
        )}
        {offers("dismiss") && (
          <Button variant="quiet" isDisabled={busy} onPress={() => act(() => dismiss(item.id))}>
            Dismiss
          </Button>
        )}
        {item.kind === "question" && !offers("reply") && (
          <>
            <span>Answer in the terminal.</span>
            <Button variant="link" onPress={() => onOpen(item.agentId)}>
              Open terminal
            </Button>
          </>
        )}
      </p>
      {replying && (
        <form className="inbox-reply" onSubmit={send}>
          <label>
            Reply{" "}
            <textarea
              value={text}
              maxLength={REPLY_MAX}
              onChange={(e) => setText(e.target.value)}
              rows={2}
            />
          </label>
          <Button type="submit" variant="primary" isDisabled={busy || text.trim() === ""}>
            Send reply
          </Button>
          <Button variant="quiet" isDisabled={busy} onPress={() => setReplying(false)}>
            Cancel
          </Button>
        </form>
      )}
    </li>
  );
}

/**
 * Open items as a list. When one the human acted on leaves it, focus moves to the item that took
 * its place, or to `fallback` once the list is empty, so a keyboard user isn't dropped to the top.
 */
function ItemList({
  rows,
  label,
  className,
  showAgent,
  fallback,
  ...acting
}: Acting & {
  rows: readonly InboxRow[];
  label: string;
  className: string;
  showAgent: boolean;
  fallback?: RefObject<HTMLElement | null>;
}) {
  const elements = useRef(new Map<string, HTMLLIElement>());
  const leaving = useRef<{ id: string; index: number } | null>(null);
  useEffect(() => {
    const was = leaving.current;
    if (was === null || rows.some((r) => r.item.id === was.id)) return;
    leaving.current = null;
    const next = rows[Math.min(was.index, rows.length - 1)];
    (next === undefined ? fallback?.current : elements.current.get(next.item.id))?.focus();
  }, [rows, fallback]);
  if (rows.length === 0) return null;
  return (
    <ul className={className} aria-label={label}>
      {rows.map((row, index) => (
        <ItemRow
          key={row.item.id}
          row={row}
          showAgent={showAgent}
          acted={() => (leaving.current = { id: row.item.id, index })}
          rowRef={(el) => {
            if (el === null) elements.current.delete(row.item.id);
            else elements.current.set(row.item.id, el);
          }}
          {...acting}
        />
      ))}
    </ul>
  );
}

/** One agent's open items, shown above its terminal so an answer sits beside what asked it. */
export function AgentAttention({
  state,
  agentId,
  ...acting
}: Acting & { state: StateSnapshot; agentId: string }) {
  return (
    <ItemList
      rows={openRows(state, agentId)}
      label="needs you"
      className="inbox-list agent-attention"
      showAgent={false}
      {...acting}
    />
  );
}

/** What the notifications control says, for each thing the browser allows. */
function NotificationsControl({ failed }: { failed: (e: unknown) => void }) {
  const [access, setAccess] = useState<NotifyAccess>(() => notifyAccess());
  const [on, setOn] = useState(() => notificationsOn());
  if (access === "insecure") return <span className="note">Notifications need https.</span>;
  if (access === "unsupported") return null;
  if (access === "denied") {
    return <span className="note">Notifications are blocked in this browser's site settings.</span>;
  }
  const toggle = () => {
    if (on) {
      disableNotifications();
      setOn(false);
      return;
    }
    enableNotifications().then((now) => {
      setAccess(now);
      setOn(now === "granted");
    }, failed);
  };
  return (
    <Button variant="quiet" onPress={toggle}>
      {on ? "Turn notifications off" : "Notify me in this browser"}
    </Button>
  );
}

/** Every open item across the fleet, the most urgent first, and the latest closed on request. */
export function Inbox({ state, ...acting }: Acting & { state: StateSnapshot }) {
  const [showClosed, setShowClosed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const rows = openRows(state);
  return (
    <section className="inbox" aria-label="inbox">
      <header className="inbox-head">
        <h2 ref={heading} tabIndex={-1}>
          Inbox
        </h2>
        <span className="spacer" />
        <NotificationsControl failed={acting.failed} />
      </header>
      {rows.length === 0 && <p className="empty">Nothing needs you.</p>}
      <ItemList
        rows={rows}
        label="open items"
        className="inbox-list"
        showAgent
        fallback={heading}
        {...acting}
      />
      <Button variant="link" onPress={() => setShowClosed(!showClosed)}>
        {showClosed ? "Hide closed" : "Show recently closed"}
      </Button>
      {showClosed && (
        <ul className="inbox-list closed" aria-label="closed items">
          {closedRows(state).map(({ item, project, agent }) => (
            <li key={item.id}>
              <span className="badge badge-plain">{KINDS[item.kind].label}</span>{" "}
              {project ?? "An agent"} <span className="id">{agent}</span> {item.summary}
              {item.closeReason !== null && (
                <span className="waited"> — {CLOSED[item.closeReason]}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

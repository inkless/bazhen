import type { StateSnapshot } from "@bazhen/protocol";
import { observedRows } from "./model.ts";

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dated = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The time a message was sent, with its date unless that is today. */
function sentAt(iso: string): string {
  const at = new Date(iso);
  return (at.toDateString() === new Date().toDateString() ? clock : dated).format(at);
}

/**
 * The messages an agent sent or was sent through its harness's own channel, which Bazhen saw
 * sent and can't follow to delivery (foundation-design §5.6).
 */
export function Messages({ state, agentId }: { state: StateSnapshot; agentId: string }) {
  const rows = observedRows(state, agentId);
  if (rows.length === 0) return null;
  return (
    <section className="observed" aria-label="Messages sent with SendMessage">
      <h3>Messages</h3>
      <ul>
        {rows.map((r) => (
          <li key={r.id}>
            <span>{r.with}</span> <span>{r.summary}</span>{" "}
            <time dateTime={r.at}>{sentAt(r.at)}</time>{" "}
            <span className="note">
              {r.accepted ? "SendMessage · delivery not tracked" : "SendMessage · not sent"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

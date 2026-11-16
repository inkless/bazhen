import { newId } from "@bazhen/core";
import type { SentMessage } from "@bazhen/harness-claude-code";
import { graphemes } from "../commands.ts";
import type { Store } from "../store/store.ts";
import { MAIL_LIMIT } from "../tasks/mail.ts";

/** The most of a message a client is shown; the rest stays in the event log. */
const SUMMARY_CHARS = 120;

/**
 * Records a message an agent sent another through its harness's own channel (foundation-design
 * §5.6), when it names exactly one other agent's session. The session answers to the name it
 * was started with, so that is what is matched, and only among agents of the sender's harness,
 * the only ones its channel reaches. Anything else went outside Bazhen, or is ambiguous, and is
 * not recorded. Bazhen can't follow it to delivery, so it queues nothing and wakes nobody.
 */
export function observeSend(store: Store, from: string, toolUseId: string, sent: SentMessage) {
  const sender = store.agent(from);
  if (sender === undefined) return;
  const to = store
    .agentsStartedAs(sent.to)
    .filter((a) => a.harness === sender.harness && a.id !== from);
  const [recipient] = to;
  if (recipient === undefined || to.length > 1) return;
  store.transaction(() => {
    if (store.observedSend(from, toolUseId)) return;
    store.append({
      type: "message.observed",
      entityId: newId("msg"),
      actor: from,
      payload: {
        from,
        to: recipient.id,
        summary: summaryOf(sent),
        text: cut(sent.text, MAIL_LIMIT),
        accepted: sent.accepted,
        toolUseId,
      },
    });
  });
}

function summaryOf({ summary, text }: SentMessage): string {
  const line = (summary ?? text).trim().split("\n", 1)[0] ?? "";
  return cut(line, SUMMARY_CHARS);
}

const cut = (text: string, max: number) =>
  text.length <= max ? text : graphemes(text).slice(0, max).join("");

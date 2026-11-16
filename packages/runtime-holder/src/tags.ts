import { isId, type TerminalTags } from "@bazhen/core";
import type { HolderTags } from "@bazhen/protocol";

/** A terminal's tags as a holder keeps them: flat names, each written only when it has a value. */
export function encodeTags(tags: TerminalTags): HolderTags {
  if (tags.kind === "agent") {
    return {
      kind: "agent",
      agentId: tags.agentId,
      ...(tags.harnessSession ? { harnessSession: tags.harnessSession } : {}),
    };
  }
  return { kind: "shell", ...(tags.linkedAgentId ? { linkedAgentId: tags.linkedAgentId } : {}) };
}

/** The tags `encodeTags` wrote, or null for a holder whose tags Bazhen didn't write. */
export function decodeTags(tags: HolderTags): TerminalTags | null {
  const agentId = tags["agentId"] ?? "";
  if (tags["kind"] === "agent") {
    if (!isId("agent", agentId)) return null;
    const session = tags["harnessSession"];
    return session
      ? { kind: "agent", agentId, harnessSession: session }
      : { kind: "agent", agentId };
  }
  if (tags["kind"] !== "shell") return null;
  const linked = tags["linkedAgentId"] ?? "";
  return isId("agent", linked) ? { kind: "shell", linkedAgentId: linked } : { kind: "shell" };
}

/** The same tags without a shell's agent link, as `unlink` leaves them. */
export const unlinked = (tags: HolderTags): HolderTags =>
  Object.fromEntries(Object.entries(tags).filter(([name]) => name !== "linkedAgentId"));

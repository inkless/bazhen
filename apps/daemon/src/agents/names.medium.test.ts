import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { isId, LaunchFailed, newId } from "@bazhen/core";
import { AgentName, ID_PREFIXES } from "@bazhen/protocol";
import { IdempotencyConflict, type Store } from "../store/store.ts";
import { fakeEnvironment, testView, unlimited, withAgent } from "../testing/fixtures.ts";
import { launchAgent } from "./launch.ts";
import { AgentEnded, NameTaken, renameAgent } from "./names.ts";
import { AgentQueue } from "./queue.ts";

/** A second agent named `name`; with `launch`, as its environment starts it, or fails to. */
async function another(store: Store, name: string, launch?: Parameters<typeof fakeEnvironment>[1]) {
  const deps = {
    store,
    environment: fakeEnvironment(store, launch),
    size: { cols: 80, rows: 24 },
    home: tmpdir(),
    queue: new AgentQueue(),
    budget: unlimited,
  };
  const launched = await launchAgent(deps, {
    idempotencyKey: `launch-${name}`,
    harness: "claude-code",
    cwd: "~",
    name,
  }).catch((err: unknown) => err);
  const agentId =
    launched instanceof LaunchFailed ? launched.agentId : Reflect.get(Object(launched), "agentId");
  if (typeof agentId !== "string" || !isId("agent", agentId)) throw new Error("launched no agent");
  return agentId;
}

const nameOf = (store: Store, agentId: string) =>
  store.snapshot(testView).agents.find((a) => a.id === agentId)?.name;

describe("agent names and ids", () => {
  it("refuse as a name an id of every kind the daemon mints", () => {
    const ids = ID_PREFIXES.map((prefix) => newId(prefix));
    expect(ids.filter((id) => AgentName.safeParse(id).success)).toEqual([]);
  });
});

describe("renameAgent", () => {
  it("renames an agent for the human, recording the name it had", async () => {
    const { store, agentId } = await withAgent();
    const before = nameOf(store, agentId);
    renameAgent(store, null, agentId, { idempotencyKey: "r", name: "reviewer" });
    const renamed = store.events(0).filter((e) => e.type === "agent.renamed");
    expect([nameOf(store, agentId), renamed.map((e) => e.payload)]).toEqual([
      "reviewer",
      [{ name: "reviewer", previous: before }],
    ]);
  });

  it("lets an agent rename itself, and no other agent", async () => {
    const { store, agentId } = await withAgent();
    const peer = await another(store, "peer");
    renameAgent(store, agentId, agentId, { idempotencyKey: "self", name: "me" });
    const other = () => renameAgent(store, peer, agentId, { idempotencyKey: "o", name: "you" });
    expect(other).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(nameOf(store, agentId)).toBe("me");
  });

  it("refuses a name another live agent holds, in any case", async () => {
    const { store, agentId } = await withAgent();
    await another(store, "lead");
    const taken = () => renameAgent(store, null, agentId, { idempotencyKey: "r", name: "LEAD" });
    expect(taken).toThrow(NameTaken);
  });

  it("changes only the case of its own name", async () => {
    const { store, agentId } = await withAgent();
    renameAgent(store, null, agentId, { idempotencyKey: "a", name: "lead" });
    renameAgent(store, null, agentId, { idempotencyKey: "b", name: "Lead" });
    expect(nameOf(store, agentId)).toBe("Lead");
  });

  it("records nothing for the name it already has", async () => {
    const { store, agentId } = await withAgent();
    renameAgent(store, null, agentId, { idempotencyKey: "a", name: "lead" });
    const again = renameAgent(store, null, agentId, { idempotencyKey: "b", name: "lead" });
    expect(again.eventIds).toEqual([]);
  });

  it("answers a repeat with the first answer, and the key reused for another name as a conflict", async () => {
    const { store, agentId } = await withAgent();
    const first = renameAgent(store, null, agentId, { idempotencyKey: "r", name: "lead" });
    const repeat = renameAgent(store, null, agentId, { idempotencyKey: "r", name: "lead" });
    const other = () => renameAgent(store, null, agentId, { idempotencyKey: "r", name: "x" });
    expect(repeat).toEqual(first);
    expect(other).toThrow(IdempotencyConflict);
  });

  it("refuses to rename an agent whose launch failed", async () => {
    const { store } = await withAgent();
    const refused = await another(store, "doomed", () => Promise.reject(new Error("no tmux")));
    const rename = () => renameAgent(store, null, refused, { idempotencyKey: "r", name: "x" });
    expect(rename).toThrow(AgentEnded);
  });

  it("refuses to rename an agent that has ended", async () => {
    const { store, agentId } = await withAgent();
    store.append({ type: "agent.closing", entityId: agentId, actor: "user", payload: {} });
    store.append({ type: "agent.closed", entityId: agentId, actor: "system", payload: {} });
    const ended = () => renameAgent(store, null, agentId, { idempotencyKey: "r", name: "x" });
    expect(ended).toThrow(AgentEnded);
  });
});

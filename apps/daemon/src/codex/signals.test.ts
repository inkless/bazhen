import { describe, expect, it } from "vitest";
import type { Activity } from "@bazhen/protocol";
import { AUTO_CONTINUED, codexSignals, INTERRUPTED } from "./signals.ts";

const AT = new Date("2026-11-12T10:00:00.000Z");

/** The listener on thread `thr-1`, bound to `agt-1`, with what it records and resumes. */
function setup(bound: Record<string, string> = { "thr-1": "agt-1" }) {
  const recorded: [string, Activity][] = [];
  const resumed: string[] = [];
  const logged: string[] = [];
  const listener = codexSignals({
    agentOf: (threadId) => bound[threadId],
    record: (agentId, signal) => {
      if (agentId === "agt-closed") throw new Error("no agent agt-closed");
      recorded.push([agentId, signal]);
    },
    resume: async (threadId) => {
      resumed.push(threadId);
    },
    now: () => AT,
    log: (m) => logged.push(m),
  });
  const notify = (method: string, params: unknown) => listener.notification?.(method, params);
  const status = (value: unknown, threadId = "thr-1") =>
    notify("thread/status/changed", { threadId, status: value });
  const values = () => recorded.map(([, s]) => (s.detail ? `${s.value}: ${s.detail}` : s.value));
  return { listener, notify, status, recorded, resumed, logged, values };
}

const active = (...activeFlags: string[]) => ({ type: "active", activeFlags });
const turnStarted = { threadId: "thr-1", turn: { id: "t1", status: "inProgress" } };
const turnEnded = (status: string) => ({ threadId: "thr-1", turn: { id: "t1", status } });
const userInput = {
  threadId: "thr-1",
  item: { type: "userMessage", content: [{ type: "text", text: "go on" }] },
};

describe("Codex activity signals", () => {
  it("maps each thread status to its signal, native and certain", () => {
    const s = setup();
    s.status(active());
    s.status(active("waitingOnApproval"));
    s.status(active("waitingOnUserInput"));
    s.status({ type: "idle" });
    s.status({ type: "systemError" });
    expect(s.values()).toEqual(["working", "needs_approval", "waiting_input", "idle", "failed"]);
    expect(s.recorded[0]).toEqual([
      "agt-1",
      { value: "working", source: "native", confidence: 1, observedAt: AT.toISOString() },
    ]);
  });

  it("reads an unloaded thread as unknown and resumes it", () => {
    const s = setup();
    s.status({ type: "notLoaded" });
    expect([s.values(), s.resumed]).toEqual([["unknown"], ["thr-1"]]);
  });

  it("takes the status a resume answers with, without resuming one still unloaded again", () => {
    const s = setup();
    s.listener.threadResumed?.("thr-1", { thread: { id: "thr-1", status: { type: "idle" } } });
    s.listener.threadResumed?.("thr-1", { thread: { id: "thr-1", status: { type: "notLoaded" } } });
    expect([s.values(), s.resumed]).toEqual([["idle", "unknown"], []]);
  });

  it("ignores threads no agent is bound to, statuses it doesn't know and other methods", () => {
    const s = setup();
    s.status(active(), "thr-other");
    s.status({ type: "somethingNew" });
    s.notify("thread/tokenUsage/updated", { threadId: "thr-1" });
    expect([s.values(), s.resumed]).toEqual([[], []]);
  });

  it("keeps a failed turn failed through the idle status that follows it", () => {
    const s = setup();
    s.notify("turn/started", turnStarted);
    s.notify("turn/completed", turnEnded("failed"));
    s.status({ type: "idle" });
    s.notify("turn/started", turnStarted);
    expect(s.values()).toEqual(["working", "failed", "working"]);
  });

  it("logs a signal it can't record, for an agent that has just closed", () => {
    const s = setup({ "thr-1": "agt-closed" });
    s.status(active());
    expect(s.logged).toEqual([expect.stringContaining("agt-closed")]);
  });

  it("labels a turn cut off by the server's exit and continued by the next server", () => {
    const s = setup();
    s.status(active());
    s.listener.disconnected?.();
    s.listener.threadResumed?.("thr-1", { thread: { status: active() } });
    s.notify("turn/completed", turnEnded("completed"));
    expect(s.values()).toEqual(["working", `working: ${AUTO_CONTINUED}`, "idle"]);
  });

  it("labels a thread left interrupted until a turn starts, which was the server's own", () => {
    const s = setup();
    s.status(active("waitingOnApproval"));
    s.listener.disconnected?.();
    s.listener.threadResumed?.("thr-1", { thread: { status: { type: "idle" } } });
    s.notify("turn/started", turnStarted);
    expect(s.values()).toEqual([
      "needs_approval",
      `idle: ${INTERRUPTED}`,
      `working: ${AUTO_CONTINUED}`,
    ]);
  });

  it("takes the label off a turn that carries the human's input", () => {
    const s = setup();
    s.status(active());
    s.listener.disconnected?.();
    s.listener.threadResumed?.("thr-1", { thread: { status: { type: "idle" } } });
    s.notify("turn/started", turnStarted);
    s.notify("item/started", userInput);
    expect(s.values().at(-1)).toBe("working");
  });

  it("labels nothing for a thread that was idle when the connection ended", () => {
    const s = setup();
    s.status({ type: "idle" });
    s.listener.disconnected?.();
    s.listener.threadResumed?.("thr-1", { thread: { status: { type: "idle" } } });
    s.notify("turn/started", turnStarted);
    expect(s.values()).toEqual(["idle", "idle", "working"]);
  });
});

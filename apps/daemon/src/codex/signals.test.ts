import { describe, expect, it } from "vitest";
import type { Activity } from "@bazhen/protocol";
import { AUTO_CONTINUED, codexSignals, INTERRUPTED } from "./signals.ts";

const AT = new Date("2026-11-12T10:00:00.000Z");

const compaction = (threadId: string) => ({
  threadId,
  item: { type: "contextCompaction", id: "i" },
});

/** The listener on thread `thr-1`, bound to `agt-1`, with what it records and resumes. */
function setup(bound: Record<string, string> = { "thr-1": "agt-1" }, failingResumes = 0) {
  let failing = failingResumes;
  const recorded: [string, Activity][] = [];
  const resumed: string[] = [];
  const logged: string[] = [];
  const listener = codexSignals({
    agentOf: (threadId) => bound[threadId],
    record: (agentId, signal) => {
      if (agentId === "agt-unknown") throw new Error("no agent agt-unknown");
      recorded.push([agentId, signal]);
    },
    resume: async (threadId) => {
      resumed.push(threadId);
      if (failing-- > 0) throw new Error("no reply in 30000 ms");
    },
    retryMs: 5,
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
const failedWith = (codexErrorInfo: unknown) => ({
  threadId: "thr-1",
  turn: { id: "t1", status: "failed", error: { message: "m", codexErrorInfo } },
});
const agentReply = { threadId: "thr-1", item: { type: "agentMessage", id: "i1" } };

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

  it("ignores threads no agent is bound to, and other methods", () => {
    const s = setup();
    s.status(active(), "thr-other");
    s.notify("thread/tokenUsage/updated", { threadId: "thr-1" });
    s.notify("turn/completed", { threadId: "thr-1", turn: { id: "t1" } });
    expect([s.values(), s.resumed]).toEqual([[], []]);
  });

  it("reads a status it doesn't know as unknown, so a stale one isn't left showing", () => {
    const s = setup();
    s.status(active());
    s.status({ type: "somethingNew" });
    expect([s.values(), s.resumed]).toEqual([["working", "unknown"], []]);
  });

  it("resumes an unloaded thread once each time it unloads, however often it says so", () => {
    const s = setup();
    s.status({ type: "notLoaded" });
    s.status({ type: "notLoaded" });
    s.listener.threadResumed?.("thr-1", { thread: { status: { type: "idle" } } });
    s.status({ type: "notLoaded" });
    s.status({ type: "notLoaded" });
    expect([s.values(), s.resumed]).toEqual([
      ["unknown", "unknown", "idle", "unknown", "unknown"],
      ["thr-1", "thr-1"],
    ]);
  });

  it("resumes again, with backoff, after a resume that failed", async () => {
    const s = setup(undefined, 2);
    s.status({ type: "notLoaded" });
    await expect.poll(() => s.resumed).toEqual(["thr-1", "thr-1", "thr-1"]);
    s.listener.threadResumed?.("thr-1", { thread: { status: { type: "idle" } } });
    expect(s.logged).toEqual([
      expect.stringContaining("no reply"),
      expect.stringContaining("no reply"),
    ]);
  });

  it("resumes again after a resume that answers the thread is still not loaded", async () => {
    const s = setup();
    s.status({ type: "notLoaded" });
    s.listener.threadResumed?.("thr-1", { thread: { status: { type: "notLoaded" } } });
    await expect.poll(() => s.resumed).toEqual(["thr-1", "thr-1"]);
  });

  it("leaves resuming to the next connection once this one ends", async () => {
    const s = setup(undefined, 1);
    s.status({ type: "notLoaded" });
    s.listener.disconnected?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(s.resumed).toEqual(["thr-1"]);
  });

  it("records a compaction of a bound thread for its agent, and none of a thread no agent is on", () => {
    const compacted: string[] = [];
    const bound = new Map([["thr-1", "agt-1"]]);
    const listener = codexSignals({
      agentOf: (threadId) => bound.get(threadId),
      record: () => undefined,
      compacted: (agentId) => compacted.push(agentId),
      resume: async () => undefined,
    });
    listener.notification?.("item/completed", compaction("thr-1"));
    listener.notification?.("item/completed", compaction("thr-2"));
    expect(compacted).toEqual(["agt-1"]);
  });

  it("tells the inbox a turn failed and when the next one starts, for the agent bound to it", () => {
    const turns: string[] = [];
    const listener = codexSignals({
      agentOf: () => "agt-1",
      record: () => undefined,
      resume: async () => undefined,
      turns: {
        started: (agentId) => turns.push(`started ${agentId}`),
        failed: (agentId) => turns.push(`failed ${agentId}`),
      },
    });
    listener.notification?.("turn/completed", turnEnded("failed"));
    listener.notification?.("turn/started", turnStarted);
    expect(turns).toEqual(["failed agt-1", "started agt-1"]);
  });

  it("tells the inbox and the activity which error a turn failed with, and whether it may be the account's limit", () => {
    const failed: [string, string | null][] = [];
    const recorded: [Activity["value"], string | undefined, string | undefined][] = [];
    const listener = codexSignals({
      agentOf: () => "agt-1",
      record: (_, signal, limit) => recorded.push([signal.value, signal.detail, limit]),
      resume: async () => undefined,
      turns: {
        started: () => undefined,
        failed: (agentId, error) => failed.push([agentId, error]),
      },
    });
    listener.notification?.("turn/completed", failedWith("usageLimitExceeded"));
    listener.notification?.("turn/completed", failedWith("serverOverloaded"));
    expect([failed, recorded]).toEqual([
      [
        ["agt-1", "usageLimitExceeded"],
        ["agt-1", "serverOverloaded"],
      ],
      [
        ["failed", "usageLimitExceeded", "quota"],
        ["failed", "serverOverloaded", undefined],
      ],
    ]);
  });

  it("hands on each rate-limit update's windows, which belong to the account and no one thread", () => {
    const updates: unknown[] = [];
    const listener = codexSignals({
      agentOf: () => undefined,
      record: () => undefined,
      resume: async () => undefined,
      limits: (limits) => updates.push(limits),
    });
    listener.notification?.("account/rateLimits/updated", {
      rateLimits: { limitId: "codex", primary: { usedPercent: 100, resetsAt: 1_795_006_800 } },
    });
    expect(updates).toEqual([
      [{ window: "codex.primary", usedPercent: 100, resetsAt: "2026-11-18T13:00:00.000Z" }],
    ]);
  });

  it("logs a rate-limit update the store refuses, and carries on", () => {
    const logged: string[] = [];
    const listener = codexSignals({
      agentOf: () => undefined,
      record: () => undefined,
      resume: async () => undefined,
      limits: () => {
        throw new Error("disk full");
      },
      log: (m) => logged.push(m),
    });
    listener.notification?.("account/rateLimits/updated", {
      rateLimits: { primary: { usedPercent: 1 } },
    });
    expect(logged).toEqual(["codex: could not record rate limits: Error: disk full"]);
  });

  it("keeps a failed turn failed through the idle status that follows it", () => {
    const s = setup();
    s.notify("turn/started", turnStarted);
    s.notify("turn/completed", turnEnded("failed"));
    s.status({ type: "idle" });
    s.notify("turn/started", turnStarted);
    expect(s.values()).toEqual(["working", "failed", "working"]);
  });

  it("forgets a failed turn when the connection ends", () => {
    const s = setup();
    s.notify("turn/completed", turnEnded("failed"));
    s.listener.disconnected?.();
    s.listener.threadResumed?.("thr-1", { thread: { status: { type: "idle" } } });
    expect(s.values()).toEqual(["failed", "idle"]);
  });

  it("logs activity the store refuses, as for an agent it doesn't know, and carries on", () => {
    const s = setup({ "thr-1": "agt-unknown" });
    s.status(active());
    expect(s.logged).toEqual([expect.stringContaining("agt-unknown")]);
  });

  it("labels a turn cut off by the server's exit and continued by the next server", () => {
    const s = setup();
    s.status(active());
    s.listener.disconnected?.();
    s.listener.threadResumed?.("thr-1", { thread: { status: active() } });
    s.notify("turn/completed", turnEnded("completed"));
    expect(s.values()).toEqual(["working", `working: ${AUTO_CONTINUED}`, "idle"]);
  });

  it("labels a thread left interrupted until a turn starts whose first item isn't input", () => {
    const s = setup();
    s.status(active("waitingOnApproval"));
    s.listener.disconnected?.();
    s.listener.threadResumed?.("thr-1", { thread: { status: { type: "idle" } } });
    s.notify("turn/started", turnStarted);
    s.notify("item/started", agentReply);
    s.notify("item/started", agentReply);
    expect(s.values()).toEqual([
      "needs_approval",
      `idle: ${INTERRUPTED}`,
      "working",
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
    s.notify("item/started", agentReply);
    expect(s.values()).toEqual(["working", `idle: ${INTERRUPTED}`, "working"]);
  });

  it("takes the label off a continued turn that ends without saying how", () => {
    const s = setup();
    s.status(active());
    s.listener.disconnected?.();
    s.listener.threadResumed?.("thr-1", { thread: { status: active() } });
    s.notify("turn/completed", { threadId: "thr-1", turn: { id: "t1" } });
    s.status({ type: "idle" });
    expect(s.values()).toEqual(["working", `working: ${AUTO_CONTINUED}`, "idle"]);
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

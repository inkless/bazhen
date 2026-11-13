import { describe, expect, it } from "vitest";
import { AgentQueue } from "./queue.ts";

/** A command that waits for `release`, recording when it starts and ends. */
function gated(log: string[], name: string) {
  const done = Promise.withResolvers<void>();
  return {
    run: async () => {
      log.push(`${name} start`);
      await done.promise;
      log.push(`${name} end`);
    },
    release: () => done.resolve(),
  };
}

describe("AgentQueue", () => {
  it("runs one agent's commands one at a time, in order", async () => {
    const queue = new AgentQueue();
    const log: string[] = [];
    const first = gated(log, "a");
    const ran = [queue.run("agent-1", first.run), queue.run("agent-1", async () => log.push("b"))];
    await Promise.resolve();
    first.release();
    await Promise.all(ran);
    expect(log).toEqual(["a start", "a end", "b"]);
  });

  it("doesn't hold one agent's command behind another agent's", async () => {
    const queue = new AgentQueue();
    const log: string[] = [];
    const held = gated(log, "a");
    const first = queue.run("agent-1", held.run);
    await queue.run("agent-2", async () => log.push("b"));
    held.release();
    await first;
    expect(log).toEqual(["a start", "b", "a end"]);
  });

  it("runs the next command after one that failed, and gives the failure to its caller", async () => {
    const queue = new AgentQueue();
    const failed = queue.run("agent-1", () => Promise.reject(new Error("refused")));
    const next = queue.run("agent-1", async () => "ran");
    await expect(failed).rejects.toThrow("refused");
    expect(await next).toBe("ran");
  });

  it("is busy for an agent from the moment a command is queued until the last one settles", async () => {
    const queue = new AgentQueue();
    const held = gated([], "a");
    const ran = queue.run("agent-1", held.run);
    const during = [queue.busy("agent-1"), queue.busy("agent-2")];
    held.release();
    await ran;
    await Promise.resolve();
    expect([...during, queue.busy("agent-1")]).toEqual([true, false, false]);
  });
});

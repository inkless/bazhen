import { describe, expect, it } from "vitest";
import { newId } from "@bazhen/core";
import { assignedMail, completedMail, finishedMail, peerMail } from "./mail.ts";

const task = {
  id: newId("task"),
  title: "Fix the build",
  brief: "It fails on Node 26.",
  parentTaskId: null,
};

describe("task mail", () => {
  it("says who assigned the task and in what role, naming an agent by its name and id", () => {
    const id = newId("agent");
    expect(assignedMail(task, "lead", ["worker"], { id, name: "BZ-127" })).toContain(
      `as its lead, by BZ-127 (${id}).`,
    );
  });

  it("names a worker that finished its part by its name and id", () => {
    const id = newId("agent");
    expect(completedMail(task, { id, name: "BZ-127" }, null)).toMatch(
      new RegExp(`^BZ-127 \\(${id}\\) finished its part`),
    );
  });

  it("leaves out the note line when whoever finished the task gave none", () => {
    expect(finishedMail(task, "done", null, null)).not.toContain("Note");
  });
});

describe("peer mail", () => {
  const id = newId("agent");
  const from = { id, name: "BZ-127", harness: "codex", cwd: "/work" };

  it("names its sender by name and id, and says to reply to the id, which a rename leaves", () => {
    expect(peerMail(from, "hi").split("\n")[0]).toBe(
      `From BZ-127 (${id}, codex, /work). If it needs an answer: bazhen send ${id} "<answer>"`,
    );
  });
});

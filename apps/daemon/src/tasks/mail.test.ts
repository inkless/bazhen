import { describe, expect, it } from "vitest";
import { newId } from "@bazhen/core";
import { assignedMail, finishedMail } from "./mail.ts";

const task = {
  id: newId("task"),
  title: "Fix the build",
  brief: "It fails on Node 26.",
  parentTaskId: null,
};

describe("task mail", () => {
  it("says who assigned the task and in what role", () => {
    const from = newId("agent");
    expect(assignedMail(task, "lead", from)).toContain(`as its lead, by agent ${from}`);
  });

  it("leaves out the note line when whoever finished the task gave none", () => {
    expect(finishedMail(task, "done", null, null)).not.toContain("Note");
  });
});

import { describe, expect, it } from "vitest";
import { parseRole } from "./roles.ts";

const file = (front: string, body = "Do the work.") => `---\n${front}\n---\n${body}\n`;

const problem = (key: string, text: string) => {
  const parsed = parseRole(key, text, "user");
  return "problem" in parsed ? parsed.problem : null;
};

describe("a role file", () => {
  it("reads the front matter's settings, defaults the rest, and keeps the body as the prompt", () => {
    expect(
      parseRole("tester", file("title: Tester\ngrants: [worker]", "\nTest it.\n"), "user"),
    ).toEqual({
      key: "tester",
      title: "Tester",
      description: "",
      grants: ["worker"],
      singlePerTask: false,
      maxActiveTasks: null,
      prompt: "Test it.",
      source: "user",
    });
  });

  it("refuses a key the front matter doesn't know, so a typo never means the default", () => {
    expect(problem("worker", file("title: W\nmaxActiveTask: 1"))).toMatch(/maxActiveTask/);
  });

  it("refuses a file with no front matter, no title or no prompt", () => {
    expect([
      problem("worker", "Do the work."),
      problem("worker", file("description: d")),
      problem("worker", file("title: W", "  \n")),
    ]).toEqual([
      expect.stringMatching(/front matter/),
      expect.stringMatching(/title/),
      expect.stringMatching(/no prompt/),
    ]);
  });

  it("refuses a file named for no valid role, and a grant of no valid role", () => {
    expect([
      problem("Worker", file("title: W")),
      problem("worker", file("title: W\ngrants: [Lead]")),
    ]).toEqual([expect.stringMatching(/named/), expect.stringMatching(/grants/)]);
  });

  it("names a YAML error by its first line only, leaving the file's text out of the log", () => {
    const text = file("title: [unclosed\nsecret: hunter2");
    expect(problem("worker", text)).not.toMatch(/hunter2/);
  });
});

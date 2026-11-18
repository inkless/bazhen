import { describe, expect, it } from "vitest";
import { LogTail } from "./log-tail.ts";

describe("a log's tail", () => {
  it("keeps the whole log while it is short", () => {
    const tail = new LogTail(10);
    tail.append("one\n");
    tail.append("two\n");
    expect(tail.text()).toBe("one\ntwo\n");
  });

  it("keeps a long log's last chars, and says how many came before them", () => {
    const tail = new LogTail(4);
    for (const chunk of ["abc", "def", "ghi"]) tail.append(chunk);
    expect(tail.text()).toBe("[5 chars before]\nfghi");
  });

  it("holds no more than twice its size however much is written", () => {
    const tail = new LogTail(1000);
    for (let i = 0; i < 100_000; i++) tail.append("a line of the daemon's log\n");
    expect(tail.text().length).toBeLessThan(2000 + 40);
    expect(tail.text()).toMatch(/^\[\d+ chars before\]\n/);
  });
});

import { describe, expect, it } from "vitest";
import { Heartbeat } from "./heartbeat.ts";

const beats = (heart: Heartbeat, count: number) =>
  Array.from({ length: count }, () => heart.beat());

describe("view heartbeat", () => {
  it("calls the socket late after one unanswered ping, and dead after two", () => {
    expect(beats(new Heartbeat(), 3)).toEqual(["ping", "late", "dead"]);
  });

  it("keeps pinging while every ping is answered", () => {
    const heart = new Heartbeat();
    const seen = Array.from({ length: 3 }, () => {
      const beat = heart.beat();
      heart.heard();
      return beat;
    });
    expect(seen).toEqual(["ping", "ping", "ping"]);
  });

  it("is on time again once a late socket answers, and says it had been late", () => {
    const heart = new Heartbeat();
    const seen = beats(heart, 2);
    expect([...seen, heart.heard(), heart.heard(), heart.beat()]).toEqual([
      "ping",
      "late",
      true,
      false,
      "ping",
    ]);
  });

  it("doesn't count the first beat after the page is shown again", () => {
    const heart = new Heartbeat();
    const seen = beats(heart, 2);
    heart.resumed();
    expect([...seen, ...beats(heart, 2)]).toEqual(["ping", "late", "late", "dead"]);
  });
});

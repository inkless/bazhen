import { describe, expect, it } from "vitest";
import { capture, handOff } from "./capture.ts";

const now = new Date("2026-11-12T10:00:00.000Z");
const shell = {
  HOME: "/home/u",
  GH_TOKEN: "t",
  CLAUDECODE: "1",
  TMUX: "/tmp/tmux-1/default,1,0",
  BAZHEN_HOME: "/b",
  BAZHEN_AGENT_ID: "agent_parent",
  BAZHEN_SOCKET: "/tmp/parent.sock",
  SECRET_KEY: "s",
  TERM: "xterm-256color",
};

describe("handOff", () => {
  it("keeps the user's variables and Bazhen's settings, and drops a parent agent's internals", () => {
    const { BAZHEN_CAPTURE: _summary, ...env } = handOff(shell, {}, now);
    expect(env).toEqual({ HOME: "/home/u", GH_TOKEN: "t", SECRET_KEY: "s", BAZHEN_HOME: "/b" });
  });

  it("applies the configured deny and passthrough rules", () => {
    const { BAZHEN_CAPTURE: _summary, ...env } = handOff(
      shell,
      { deny: ["SECRET_*"], passthrough: ["TERM"] },
      now,
    );
    expect(env).toEqual({
      HOME: "/home/u",
      GH_TOKEN: "t",
      TERM: "xterm-256color",
      BAZHEN_HOME: "/b",
    });
  });
});

describe("capture", () => {
  it("counts what bazhen start removed, by rule, with when it captured, and no value", () => {
    const daemon = handOff(shell, {}, now);
    expect(daemon["BAZHEN_CAPTURE"]).not.toContain("agent_parent");
    const later = new Date("2026-11-12T10:00:05.000Z");
    const captured = capture(daemon, {}, later);
    expect(captured.at).toBe(now.toISOString());
    expect(captured.removed).toEqual({ "BAZHEN_*": 3, CLAUDECODE: 1, TMUX: 1, TERM: 1 });
    expect(captured.env).toEqual({ HOME: "/home/u", GH_TOKEN: "t", SECRET_KEY: "s" });
  });

  it("captures on its own, now, when the daemon was started without bazhen start", () => {
    const captured = capture({ HOME: "/home/u", CLAUDECODE: "1" }, {}, now);
    expect(captured).toEqual({
      env: { HOME: "/home/u" },
      removed: { CLAUDECODE: 1 },
      at: now.toISOString(),
    });
  });

  it.each([
    "{not json",
    JSON.stringify({ at: "yesterday", removed: {} }),
    JSON.stringify({ at: now.toISOString(), removed: { "not a rule": 1 } }),
    JSON.stringify({ at: now.toISOString(), removed: {}, extra: true }),
  ])("ignores a hand-off it can't trust: %s", (handoff) => {
    expect(capture({ BAZHEN_CAPTURE: handoff }, {}, now).removed).toEqual({ "BAZHEN_*": 1 });
  });
});

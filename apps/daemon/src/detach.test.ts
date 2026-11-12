import { describe, expect, it } from "vitest";
import { daemonEnv } from "./detach.ts";

describe("daemonEnv", () => {
  const env = {
    HOME: "/home/u",
    GH_TOKEN: "t",
    CLAUDECODE: "1",
    TMUX: "/tmp/tmux-1/default,1,0",
    BAZHEN_HOME: "/b",
    BAZHEN_PORT: "8100",
    BAZHEN_AGENT_ID: "agent_parent",
    BAZHEN_SOCKET: "/tmp/parent.sock",
    SECRET_KEY: "s",
    TERM: "xterm-256color",
  };

  it("keeps the user's variables and Bazhen's settings, and drops a parent agent's internals", () => {
    expect(daemonEnv(env, {})).toEqual({
      HOME: "/home/u",
      GH_TOKEN: "t",
      SECRET_KEY: "s",
      BAZHEN_HOME: "/b",
      BAZHEN_PORT: "8100",
    });
  });

  it("applies the configured deny and passthrough rules", () => {
    expect(daemonEnv(env, { deny: ["SECRET_*"], passthrough: ["TERM"] })).toEqual({
      HOME: "/home/u",
      GH_TOKEN: "t",
      TERM: "xterm-256color",
      BAZHEN_HOME: "/b",
      BAZHEN_PORT: "8100",
    });
  });
});

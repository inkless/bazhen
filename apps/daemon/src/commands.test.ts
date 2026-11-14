import { describe, expect, it } from "vitest";
import {
  HarnessRefused,
  newId,
  ProcessState,
  StaleIncarnation,
  TerminalUnconfirmed,
} from "@bazhen/core";
import {
  DETAIL_MAX,
  EnvironmentUnavailable,
  failureDetail,
  forceable,
  fromEnvironment,
  ServerUnconfirmed,
  TerminalReplaced,
} from "./commands.ts";

const terminalId = newId("term");
const as = (cause: unknown) => {
  try {
    fromEnvironment("shell x", cause);
  } catch (err) {
    return err;
  }
  return undefined;
};

describe("an environment's failure as a command's", () => {
  it("names what the caller can act on, and anything else as the environment out of reach", () => {
    expect([
      as(new StaleIncarnation(terminalId, "gone")),
      as(new TerminalUnconfirmed(terminalId, null)),
      as(new Error("tmux unreachable")),
    ]).toEqual([
      expect.any(TerminalReplaced),
      expect.any(ServerUnconfirmed),
      expect.any(EnvironmentUnavailable),
    ]);
  });

  it("passes a harness's refusal on as it is, since repeating the command won't help", () => {
    const refused = new HarnessRefused("Codex refused thread/resume: no such provider");
    expect(as(refused)).toBe(refused);
  });

  it("says what kept the environment out of reach", () => {
    expect(as(new Error("tmux respawn-pane failed: no server"))).toHaveProperty(
      "message",
      "could not reach the environment running shell x: tmux respawn-pane failed: no server",
    );
  });

  it("lets force record past an unconfirmed server or an unreachable one, never a replaced pane", () => {
    expect([
      forceable(new TerminalUnconfirmed(terminalId, null)),
      forceable(new Error("tmux unreachable")),
      forceable(new StaleIncarnation(terminalId, "pane-replaced")),
      forceable(new ProcessState(terminalId, "running")),
    ]).toEqual([true, true, false, false]);
  });
});

describe("a failure's detail", () => {
  const SECRET = "s3cr3t-Value_42";

  it("keeps a harness's own words whole", () => {
    const words =
      "Codex refused thread/resume: This chat uses model provider “deepseek”, which is no " +
      "longer configured. Restore this provider’s configuration to continue. (-32600)";
    expect([failureDetail(new Error(words)), failureDetail("auth: failed")]).toEqual([
      words,
      "auth: failed",
    ]);
  });

  it("takes out every secret a config line, an environment or a request could echo", () => {
    const echoed = [
      `experimental_bearer_token = "${SECRET}"`,
      `OPENAI_API_KEY=${SECRET}`,
      `{"api_key": "${SECRET}"}`,
      `password='${SECRET}'`,
      `Authorization: Bearer ${SECRET}`,
      `https://user:${SECRET}@example.com/v1`,
      `sk-proj-${SECRET}abcdef`,
      `ghp_${SECRET.replaceAll("-", "")}abcdefghij`,
    ];
    const details = echoed.map((line) => failureDetail(new Error(`bad config: ${line}`)));
    expect(details).toEqual(echoed.map(() => expect.stringContaining("[redacted]")));
    expect(details.join("\n")).not.toContain(SECRET.replaceAll("-", ""));
    expect(details.join("\n")).not.toContain(SECRET);
  });

  it("cuts a long text to its limit between characters, never through one", () => {
    // One character of two code points: a cut by code point could split it.
    const thumb = "👍🏽";
    expect([
      failureDetail(thumb.repeat(DETAIL_MAX + 10)),
      failureDetail(thumb.repeat(DETAIL_MAX)),
    ]).toEqual([`${thumb.repeat(DETAIL_MAX - 1)}…`, thumb.repeat(DETAIL_MAX)]);
  });
});

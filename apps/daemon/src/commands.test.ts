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
  it("keeps a harness's own words, ids and prose whole", () => {
    const kept = [
      "Codex refused thread/resume: This chat uses model provider “deepseek”, which is no " +
        "longer configured. Restore this provider’s configuration to continue. (-32600)",
      "Codex refused thread/resume: no rollout found for thread id " +
        "01a1d8c8-9752-7d53-b6a1-2a4e9df16bdf (-32600)",
      "auth: failed",
      "token: expired",
      "authentication: required",
      "TOML parse error: invalid basic string",
      "requires_openai_auth = false",
    ];
    expect(kept.map((text) => failureDetail(new Error(text)))).toEqual(kept);
  });

  it.each([
    ['experimental_bearer_token = "s3cr3t"', "experimental_bearer_token = [redacted]"],
    ["OPENAI_API_KEY=s3cr3t", "OPENAI_API_KEY=[redacted]"],
    ['{"api_key": "s3cr3t"}', '{"api_key": [redacted]}'],
    ['{\\"api_key\\":\\"s3cr3t\\"}', '{\\"api_key\\":[redacted]}'],
    ["password='s3cr3t'", "password=[redacted]"],
    ['api_key = "s3\\"cr3t" and more', "api_key = [redacted] and more"],
    ['api_key = "s3cr3t and the rest of the line', "api_key = [redacted]"],
    [
      'ModelProviderInfo { experimental_bearer_token: Some("s3cr3t"), name: "x" }',
      'ModelProviderInfo { experimental_bearer_token: Some([redacted]), name: "x" }',
    ],
    ["api_key: s3cr3t", "api_key: [redacted]"],
    ["x-api-key: s3cr3t", "x-api-key: [redacted]"],
    ['token: "s3cr3t"', "token: [redacted]"],
    ["Authorization: Basic czNjcjN0", "Authorization: [redacted]"],
    ["Authorization: Bearer s3cr3t-token", "Authorization: [redacted]"],
    ["sent Bearer s3cr3t-token", "sent Bearer [redacted]"],
    ['http_headers = { "X-Corp" = "s3cr3t" }', "http_headers = {[redacted]}"],
    ["https://user:s3cr3t@example.com/v1", "https://[redacted]@example.com/v1"],
    ["key sk-proj-s3cr3tABCDEFGHIJKLMNOP leaked", "key [redacted] leaked"],
    ["eyJhbGciOiJI.eyJzdWIiOiIx.s3cr3tSIGNATURE in a header", "[redacted] in a header"],
  ])("takes the secret out of %j", (echoed, expected) => {
    expect(failureDetail(new Error(`bad config: ${echoed}`))).toBe(`bad config: ${expected}`);
  });

  it("reads a long text in time linear in its length", () => {
    // A long run of what could start a name, which a backtracking pattern takes cubic time over.
    const started = performance.now();
    const detail = failureDetail("key".repeat(1_200));
    expect([
      performance.now() - started < 1_000,
      [...new Intl.Segmenter().segment(detail)].length,
    ]).toEqual([true, DETAIL_MAX]);
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

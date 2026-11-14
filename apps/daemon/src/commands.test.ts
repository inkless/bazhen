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

/**
 * A key of `prefix`'s shape, `length` characters after it, made here so the source holds no
 * literal a secret scanner would take for a real key.
 */
const fake = (prefix: string, length: number) => prefix + "S3cr3tKeyX".repeat(8).slice(0, length);

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
      "max_tokens: 4096",
      "token: expired after an hour",
      "invalid basic information in the request",
      "bearer authentication is not configured",
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
    [`key ${fake("sk-proj-", 20)} leaked`, "key [redacted] leaked"],
    [`${fake("eyJ", 9)}.${fake("eyJ", 9)}.${fake("", 12)} in a header`, "[redacted] in a header"],
    [`${fake("sk_live_", 16)} and ${fake("rk_test_", 16)}`, "[redacted] and [redacted]"],
    [fake("ghp_", 24), "[redacted]"],
    [fake("github_pat_", 24), "[redacted]"],
    [fake("glpat-", 24), "[redacted]"],
    [fake("hf_", 24), "[redacted]"],
    [fake("xoxb-", 12), "[redacted]"],
    [fake("AKIA", 16).toUpperCase(), "[redacted]"],
    [fake("AIza", 35), "[redacted]"],
    ["redis://:s3cr3t@host", "redis://[redacted]@host"],
    ["token: 0123s3cr3t", "token: [redacted]"],
    ['{\\"token\\": \\"s3cr3t\\"}', '{\\"token\\": [redacted]}'],
    ['{\\"api_key\\": \\"s3cr3t with spaces\\"}', '{\\"api_key\\": [redacted]}'],
    ['API_KEY            = "s3cr3t"', "API_KEY            = [redacted]"],
    ["experimental_bearer_token: Some(s3cr3t)", "experimental_bearer_token: Some([redacted]"],
    [
      'experimental_bearer_token: Some(\n    "s3cr3t",\n)',
      "experimental_bearer_token: Some(\n    [redacted],\n)",
    ],
    [
      'http_headers: Some(\n    {\n        "X-Corp": "s3cr3t",\n    },\n)',
      "http_headers: Some(\n    {[redacted]},\n)",
    ],
    ['env_http_headers = { "X-Corp" = "S3CR3T_VAR" }', "env_http_headers = {[redacted]}"],
    ['http_headers = { "X-Corp" = "s3cr3t', "http_headers = {[redacted]}"],
    ["api_key=xyz-sk-s3cr3tABCDEFGHIJKLMNOP rest", "api_key=[redacted]"],
    ["sent Basic dXNlcjpwYXNzd29yZA== on", "sent Basic [redacted] on"],
    ["proxy-authorization: basic dXNlcjpwYXNzd29yZA==", "proxy-authorization: [redacted]"],
    ["authorization bearer abcdefghijklmnop1234 sent", "authorization bearer [redacted] sent"],
    ["password: correct horse battery staple", "password: [redacted]"],
    ['api_key = """\ns3cr3t\n""" after', "api_key = [redacted] after"],
    ["https://opaques3cr3t123@host/x", "https://[redacted]@host/x"],
    [
      "key -----BEGIN RSA PRIVATE KEY-----\nMIIEs3cr3t\n-----END RSA PRIVATE KEY----- end",
      "key [redacted] end",
    ],
    ["key -----BEGIN PRIVATE KEY-----\nMIIEs3cr3t cut short", "key [redacted]"],
  ])("takes the secret out of %j", (echoed, expected) => {
    expect(failureDetail(new Error(`bad config: ${echoed}`))).toBe(`bad config: ${expected}`);
  });

  it.each([
    // A run of what could start a name, which a backtracking pattern takes cubic time over.
    ["key".repeat(2_600)],
    // A megabyte that patterns searching again from each position take quadratic time over.
    ["eyJ-".repeat(250_000)],
    ["a:".repeat(500_000)],
  ])("reads %# long text in bounded time", (text) => {
    const started = performance.now();
    failureDetail(text);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it.each([
    [
      `token="${"x".repeat(7_950)}" proxy https://user:s3cr3ts3cr3ts3cr3t@host`,
      "token=[redacted] proxy…",
    ],
    [
      // A comma inside the password, before the limit, and the `@` after it.
      `api_key = "${"A".repeat(7_930)}" proxy https://admin:${"z".repeat(20)},${"z".repeat(60)}@db/x`,
      "api_key = [redacted] proxy…",
    ],
  ])("keeps no part of a secret the search's limit would cut in two (%#)", (text, expected) => {
    expect(failureDetail(text)).toBe(expected);
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

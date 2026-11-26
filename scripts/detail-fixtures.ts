// What crates/bazhen-daemon's failure detail is held to: each text as the TypeScript daemon's
// `failureDetail` answers with it, secrets taken out and cut. `make schema` writes them to
// packages/protocol/fixtures/details/.
//
// Beside the cases the daemon's own tests read, each place a JavaScript pattern means something a
// Rust regex says differently has a text that tells them apart: `i` and `\w`, `\b`, `\s` and `.`
// as JavaScript reads them without the `u` flag, a quote matched again by backreference, a name
// rejected by lookahead, and lengths counted in UTF-16 units.

import { failureDetail } from "../apps/daemon/src/commands.ts";

const fake = (prefix: string, length: number) => prefix + "S3cr3tKeyX".repeat(8).slice(0, length);

/** Failures in a harness's own words, ids and prose, none of which is a secret. */
const KEPT = [
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
  "socket gone",
];

/** Secrets as a config line, an environment, a request or a Debug print echoes them. */
const ECHOED = [
  'experimental_bearer_token = "s3cr3t"',
  "OPENAI_API_KEY=s3cr3t",
  '{"api_key": "s3cr3t"}',
  '{\\"api_key\\":\\"s3cr3t\\"}',
  "password='s3cr3t'",
  'api_key = "s3\\"cr3t" and more',
  'api_key = "s3cr3t and the rest of the line',
  'ModelProviderInfo { experimental_bearer_token: Some("s3cr3t"), name: "x" }',
  "api_key: s3cr3t",
  "x-api-key: s3cr3t",
  'token: "s3cr3t"',
  "Authorization: Basic czNjcjN0",
  "Authorization: Bearer s3cr3t-token",
  "sent Bearer s3cr3t-token",
  'http_headers = { "X-Corp" = "s3cr3t" }',
  "https://user:s3cr3t@example.com/v1",
  `key ${fake("sk-proj-", 20)} leaked`,
  `${fake("eyJ", 9)}.${fake("eyJ", 9)}.${fake("", 12)} in a header`,
  `${fake("sk_live_", 16)} and ${fake("rk_test_", 16)}`,
  fake("ghp_", 24),
  fake("github_pat_", 24),
  fake("glpat-", 24),
  fake("hf_", 24),
  fake("xoxb-", 12),
  fake("AKIA", 16).toUpperCase(),
  fake("AIza", 35),
  "redis://:s3cr3t@host",
  "token: 0123s3cr3t",
  '{\\"token\\": \\"s3cr3t\\"}',
  '{\\"api_key\\": \\"s3cr3t with spaces\\"}',
  'API_KEY            = "s3cr3t"',
  "experimental_bearer_token: Some(s3cr3t)",
  'experimental_bearer_token: Some(\n    "s3cr3t",\n)',
  'http_headers: Some(\n    {\n        "X-Corp": "s3cr3t",\n    },\n)',
  'env_http_headers = { "X-Corp" = "S3CR3T_VAR" }',
  'http_headers = { "X-Corp" = "s3cr3t',
  "api_key=xyz-sk-s3cr3tABCDEFGHIJKLMNOP rest",
  "sent Basic dXNlcjpwYXNzd29yZA== on",
  "proxy-authorization: basic dXNlcjpwYXNzd29yZA==",
  "authorization bearer abcdefghijklmnop1234 sent",
  "password: correct horse battery staple",
  'api_key = """\ns3cr3t\n""" after',
  "https://opaques3cr3t123@host/x",
  "key -----BEGIN RSA PRIVATE KEY-----\nMIIEs3cr3t\n-----END RSA PRIVATE KEY----- end",
  "key -----BEGIN PRIVATE KEY-----\nMIIEs3cr3t cut short",
];

/**
 * Texts a pattern ported as Rust would read it gets wrong, each named for the difference: every
 * one answers otherwise when that difference is left in.
 */
const QUIRKS = [
  // `i` folds ASCII alone: the long s (U+017F) is no `s`, and the Kelvin sign (U+212A) no `k`.
  "sent ba\u{17f}ic czNjcjN0QUJDREVG on",
  "sent Basic czNjcjN0QUJDREVG on",
  "\u{212a}ey: s3cr3t",
  // `\w` is ASCII: `é` ends a name and can't fill a key's shape.
  `sk-${"é".repeat(20)}`,
  "api_key_é = s3cr3t",
  // `\b` is between ASCII word characters and anything else.
  `é${fake("sk-proj-", 20)}`,
  `_${fake("sk-proj-", 20)}`,
  // `\s` holds U+FEFF but not U+0085.
  'api_key=\u{feff}"s3cr3t" tail',
  'api_key=\u0085"s3cr3t" tail',
  "Bearer\u{feff}s3cr3tTOKEN1 sent",
  "Bearer\u0085s3cr3tTOKEN1 sent",
  // U+2028 is white space too, and the check that a value is a plain word reads the same `\s`.
  "Bearer\u{2028}ABCDEFGH12 sent",
  "token: expired\u0085x",
  "token: expired\u{feff}x",
  // `.` stops at `\r`, U+2028 and U+2029, not only at `\n`.
  'api_key = "s3\\\rcr3t" tail',
  'api_key = "s3\\\u{2028}cr3t" tail',
  'api_key = "s3\\\u{2029}cr3t" tail',
  'api_key = "s3\\\u0085cr3t" tail',
  // A name's closing quote is the one it opened with.
  "\"api_key' = s3cr3t",
  '\\"api_key" = s3cr3t',
  "\\api_key\\ = s3cr3t",
  "'api_key' = s3cr3t",
  "\\'api_key\\' = s3cr3t",
  // `tokens` is no token; a later `token` in the same name is.
  "max_tokens = 4096",
  "tokens_token = s3cr3t",
  "tokens: 12 used",
  // A TOML `"""` runs to its close within 4096, or to the end of the text.
  `api_key = """${"x".repeat(5_000)} tail`,
  `api_key = """${"x".repeat(4_000)}""" tail`,
  'api_key = """abc\nmore lines',
  // The end of a text is the end of the last line only.
  'api_key =\n"s3cr3t" tail',
  // A name is at most 64 characters, the last 64 before its `=`.
  `api_key${"x".repeat(60)} = s3cr3t`,
  `${"x".repeat(60)}_key = s3cr3t`,
  // Lengths are UTF-16 units: an astral character counts two toward the search's limit, and
  // toward the 512 an unquoted value runs to.
  `token="${"😀".repeat(3_990)}" proxy https://user:s3cr3t@host`,
  `api_key=${"😀".repeat(300)} tail`,
  // A cluster of 20 joined emoji is 59 units and 39 characters: 140 of them pass the limit in
  // units, and not in characters, so the search stops at the last space, or keeps nothing.
  `${"\u{1F9D1}\u{200d}".repeat(19)}\u{1F9D1} `.repeat(140),
  `${"\u{1F9D1}\u{200d}".repeat(19)}\u{1F9D1}`.repeat(140),
  // Clusters are what a person counts, at the limit and past it.
  "👍🏽".repeat(510),
  "👍🏽".repeat(500),
  "\u{1F468}\u{200d}\u{1F469}\u{200d}\u{1F467}".repeat(501),
  "🇯🇵".repeat(501),
  "e\u{301}".repeat(501),
  "x".repeat(500),
  "x".repeat(501),
  "é".repeat(501),
];

/** Texts the search's limit cuts, with a secret on either side of it. */
const LONG = [
  `token="${"x".repeat(7_950)}" proxy https://user:s3cr3ts3cr3ts3cr3t@host`,
  `api_key = "${"A".repeat(7_930)}" proxy https://admin:${"z".repeat(20)},${"z".repeat(60)}@db/x`,
];

export function detailFixture(): Record<string, string> {
  const texts = [...KEPT, ...ECHOED.map((e) => `bad config: ${e}`), ...QUIRKS, ...LONG];
  const cases = texts.map((text) => ({ text, detail: failureDetail(new Error(text)) }));
  return { "cases.json": `${JSON.stringify(cases, null, 2)}\n` };
}

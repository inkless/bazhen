// What the TypeScript daemon makes of what Codex's app-server sends, recorded for the Rust adapter,
// which reads the same messages: every reader run on every message, so a reader that takes another
// method's message is caught too; what thread/start, thread/resume and thread/list answer; the
// titles a TUI sets; what the daemon sends back and starts; and the launch and resume requests and
// argv over a channel that answers as a server does and records them. Each message and answer
// follows the JSON Schema that `codex app-server generate-json-schema` printed for the CLI
// tests/api pins, committed in packages/protocol/fixtures/codex-schema/, unless it is marked `bad`:
// off that schema on purpose, with a field the readers take absent, null or of the wrong type.
// codex-fixtures.medium.test.ts holds each case to the schema.
// `moon run :schema` writes it to packages/protocol/fixtures/codex/. This script is a parity
// capture: it goes with the TypeScript daemon, and the fixtures it wrote stay.

import type { AgentLaunchRequest, HarnessChannelPort, LaunchOptions } from "@bazhen/core";
import {
  CodexHarness,
  DAEMON_START_ARGS,
  approvalResult,
  compactConfig,
  matching,
  messageText,
  queueArgs,
  questionResult,
  readApproval,
  readCompaction,
  readItemStarted,
  readQuestion,
  readRateLimits,
  readResolved,
  readThreadList,
  readThreadStarted,
  readThreadStatus,
  readTurn,
  readUserMessage,
  resultActivity,
  resultNotLoaded,
  threadConfig,
  titlePrefix,
  tomlString,
} from "../packages/harness-codex/src/index.ts";
import { appServerAddress, codexHomeOf, nextDelay } from "../apps/daemon/src/codex/channel.ts";
import { cliVersion } from "../apps/daemon/src/codex/version.ts";

const T1 = "019a8f3c-5b7e-7d21-9f4a-0c1e2d3b4a51";
const T2 = "019a8f3c-5b7e-7d21-9f4a-0c1e2d3b4a52";
const T3 = "019a8f40-0000-7000-8000-000000000003";
const MSG = "msg_0190000000007000800000000000001";
const LABEL = `Message for you from Bazhen (${MSG}):`;

export interface Message {
  readonly name: string;
  readonly method: string;
  readonly params?: unknown;
  /** Off Codex's schema on purpose: a field missing, null where it can't be, or of another type. */
  readonly bad?: true;
}

const status = (s: unknown) => ({ threadId: T1, status: s });
const turn = (t: unknown) => ({ threadId: T1, turn: t });
const failedTurn = (error: unknown) => turn({ id: "turn-1", items: [], status: "failed", error });
const limits = (rateLimits: unknown) => ({ rateLimits });
const window = (usedPercent: unknown, resetsAt?: unknown) => ({
  usedPercent,
  windowDurationMins: 300,
  ...(resetsAt === undefined ? {} : { resetsAt }),
});
const item = (method: string, it: unknown, threadId: unknown = T1) => ({
  name: "",
  method,
  params: {
    threadId,
    turnId: "turn-1",
    item: it,
    ...(method === "item/started" ? { startedAtMs: 1_763_000_000_000 } : {}),
    ...(method === "item/completed" ? { completedAtMs: 1_763_000_000_000 } : {}),
  },
});
const userMessage = (...texts: (string | undefined)[]) => ({
  type: "userMessage",
  id: "item-1",
  content: texts.map((text) =>
    text === undefined
      ? { type: "image", url: "https://example.com/a.png" }
      : { type: "text", text },
  ),
});
const thread = (fields: Record<string, unknown> = {}) => ({
  id: T1,
  ephemeral: false,
  cliVersion: "0.167.1",
  createdAt: 1_763_000_000,
  updatedAt: 1_763_000_000,
  cwd: "/work",
  modelProvider: "openai",
  preview: "",
  projectId: null,
  sessionId: "019a8f3c-0000-7000-8000-00000000aaaa",
  source: "appServer",
  status: { type: "idle" },
  turns: [],
  ...fields,
});

/** What thread/start and thread/resume answer, around the thread. */
const response = (t: unknown) => ({
  thread: t,
  model: "gpt-5.5",
  modelProvider: "openai",
  cwd: "/work",
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: { type: "dangerFullAccess" },
});
const command = (fields: Record<string, unknown>) => ({
  threadId: T1,
  turnId: "turn-1",
  itemId: "call-1",
  startedAtMs: 1_763_000_000_000,
  ...fields,
});
const question = (fields: Record<string, unknown>) => ({
  id: "q1",
  header: "Name",
  question: "What should it be called?",
  ...fields,
});
const userInput = (questions: unknown) => ({
  name: "",
  method: "item/tool/requestUserInput",
  params: { threadId: T1, turnId: "turn-1", itemId: "call-2", isBlocking: true, questions },
});

/** An elicitation's form that asks for nothing. */
const FORM = { type: "object", properties: {} };

const named = (name: string, m: Omit<Message, "name">): Message => ({ ...m, name });
/** A message off Codex's schema on purpose. */
const offSchema = (name: string, m: Omit<Message, "name">): Message => ({ ...m, name, bad: true });

/** Notifications and server requests, by what each tells. */
export const MESSAGES: readonly Message[] = [
  named("idle", { method: "thread/status/changed", params: status({ type: "idle" }) }),
  offSchema("active", { method: "thread/status/changed", params: status({ type: "active" }) }),
  named("active with no flags", {
    method: "thread/status/changed",
    params: status({ type: "active", activeFlags: [] }),
  }),
  named("active waiting on approval", {
    method: "thread/status/changed",
    params: status({ type: "active", activeFlags: ["waitingOnApproval"] }),
  }),
  named("active waiting on input", {
    method: "thread/status/changed",
    params: status({ type: "active", activeFlags: ["waitingOnUserInput"] }),
  }),
  named("active waiting on both", {
    method: "thread/status/changed",
    params: status({ type: "active", activeFlags: ["waitingOnUserInput", "waitingOnApproval"] }),
  }),
  offSchema("active with an unknown flag", {
    method: "thread/status/changed",
    params: status({ type: "active", activeFlags: ["thinking"] }),
  }),
  offSchema("active with flags not a list", {
    method: "thread/status/changed",
    params: status({ type: "active", activeFlags: "waitingOnApproval" }),
  }),
  offSchema("active with a flag not a string", {
    method: "thread/status/changed",
    params: status({ type: "active", activeFlags: [1] }),
  }),
  named("system error", {
    method: "thread/status/changed",
    params: status({ type: "systemError" }),
  }),
  named("not loaded", { method: "thread/status/changed", params: status({ type: "notLoaded" }) }),
  offSchema("an unknown status", {
    method: "thread/status/changed",
    params: status({ type: "paused" }),
  }),
  offSchema("a status with no type", { method: "thread/status/changed", params: status({}) }),
  offSchema("a status not an object", { method: "thread/status/changed", params: status("idle") }),
  offSchema("a status with no thread", {
    method: "thread/status/changed",
    params: { status: { type: "idle" } },
  }),
  offSchema("a status for a numbered thread", {
    method: "thread/status/changed",
    params: { threadId: 7, status: { type: "idle" } },
  }),
  offSchema("a status with no status", {
    method: "thread/status/changed",
    params: { threadId: T1 },
  }),
  named("a status with more fields", {
    method: "thread/status/changed",
    params: { ...status({ type: "idle", since: 3 }), extra: true },
  }),
  offSchema("a status with no params", { method: "thread/status/changed" }),

  named("a turn started", {
    method: "turn/started",
    params: turn({ id: "turn-1", items: [], status: "inProgress" }),
  }),
  offSchema("a turn started with no turn", { method: "turn/started", params: { threadId: T1 } }),
  offSchema("a turn started with no thread", { method: "turn/started", params: { turn: {} } }),
  named("a turn completed", {
    method: "turn/completed",
    params: turn({ id: "turn-1", items: [], status: "completed", error: null }),
  }),
  named("a turn interrupted", {
    method: "turn/completed",
    params: turn({ id: "turn-1", items: [], status: "interrupted" }),
  }),
  offSchema("a turn ended with no status", {
    method: "turn/completed",
    params: turn({ id: "turn-1", items: [] }),
  }),
  offSchema("a turn ended with no turn", { method: "turn/completed", params: { threadId: T1 } }),
  named("a turn ended in progress", {
    method: "turn/completed",
    params: turn({ id: "turn-1", items: [], status: "inProgress" }),
  }),
  offSchema("a turn ended with a status not a string", {
    method: "turn/completed",
    params: turn({ id: "turn-1", items: [], status: 3 }),
  }),
  named("a turn failed on the usage limit", {
    method: "turn/completed",
    params: failedTurn({ message: "limit", codexErrorInfo: "usageLimitExceeded" }),
  }),
  named("a turn failed on the rate limit", {
    method: "turn/completed",
    params: failedTurn({ message: "slow down", codexErrorInfo: "rateLimitExceeded" }),
  }),
  named("a turn failed on an overloaded server", {
    method: "turn/completed",
    params: failedTurn({ message: "busy", codexErrorInfo: "serverOverloaded" }),
  }),
  named("a turn failed on a connection", {
    method: "turn/completed",
    params: failedTurn({
      message: "no",
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } },
    }),
  }),
  named("a turn failed on an error of two names", {
    method: "turn/completed",
    params: failedTurn({ message: "?", codexErrorInfo: { a: {}, b: {} } }),
  }),
  named("a turn failed on an error of no name", {
    method: "turn/completed",
    params: failedTurn({ message: "?", codexErrorInfo: {} }),
  }),
  named("a turn failed on an empty error name", {
    method: "turn/completed",
    params: failedTurn({ message: "?", codexErrorInfo: "" }),
  }),
  named("a turn failed on a long error name", {
    method: "turn/completed",
    params: failedTurn({ message: "?", codexErrorInfo: `e${"x".repeat(250)}` }),
  }),
  named("a turn failed on a long astral error name", {
    method: "turn/completed",
    params: failedTurn({ message: "?", codexErrorInfo: `e${"😀".repeat(150)}` }),
  }),
  offSchema("a turn failed on a numbered error", {
    method: "turn/completed",
    params: failedTurn({ message: "?", codexErrorInfo: 7 }),
  }),
  named("a turn failed with a null error name", {
    method: "turn/completed",
    params: failedTurn({ message: "?", codexErrorInfo: null }),
  }),
  named("a turn failed with no error name", {
    method: "turn/completed",
    params: failedTurn({ message: "?" }),
  }),
  named("a turn failed with a null error", { method: "turn/completed", params: failedTurn(null) }),
  offSchema("a turn failed with an error not an object", {
    method: "turn/completed",
    params: failedTurn("boom"),
  }),

  named("rate limits in both windows", {
    method: "account/rateLimits/updated",
    params: limits({
      limitId: "codex",
      limitName: null,
      primary: window(12, 1_763_003_600),
      secondary: window(40, 1_763_600_000),
      planType: "pro",
    }),
  }),
  named("rate limits with no limit id", {
    method: "account/rateLimits/updated",
    params: limits({ primary: window(5, 1_763_003_600) }),
  }),
  named("rate limits with a null limit id", {
    method: "account/rateLimits/updated",
    params: limits({ limitId: null, secondary: window(5) }),
  }),
  named("rate limits with an empty limit id", {
    method: "account/rateLimits/updated",
    params: limits({ limitId: "", primary: window(5) }),
  }),
  named("rate limits with a limit id of 40", {
    method: "account/rateLimits/updated",
    params: limits({ limitId: "l".repeat(40), primary: window(5) }),
  }),
  named("rate limits with a limit id of 41", {
    method: "account/rateLimits/updated",
    params: limits({ limitId: "l".repeat(41), primary: window(5) }),
  }),
  offSchema("rate limits with a numbered limit id", {
    method: "account/rateLimits/updated",
    params: limits({ limitId: 3, primary: window(5) }),
  }),
  named("rate limits with null windows", {
    method: "account/rateLimits/updated",
    params: limits({ limitId: "codex", primary: null, secondary: null }),
  }),
  named("rate limits with no windows", {
    method: "account/rateLimits/updated",
    params: limits({ limitId: "codex" }),
  }),
  named("rate limits with a negative use", {
    method: "account/rateLimits/updated",
    params: limits({ primary: window(-1, 1_763_003_600), secondary: window(0) }),
  }),
  offSchema("rate limits with a fractional use", {
    method: "account/rateLimits/updated",
    params: limits({ primary: window(12.5), secondary: window(100.25) }),
  }),
  offSchema("rate limits with a use not a number", {
    method: "account/rateLimits/updated",
    params: limits({ primary: window("12"), secondary: window(3) }),
  }),
  offSchema("rate limits with a window not an object", {
    method: "account/rateLimits/updated",
    params: limits({ primary: 12, secondary: window(3) }),
  }),
  ...(
    [
      ["a null reset", null],
      ["a fractional reset", 1_763_003_600.5],
      ["a negative reset", -1],
      ["a zero reset", 0],
      ["the last reset JS dates hold", 8_640_000_000_000],
      ["a reset past JS dates", 8_640_000_000_001],
      ["a reset in the year 2370", 12_622_780_800],
      ["a reset as a string", "1763003600"],
      ["a reset as an object", { s: 1 }],
    ] as const satisfies readonly (readonly [string, unknown])[]
  ).map(([name, resetsAt]) =>
    (Number.isInteger(resetsAt) || resetsAt === null ? named : offSchema)(
      `rate limits with ${name}`,
      {
        method: "account/rateLimits/updated",
        params: limits({ limitId: "codex", primary: { usedPercent: 1, resetsAt } }),
      },
    ),
  ),
  offSchema("rate limits with none", { method: "account/rateLimits/updated", params: {} }),

  { ...item("item/started", userMessage(`${LABEL}\nHello`)), name: "a message taken" },
  {
    ...item("item/started", userMessage(`${LABEL}\nHello`, "more")),
    name: "a message taken with more",
  },
  { ...item("item/started", userMessage(`${LABEL}Hello`)), name: "a label with no newline" },
  {
    ...item("item/started", userMessage(`${LABEL.replace("(", "[quoted] (")}\nHi`)),
    name: "a quoted label",
  },
  {
    ...item("item/started", userMessage(`Message for you from Bazhen (msg_x-y):\nHi`)),
    name: "a label naming no message id",
  },
  {
    ...item("item/started", userMessage(` ${LABEL}\nHello`)),
    name: "a label after a space",
  },
  { ...item("item/started", userMessage("Fix the tests")), name: "the user's own input" },
  { ...item("item/started", userMessage()), name: "input of no content" },
  { ...item("item/started", userMessage(undefined, `${LABEL}\nHi`)), name: "an image first" },
  {
    ...item("item/started", { type: "userMessage", id: "item-1", content: "text" }),
    name: "input whose content isn't a list",
    bad: true,
  },
  offSchema("input with no thread", {
    method: "item/started",
    params: { turnId: "turn-1", startedAtMs: 1, item: userMessage(`${LABEL}\nHi`) },
  }),
  {
    ...item("item/started", { type: "agentMessage", id: "item-2", text: "Done." }),
    name: "an agent message started",
  },
  {
    ...item("item/started", { type: "contextCompaction", id: "item-3" }),
    name: "a compaction started",
  },
  { ...item("item/started", { id: "item-4" }), name: "an item with no type", bad: true },
  { ...item("item/started", "userMessage"), name: "an item not an object", bad: true },
  {
    ...item("item/completed", { type: "contextCompaction", id: "item-3" }),
    name: "a compaction completed",
  },
  {
    ...item("item/completed", { type: "contextCompaction", id: "item-3" }, 9),
    name: "a compaction completed on a numbered thread",
    bad: true,
  },
  {
    ...item("item/completed", { type: "agentMessage", id: "item-2", text: "Done." }),
    name: "an agent message completed",
  },
  {
    ...item("item/completed", userMessage(`${LABEL}\nHello`)),
    name: "a message completed",
  },
  named("a compaction, the deprecated way", {
    method: "thread/compacted",
    params: { threadId: T1, turnId: "turn-1" },
  }),

  named("a thread started", { method: "thread/started", params: { thread: thread() } }),
  named("an ephemeral thread started", {
    method: "thread/started",
    params: { thread: thread({ ephemeral: true }) },
  }),
  offSchema("a thread started with a null ephemeral", {
    method: "thread/started",
    params: { thread: thread({ ephemeral: null }) },
  }),
  named("a title thread started", {
    method: "thread/started",
    params: { thread: thread({ threadSource: "thread_title" }) },
  }),
  named("a subagent's thread started", {
    method: "thread/started",
    params: { thread: thread({ id: T2, threadSource: "subagent" }) },
  }),
  named("a thread started with a null source", {
    method: "thread/started",
    params: { thread: thread({ threadSource: null }) },
  }),
  offSchema("a thread started with no id", {
    method: "thread/started",
    params: { thread: { ephemeral: false } },
  }),
  offSchema("a thread started with ephemeral a string", {
    method: "thread/started",
    params: { thread: thread({ ephemeral: "no" }) },
  }),

  named("a request resolved by number", {
    method: "serverRequest/resolved",
    params: { threadId: T1, requestId: 4 },
  }),
  named("a request resolved by string", {
    method: "serverRequest/resolved",
    params: { threadId: T1, requestId: "req-4" },
  }),
  offSchema("a request resolved by a fraction", {
    method: "serverRequest/resolved",
    params: { threadId: T1, requestId: 4.5 },
  }),
  offSchema("a request resolved by a bool", {
    method: "serverRequest/resolved",
    params: { threadId: T1, requestId: true },
  }),
  offSchema("a request resolved with no id", {
    method: "serverRequest/resolved",
    params: { threadId: T1 },
  }),

  named("a command to approve", {
    method: "item/commandExecution/requestApproval",
    params: command({ command: "rm -rf build", reason: "outside the sandbox", cwd: "/work" }),
  }),
  named("a command to approve with no reason", {
    method: "item/commandExecution/requestApproval",
    params: command({ command: "make" }),
  }),
  named("a command to approve with an empty reason", {
    method: "item/commandExecution/requestApproval",
    params: command({ command: "make", reason: "" }),
  }),
  named("a command to approve with a null command", {
    method: "item/commandExecution/requestApproval",
    params: command({ command: null, reason: null }),
  }),
  named("a command to approve with no command", {
    method: "item/commandExecution/requestApproval",
    params: command({}),
  }),
  offSchema("a command to approve with a numbered command", {
    method: "item/commandExecution/requestApproval",
    params: command({ command: 3 }),
  }),
  offSchema("a command to approve with no item", {
    method: "item/commandExecution/requestApproval",
    params: { threadId: T1, turnId: "turn-1", command: "make" },
  }),
  named("a file change to approve", {
    method: "item/fileChange/requestApproval",
    params: command({ itemId: "patch-1", reason: "writes outside the root", grantRoot: "/" }),
  }),
  named("a file change to approve with no reason", {
    method: "item/fileChange/requestApproval",
    params: command({ itemId: "patch-1" }),
  }),
  named("an old-style command approval", {
    method: "execCommandApproval",
    params: { conversationId: T1, callId: "call-1", command: ["ls"], cwd: "/work", parsedCmd: [] },
  }),

  { ...userInput([question({})]), name: "a free-text question" },
  {
    ...userInput([question({ options: [{ label: "A", description: "a" }] })]),
    name: "a choice",
  },
  {
    ...userInput([question({ options: [{ label: "A", description: "a" }], isOther: true })]),
    name: "a choice with other",
  },
  { ...userInput([question({ options: [] })]), name: "a question with no options" },
  { ...userInput([question({ options: null })]), name: "a question with null options" },
  { ...userInput([question({ isSecret: true })]), name: "a secret" },
  { ...userInput([question({ isOther: false })]), name: "a question not other" },
  {
    ...userInput([question({}), question({ id: "q2", question: "And why?" })]),
    name: "two questions",
  },
  { ...userInput([]), name: "no questions" },
  { ...userInput([question({ question: "" })]), name: "an empty question" },
  { ...userInput([question({ question: "q".repeat(400) })]), name: "a long question" },
  {
    ...userInput([question({ question: `${"q".repeat(299)}😀` })]),
    name: "a question cut in a surrogate pair",
  },
  { ...userInput([question({ id: 3 })]), name: "a question with a numbered id", bad: true },
  { ...userInput("what?"), name: "questions not a list", bad: true },
  named("an elicitation", {
    method: "mcpServer/elicitation/request",
    params: {
      threadId: T1,
      turnId: "turn-1",
      serverName: "github",
      mode: "form",
      message: "Which repository?",
      requestedSchema: FORM,
    },
  }),
  named("an elicitation with no message", {
    method: "mcpServer/elicitation/request",
    params: {
      threadId: T1,
      serverName: "github",
      mode: "openai/userVerification",
      challenge: "c",
      description: "Confirm it's you",
      title: "Verify",
    },
  }),
  named("an elicitation by a link", {
    method: "mcpServer/elicitation/request",
    params: {
      threadId: T1,
      serverName: "github",
      mode: "url",
      elicitationId: "e1",
      message: "Sign in",
      url: "https://example.com",
    },
  }),
  named("an elicitation with an empty message", {
    method: "mcpServer/elicitation/request",
    params: {
      threadId: T1,
      serverName: "github",
      mode: "form",
      message: "",
      requestedSchema: FORM,
    },
  }),
  named("an elicitation with a long message", {
    method: "mcpServer/elicitation/request",
    params: {
      threadId: T1,
      serverName: "github",
      mode: "form",
      message: "m".repeat(400),
      requestedSchema: FORM,
    },
  }),
  offSchema("an elicitation with no server", {
    method: "mcpServer/elicitation/request",
    params: { threadId: T1, message: "?" },
  }),
  named("more permissions", {
    method: "item/permissions/requestApproval",
    params: command({ cwd: "/work", permissions: {}, reason: "needs the network" }),
  }),
  named("more permissions with no reason", {
    method: "item/permissions/requestApproval",
    params: command({ cwd: "/work", permissions: {} }),
  }),
  offSchema("more permissions with no item", {
    method: "item/permissions/requestApproval",
    params: { threadId: T1, reason: "?" },
  }),

  offSchema("a method Codex doesn't send", { method: "thread/unknown", params: { threadId: T1 } }),
  offSchema("params not an object", { method: "turn/started", params: [T1] }),
  offSchema("null params", { method: "item/commandExecution/requestApproval", params: null }),
];

/** What thread/start and thread/resume answer, read for the thread's activity. */
export const RESULTS: readonly Answer[] = [
  { name: "idle", result: response(thread()) },
  {
    name: "waiting on approval",
    result: response(thread({ status: { type: "active", activeFlags: ["waitingOnApproval"] } })),
  },
  { name: "working", result: response(thread({ status: { type: "active", activeFlags: [] } })) },
  {
    name: "working with no flags",
    result: response(thread({ status: { type: "active" } })),
    bad: true,
  },
  { name: "not loaded", result: response(thread({ status: { type: "notLoaded" } })) },
  { name: "a system error", result: response(thread({ status: { type: "systemError" } })) },
  {
    name: "an unknown status",
    result: response(thread({ status: { type: "paused" } })),
    bad: true,
  },
  { name: "no status", result: response({ id: T1 }), bad: true },
  { name: "no thread", result: {}, bad: true },
  { name: "null", result: null, bad: true },
  { name: "a thread not an object", result: response(T1), bad: true },
];

/** An answer to a request, maybe off Codex's schema on purpose. */
export interface Answer {
  readonly name: string;
  readonly result: unknown;
  readonly bad?: true;
}

/** What thread/list answers, a page at a time. */
export const LISTS: readonly Answer[] = [
  {
    name: "a page and a cursor",
    result: {
      data: [
        thread(),
        thread({ id: T2, ephemeral: true }),
        thread({ id: T3, threadSource: "thread_title" }),
        thread({ id: "019a8f40-0000-7000-8000-000000000005", threadSource: "user" }),
        thread({ id: "019a8f40-0000-7000-8000-000000000004", threadSource: null }),
      ],
      nextCursor: "c2",
      backwardsCursor: null,
    },
  },
  { name: "the last page", result: { data: [thread({ id: T2 })], nextCursor: null } },
  { name: "a page with no cursor", result: { data: [thread({ id: T3 })] } },
  { name: "an empty page", result: { data: [], nextCursor: "c3" } },
  {
    name: "a thread with no id",
    result: { data: [thread(), { ephemeral: false }], nextCursor: null },
    bad: true,
  },
  { name: "data not a list", result: { data: thread(), nextCursor: "c2" }, bad: true },
  { name: "a cursor not a string", result: { data: [thread()], nextCursor: 2 }, bad: true },
  { name: "no data", result: { nextCursor: "c2" }, bad: true },
  { name: "null", result: null, bad: true },
];

/** Titles a terminal shows: a TUI's, cut or whole, and the user's own. */
const TITLES: readonly string[] = [
  T1,
  `${T1.slice(0, 29)}...`,
  `${T1.slice(0, 29)}…`,
  T1.slice(0, 29),
  T1.slice(0, 28),
  `  ${T1}  `,
  `\t${T1.slice(0, 29)}...\n`,
  T1.slice(0, 27),
  T1.toUpperCase(),
  `${T1} `,
  `${T1}x`,
  `${T1.slice(0, 29)}..`,
  `${T1.slice(0, 29)}....`,
  `${T1.slice(0, 8)}-`,
  "019a8f3c-------------------",
  "my project",
  "✳ Claude Code",
  "",
  "   ",
];

const MATCHING: readonly { readonly prefix: string; readonly ids: readonly string[] }[] = [
  { prefix: T1.slice(0, 29), ids: [T1, T2, T3] },
  { prefix: T1.slice(0, 20), ids: [T1, T2, T3, T1] },
  { prefix: T3, ids: [T1, T2] },
  { prefix: T1, ids: [] },
];

/**
 * What a Codex server answers each of a launch's requests with. A resume answers with the thread
 * `resumed` names, so a server that moved the agent shows.
 */
const answersTo = (resumed: unknown): Record<string, unknown> => ({
  "thread/start": STARTED,
  "thread/resume": resumed,
  "thread/inject_items": {},
});

/** A channel that answers each launch's requests with `answers`, and records them. */
function channel(answers: Record<string, unknown>): {
  port: HarnessChannelPort;
  sent: { method: string; params: unknown }[];
} {
  const sent: { method: string; params: unknown }[] = [];
  return {
    sent,
    port: {
      request: (method: string, params: unknown) => {
        sent.push({ method, params });
        return Promise.resolve(answers[method]);
      },
    },
  };
}

/** What thread/start answers a launch. */
export const STARTED = response(thread({ id: T2 }));

const SOCKET = '/run/user/1000/bazhen/daemon "a".sock';

interface Start {
  readonly name: string;
  readonly socket?: string;
  readonly options: LaunchOptions;
  readonly resumed?: unknown;
  /** Its resume answer is off Codex's schema on purpose. */
  readonly bad?: true;
}

export const STARTS: readonly Start[] = [
  { name: "plain", options: {} },
  { name: "on the daemon's socket", socket: SOCKET, options: {} },
  { name: "in light", options: { theme: "light" } },
  { name: "in dark", socket: SOCKET, options: { theme: "dark" } },
  { name: "with instructions", options: { instructions: "Review it twice." } },
  {
    name: "with instructions changed",
    options: { instructions: "Review it twice.", instructionsChanged: true },
  },
  { name: "changed with no instructions", options: { instructionsChanged: true } },
  { name: "with a compaction window", socket: SOCKET, options: { compactWindowTokens: 200_000 } },
  { name: "with a window of 0", options: { compactWindowTokens: 0 } },
  { name: "resumed on another thread", options: {}, resumed: response(thread({ id: T3 })) },
  { name: "resumed with no thread", options: {}, resumed: {}, bad: true },
];

/** What a launch did, or the kind of refusal it gave: the words of a zod error aren't the contract. */
async function started(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    return { spec: await run() };
  } catch (err) {
    return { refused: err instanceof Error ? err.constructor.name : "unknown" };
  }
}

/** What the daemon asks a harness to launch. */
const REQUEST: AgentLaunchRequest = { harness: "codex", project: "bazhen", cwd: "/work" };

async function starts(): Promise<unknown[]> {
  const out = [];
  for (const s of STARTS) {
    const answers = answersTo(s.resumed ?? response(thread()));
    const launch = channel(answers);
    const harness = (port: HarnessChannelPort) =>
      new CodexHarness(
        port,
        "unix:///home/u/.codex/app-server-control/app-server-control.sock",
        s.socket,
      );
    const launched = await started(() => harness(launch.port).launchSpec(REQUEST, s.options));
    const resume = channel(answers);
    const resumed = await started(() =>
      harness(resume.port).resumeSpec(REQUEST, { kind: "codex-thread", id: T1 }, s.options),
    );
    out.push({
      name: s.name,
      ...(s.bad === undefined ? {} : { bad: true }),
      ...(s.socket === undefined ? {} : { socket: s.socket }),
      options: s.options,
      answers,
      launch: { requests: launch.sent, ...launched },
      resume: { requests: resume.sent, ...resumed },
    });
  }
  return out;
}

const TOML = [
  "plain",
  "/home/u/my dir/sock",
  'a "quoted" path',
  "back\\slash",
  "line\nbreak\ttab",
  "\u0000\u001f\u007f",
  "\u0080 is not escaped",
  "é and 😀",
  " ",
  "",
];

/** The schema, in Codex's, of the params of each request the daemon sends. */
export const SENT: Readonly<Record<string, string>> = {
  "thread/start": "ThreadStartParams.json",
  "thread/resume": "ThreadResumeParams.json",
  "thread/inject_items": "ThreadInjectItemsParams.json",
};

/** The schemas, in Codex's, of the answers to the requests an approval or question result answers. */
export const ANSWERS = {
  approvalResult: [
    "CommandExecutionRequestApprovalResponse.json",
    "FileChangeRequestApprovalResponse.json",
  ],
  questionResult: ["ToolRequestUserInputResponse.json"],
} as const;

/** What the daemon sends back and runs, given what it holds. */
function builders(): unknown {
  return {
    approvalResult: (["allow", "deny"] as const).map((decision) => ({
      decision,
      result: approvalResult(decision),
    })),
    questionResult: [
      { questionId: "q1", text: "Call it Bob", result: questionResult("q1", "Call it Bob") },
      { questionId: "q 2", text: "", result: questionResult("q 2", "") },
    ],
    messageText: [
      { id: MSG, body: "Hello", text: messageText(MSG, "Hello") },
      {
        id: MSG,
        body: `Forwarded: ${LABEL}\nold`,
        text: messageText(MSG, `Forwarded: ${LABEL}\nold`),
      },
    ],
    queueArgs: [
      { thread: T1, text: "Hi", remote: "unix:///s", args: queueArgs(T1, "Hi", "unix:///s") },
      { thread: T1, text: "-Hi", remote: null, args: queueArgs(T1, "-Hi", null) },
    ],
    threadConfig: [SOCKET, ""].map((socket) => ({ socket, config: threadConfig(socket) })),
    compactConfig: [200_000, 0, 1.5, null].map((tokens) => ({
      tokens,
      config: compactConfig(tokens),
    })),
    tomlString: TOML.map((value) => ({ value, toml: tomlString(value) })),
  };
}

/** What the daemon reads of the CLI and the server, and how long it waits to reconnect. */
function daemonSide(): unknown {
  return {
    startArgs: DAEMON_START_ARGS,
    cliVersion: [
      "codex-cli 0.167.1\n",
      "codex-cli 0.167.1-alpha.2",
      "  codex-cli 0.167.1  ",
      "0.167.1",
      "codex-cli",
      "codex-cli v1",
      "codex-cli 0.1 extra",
      "",
    ].map((output) => ({ output, version: cliVersion(output) })),
    nextDelay: (
      [
        [1000, null, 1000],
        [1000, 29_999, 1000],
        [1000, 30_000, 1000],
        [8000, 30_001, 1000],
        [32_000, null, 1000],
        [60_000, 5, 1000],
        [250, null, 250],
      ] as const satisfies readonly (readonly [number, number | null, number])[]
    ).map(([current, lived, first]) => ({
      current,
      lived,
      first,
      next: nextDelay(current, lived, first),
    })),
    codexHome: [
      { env: { CODEX_HOME: "/elsewhere" }, home: "/home/u" },
      { env: { CODEX_HOME: "" }, home: "/home/u" },
      { env: {}, home: "/home/u" },
    ].map(({ env, home }) => {
      const codexHome = codexHomeOf(env, home);
      return { env, home, codexHome, address: appServerAddress(codexHome) };
    }),
  };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Every message, as each reader reads it. */
function messages(): unknown {
  const names = new Set<string>();
  return MESSAGES.map(({ name, method, params, bad }) => {
    if (names.has(name)) throw new Error(`two codex fixture messages are named ${name}`);
    names.add(name);
    return {
      name,
      ...(bad === undefined ? {} : { bad }),
      method,
      ...(params === undefined ? {} : { params }),
      read: {
        approval: readApproval(method, params),
        question: readQuestion(method, params),
        resolved: readResolved(method, params),
        userMessage: readUserMessage(method, params),
        threadStatus: readThreadStatus(method, params),
        turn: readTurn(method, params),
        rateLimits: readRateLimits(method, params),
        itemStarted: readItemStarted(method, params),
        compaction: readCompaction(method, params),
        threadStarted: readThreadStarted(method, params),
      },
    };
  });
}

export async function codexFixture(): Promise<Record<string, string>> {
  return {
    "messages.json": json(messages()),
    "results.json": json(
      RESULTS.map(({ name, result, bad }) => ({
        name,
        ...(bad === undefined ? {} : { bad }),
        result,
        activity: resultActivity(result),
        notLoaded: resultNotLoaded(result),
      })),
    ),
    "lists.json": json(
      LISTS.map(({ name, result, bad }) => ({
        name,
        ...(bad === undefined ? {} : { bad }),
        result,
        ...readThreadList(result),
      })),
    ),
    "titles.json": json({
      titles: TITLES.map((title) => ({ title, prefix: titlePrefix(title) })),
      matching: MATCHING.map(({ prefix, ids }) => ({
        prefix,
        ids,
        matches: matching(prefix, ids),
      })),
    }),
    "builders.json": json(builders()),
    "daemon.json": json(daemonSide()),
    "starts.json": json(await starts()),
  };
}

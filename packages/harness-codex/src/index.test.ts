import { describe, expect, it } from "vitest";
import type { HarnessChannelPort } from "@bazhen/core";
import { ZodError } from "zod";
import {
  approvalResult,
  CodexHarness,
  matching,
  messageText,
  queueArgs,
  readApproval,
  readQuestion,
  questionResult,
  readResolved,
  readThreadList,
  readThreadStarted,
  readUserMessage,
  ThreadMismatch,
  titlePrefix,
} from "./index.ts";

const REMOTE = "unix:///codex/app-server-control.sock";

/**
 * A channel that answers `thread/start` with a thread and `thread/resume` with `resumes` (by
 * default the thread asked for), and records every request.
 */
function channel(result: unknown = { thread: { id: "thr-1" } }, resumes?: string) {
  const requests: [string, unknown][] = [];
  const port: HarnessChannelPort = {
    request: async (method, params) => {
      requests.push([method, params]);
      if (method === "thread/start") return result;
      if (method === "thread/resume") {
        return { thread: { id: resumes ?? String(Reflect.get(Object(params), "threadId")) } };
      }
      return {};
    },
  };
  return { port, requests };
}

describe("Codex harness", () => {
  it("starts the agent's thread and gives it a first item, so the TUI can resume it", async () => {
    const { port, requests } = channel();
    await new CodexHarness(port, REMOTE).launchSpec({ cwd: "/work" }, {});
    expect(requests).toEqual([
      ["thread/start", { cwd: "/work" }],
      [
        "thread/inject_items",
        { threadId: "thr-1", items: [expect.objectContaining({ role: "developer" })] },
      ],
    ]);
  });

  it("tells the agent's thread Bazhen's instructions once, in its first item, and not again on a resume", async () => {
    const { port, requests } = channel();
    const harness = new CodexHarness(port, REMOTE);
    const options = { instructions: "Use bazhen task done." };
    await harness.launchSpec({ cwd: "/work" }, options);
    await harness.resumeSpec(
      { harness: "codex", project: "p", cwd: "/work" },
      { kind: "codex-thread", id: "thr-1" },
      options,
    );
    const told = requests.filter(([, params]) =>
      JSON.stringify(params).includes("Use bazhen task done."),
    );
    expect(told.map(([method]) => method)).toEqual(["thread/inject_items"]);
  });

  it("launches the TUI on that thread, on the same server, and binds the agent to it", async () => {
    const launch = await new CodexHarness(channel().port, REMOTE).launchSpec({ cwd: "/work" }, {});
    expect(launch).toMatchObject({
      argv: [
        "codex",
        "resume",
        "thr-1",
        "--remote",
        REMOTE,
        "--no-alt-screen",
        "-c",
        'tui.terminal_title=["thread-id"]',
      ],
      externalRef: { kind: "codex-thread", id: "thr-1" },
    });
  });

  it("refuses to launch when the server returns no thread", async () => {
    await expect(
      new CodexHarness(channel({}).port, REMOTE).launchSpec({ cwd: "/work" }, {}),
    ).rejects.toThrow(ZodError);
  });

  it("reloads the agent's thread before the TUI resumes it, and starts no new one", async () => {
    const { port, requests } = channel();
    const harness = new CodexHarness(port, REMOTE);
    const resumed = await harness.resumeSpec(
      { harness: "codex", project: "p", cwd: "/work" },
      { kind: "codex-thread", id: "thr-7" },
      {},
    );
    expect(requests).toEqual([["thread/resume", { threadId: "thr-7", excludeTurns: true }]]);
    expect([resumed.argv.slice(0, 5), resumed.externalRef]).toEqual([
      ["codex", "resume", "thr-7", "--remote", REMOTE],
      { kind: "codex-thread", id: "thr-7" },
    ]);
  });

  it("refuses a resume that the server answered with another thread, rather than rebind", async () => {
    const harness = new CodexHarness(channel(undefined, "thr-other").port, REMOTE);
    await expect(
      harness.resumeSpec(
        { harness: "codex", project: "p", cwd: "/work" },
        { kind: "codex-thread", id: "thr-7" },
        {},
      ),
    ).rejects.toThrow(ThreadMismatch);
  });
});

/** The `-c tui.theme=…` overrides in a TUI's argv. */
const syntaxTheme = (argv: readonly string[]) =>
  argv.filter((arg, i) => argv[i - 1] === "-c" && arg.startsWith("tui.theme="));

describe("Codex's theme", () => {
  it("highlights for the theme the request names, starts in it, and leaves it to the user's config when it names none", async () => {
    const harness = new CodexHarness(channel().port, REMOTE);
    const launched = await harness.launchSpec({ cwd: "/work" }, { theme: "light" });
    const resumed = await harness.resumeSpec(
      { harness: "codex", project: "p", cwd: "/work" },
      { kind: "codex-thread", id: "thr-1" },
      { theme: "dark" },
    );
    const unthemed = await harness.launchSpec({ cwd: "/work" }, {});
    expect([
      [syntaxTheme(launched.argv), launched.theme],
      [syntaxTheme(resumed.argv), resumed.theme],
      [syntaxTheme(unthemed.argv), unthemed.theme],
    ]).toEqual([
      [['tui.theme="one-half-light"'], "light"],
      [['tui.theme="one-half-dark"'], "dark"],
      [[], undefined],
    ]);
  });
});

/** Whether a user-input request asking these questions can be answered from the inbox, and how. */
const ask = (question: object, more: object[] = []) =>
  readQuestion("item/tool/requestUserInput", {
    threadId: "thr-1",
    turnId: "t-1",
    itemId: "call_1",
    questions: [{ id: "q1", header: "H", question: "Which branch?", ...question }, ...more],
  })?.answers;

describe("Codex approvals", () => {
  const call = { threadId: "thr-1", turnId: "t-1", itemId: "call_1" };

  it("reads a request to run a command, and one to change files, as approvals for the inbox", () => {
    expect([
      readApproval("item/commandExecution/requestApproval", {
        ...call,
        command: "/bin/zsh -lc 'echo hi'",
        reason: "needs the network",
      }),
      readApproval("item/fileChange/requestApproval", { ...call, reason: null }),
    ]).toEqual([
      {
        threadId: "thr-1",
        itemId: "call_1",
        summary: "Run /bin/zsh -lc 'echo hi' (needs the network)",
      },
      { threadId: "thr-1", itemId: "call_1", summary: "Change files" },
    ]);
  });

  it("leaves any other request, or one it can't read, to the TUI", () => {
    expect([
      readApproval("item/tool/requestUserInput", call),
      readApproval("item/commandExecution/requestApproval", { itemId: "call_1" }),
    ]).toEqual([null, null]);
  });

  it("lets the inbox answer a single free-text question, and leaves choices and secrets to the TUI", () => {
    const choice = { options: [{ label: "main", description: "" }] };
    expect([
      ask({}),
      ask({ ...choice, isOther: true }),
      ask(choice),
      ask({ isSecret: true }),
      ask({}, [{ id: "q2", header: "H", question: "And why?" }]),
    ]).toEqual(["q1", "q1", null, null, null]);
  });

  it("reads an elicitation and a permissions request as questions only the TUI answers", () => {
    expect([
      readQuestion("mcpServer/elicitation/request", {
        threadId: "thr-1",
        turnId: null,
        serverName: "github",
        mode: "form",
        message: "Pick a repo",
      }),
      readQuestion("item/permissions/requestApproval", { ...call, reason: "network" }),
      readQuestion("item/commandExecution/requestApproval", call),
    ]).toEqual([
      {
        threadId: "thr-1",
        itemId: null,
        key: '["elicitation","github","Pick a repo"]',
        summary: "github asks: Pick a repo",
        answers: null,
      },
      {
        threadId: "thr-1",
        itemId: "call_1",
        key: "call_1",
        summary: "Grant more permissions (network)",
        answers: null,
      },
      null,
    ]);
  });

  it("answers a question with the human's text under its id", () => {
    expect(questionResult("q1", "main")).toEqual({ answers: { q1: { answers: ["main"] } } });
  });

  it("names the request a resolved notification says was answered, and nothing else", () => {
    expect([
      readResolved("serverRequest/resolved", { threadId: "thr-1", requestId: 7 }),
      readResolved("thread/status/changed", { requestId: 7 }),
      readResolved("serverRequest/resolved", {}),
    ]).toEqual([7, null, null]);
  });

  it("answers with Codex's own words for allow and deny", () => {
    expect([approvalResult("allow"), approvalResult("deny")]).toEqual([
      { decision: "accept" },
      { decision: "decline" },
    ]);
  });
});

/** A turn on `thr-1` starting with `text` as its input. */
const input = (text: string) => ({
  threadId: "thr-1",
  item: { type: "userMessage", id: "u-1", content: [{ type: "text", text }] },
});

describe("Codex mail", () => {
  it("queues a message on the app-server, or into the Codex home when none is up", () => {
    expect([queueArgs("thr-1", "hi", "unix:///s.sock"), queueArgs("thr-1", "hi", null)]).toEqual([
      ["queue", "--thread", "thr-1", "--remote", "unix:///s.sock", "--message", "hi"],
      ["queue", "--thread", "thr-1", "--message", "hi"],
    ]);
  });

  it("labels each message with its id, so the turn that takes it can be matched to it", () => {
    expect(messageText("msg_1", "hi")).toBe("Message for you from Bazhen (msg_1):\nhi");
  });

  it("reads which message a turn takes as the user's input, and nothing else", () => {
    expect([
      readUserMessage("item/started", input(messageText("msg_1", "hi"))),
      readUserMessage("item/started", { threadId: "thr-1", item: { type: "agentMessage" } }),
      readUserMessage("turn/started", input(messageText("msg_1", "hi"))),
    ]).toEqual([{ threadId: "thr-1", messageId: "msg_1" }, null, null]);
  });

  it("reads the label only where Bazhen puts it, never one a body or a person quotes", () => {
    const quoting = messageText("msg_1", `as ${messageText("msg_2", "said")} says`);
    expect([
      readUserMessage("item/started", input(quoting))?.messageId,
      readUserMessage("item/started", input(`fwd: ${messageText("msg_2", "x")}`))?.messageId,
    ]).toEqual(["msg_1", null]);
  });
});

const started = (thread: object) => readThreadStarted("thread/started", { thread });

describe("Codex thread titles", () => {
  const ID = "01a1ce15-39c0-7183-b5b6-f6f2f0000001";

  it("reads a thread id from a title, whole or cut to 29 characters by the TUI", () => {
    const titles = [ID, `${ID.slice(0, 29)}...`, `${ID.slice(0, 29)}…`, ` ${ID} `];
    expect(titles.map(titlePrefix)).toEqual([ID, ID.slice(0, 29), ID.slice(0, 29), ID]);
  });

  it("reads no id from a title that isn't one", () => {
    const titles = ["", "codex", "01a1ce15", "my repo 01a1ce15-39c0-7183-b5b6-f6f2f...", `${ID}x`];
    expect(titles.map(titlePrefix)).toEqual(titles.map(() => null));
  });

  it("matches each id that starts with the prefix, once", () => {
    expect(matching("01a1", ["01a1-a", "02b2-b", "01a1-a", "01a1-c"])).toEqual([
      "01a1-a",
      "01a1-c",
    ]);
  });

  it("takes new threads a human could be shown, and not the ones that write titles", () => {
    expect([
      started({ id: "thr-1", ephemeral: false }),
      started({ id: "thr-2", ephemeral: true }),
      started({ id: "thr-3", threadSource: "thread_title" }),
      readThreadStarted("thread/status/changed", { thread: { id: "thr-4" } }),
    ]).toEqual(["thr-1", null, null, null]);
  });

  it("lists the shown threads of a thread/list answer, and none of one it can't read", () => {
    const listed = { data: [{ id: "a" }, { id: "b", ephemeral: true }, { name: "no id" }] };
    expect([readThreadList(listed), readThreadList({ threads: [] })]).toEqual([["a"], []]);
  });
});

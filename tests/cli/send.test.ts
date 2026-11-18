import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BroadcastMessageResponse,
  type MailboxState,
  SendMessageResponse,
  WaitMessagesResponse,
} from "@bazhen/protocol";
import { type Scene, scene } from "./cli.ts";
import { AGENT, MSG, MSG2, OTHER, TASK, UUID } from "./fixtures.ts";

let s: Scene;
beforeEach(async () => {
  s = await scene();
});
afterEach(async () => {
  await s.cleanup();
});

const asAgent = { BAZHEN_AGENT_ID: AGENT };
const send = (argv: string[]) => s.bazhen(["agents", "send", ...argv], asAgent);
const taskSend = (argv: string[]) => s.bazhen(["tasks", "send", ...argv], asAgent);
const toAgent = (agentId: string) => `POST /v1/agents/${agentId}/messages`;
const toTask = `POST /v1/tasks/${TASK}/messages`;
const WAIT = "POST /v1/messages/wait";

/** The wait's answer: each message the CLI sent, in `state`. */
const waited = (...states: [string, string, MailboxState][]) => ({
  messages: states.map(([id, agentId, state]) => ({ id, agentId, state })),
});

describe("bazhen agents send", () => {
  it("sends the words after the agent as one message, or a file's text, and says what it sent", async () => {
    writeFileSync(join(s.dir, "notes.md"), "from a file\n");
    s.daemon.answer(toAgent(OTHER), SendMessageResponse, { messageId: MSG, eventIds: [1] });
    const words = await send([OTHER, "Is", "the", "build", "green?"]);
    const file = await send([OTHER, "--file", "notes.md"]);
    expect([words.code, words.stdout]).toEqual([0, `sent ${MSG} to ${OTHER}\n`]);
    expect(file.code).toBe(0);
    expect(s.daemon.calls(toAgent(OTHER)).map((r) => r.body)).toEqual([
      { idempotencyKey: expect.stringMatching(UUID), body: "Is the build green?" },
      { idempotencyKey: expect.stringMatching(UUID), body: "from a file\n" },
    ]);
  });

  it("sends to an agent by its name, and says it by that name though the daemon answers its id", async () => {
    s.daemon
      .answer(toAgent("BZ-127"), SendMessageResponse, { messageId: MSG, eventIds: [1] })
      .answer(WAIT, WaitMessagesResponse, waited([MSG, OTHER, "seen"]));
    const plain = await send(["BZ-127", "hi"]);
    const waiting = await send(["BZ-127", "hi", "--wait"]);
    expect([plain, waiting]).toEqual([
      { code: 0, stdout: `sent ${MSG} to BZ-127\n`, stderr: "" },
      {
        code: 0,
        stdout: `${MSG} to BZ-127: seen\n`,
        stderr: `sent ${MSG} to BZ-127\nwaiting up to 60 s\n`,
      },
    ]);
  });

  it("wants an agent and one text to send, from the words or a file", async () => {
    const runs = await Promise.all([
      send([]),
      send([OTHER]),
      send([OTHER, "hi", "--file", "f"]),
      send(["../tasks", "hi"]),
    ]);
    expect(runs.map((r) => [r.code, r.stdout])).toEqual(runs.map(() => [2, ""]));
    expect(runs.map((r) => r.stderr)).toEqual([
      expect.stringContaining("the agent"),
      expect.stringContaining("the text"),
      expect.stringContaining("not both"),
      expect.stringContaining("not an agent's name or id"),
    ]);
    expect(s.daemon.received).toEqual([]);
  });

  it("refuses text that holds another verb's option, rather than send it with the option taken out", async () => {
    const runs = await Promise.all([
      send([OTHER, "run", "it", "with", "--all"]),
      send([OTHER, "use", "--task", TASK]),
      s.bazhen(["inbox", "escalate", "Pin", "it?", "--file", "q.md"], asAgent),
    ]);
    expect(runs.map((r) => [r.code, r.stdout])).toEqual(runs.map(() => [2, ""]));
    expect(runs.map((r) => r.stderr)).toEqual([
      expect.stringContaining("quotes: it holds --all"),
      expect.stringContaining(
        "agents send takes no --task: to send to a task's agents, use tasks send",
      ),
      expect.stringContaining("--file is for agents send and tasks send"),
    ]);
    expect(s.daemon.received).toEqual([]);
  });
});

describe("bazhen agents send --wait", () => {
  it("says what it sent before it waits, waits as long as asked, and exits as the message stands", async () => {
    s.daemon
      .answer(toAgent(OTHER), SendMessageResponse, { messageId: MSG, eventIds: [1] })
      .answer(WAIT, WaitMessagesResponse, waited([MSG, OTHER, "seen"]));
    const ran = await send([OTHER, "hi", "--wait", "--timeout", "10"]);
    expect(ran).toEqual({
      code: 0,
      stdout: `${MSG} to ${OTHER}: seen\n`,
      stderr: `sent ${MSG} to ${OTHER}\nwaiting up to 10 s\n`,
    });
    expect(s.daemon.calls(WAIT)[0]?.body).toEqual({ messageIds: [MSG], timeoutMs: 10_000 });
  });

  it("waits as little as no time and as long as ten minutes", async () => {
    s.daemon
      .answer(toAgent(OTHER), SendMessageResponse, { messageId: MSG, eventIds: [1] })
      .answer(WAIT, WaitMessagesResponse, waited([MSG, OTHER, "seen"]));
    const none = await send([OTHER, "hi", "--wait", "--timeout", "0"]);
    const most = await send([OTHER, "hi", "--wait", "--timeout", "600"]);
    expect([none.code, most.code]).toEqual([0, 0]);
    expect(s.daemon.calls(WAIT).map((r) => r.body)).toEqual([
      { messageIds: [MSG], timeoutMs: 0 },
      { messageIds: [MSG], timeoutMs: 600_000 },
    ]);
  });

  it("says what it sent though the wait then fails, so no message's id is lost", async () => {
    s.daemon
      .answer(toAgent(OTHER), SendMessageResponse, { messageId: MSG, eventIds: [1] })
      .fail(WAIT, 503, { error: "unavailable", message: "stopping" });
    const ran = await send([OTHER, "hi", "--wait"]);
    expect([ran.code, ran.stdout, ran.stderr.split("\n").slice(0, 2)]).toEqual([
      1,
      "",
      [`sent ${MSG} to ${OTHER}`, "waiting up to 60 s"],
    ]);
  });

  it("waits a minute unless told", async () => {
    s.daemon
      .answer(toAgent(OTHER), SendMessageResponse, { messageId: MSG, eventIds: [1] })
      .answer(WAIT, WaitMessagesResponse, waited([MSG, OTHER, "delivered"]));
    await send([OTHER, "hi", "--wait"]);
    expect(s.daemon.calls(WAIT)[0]?.body).toEqual({ messageIds: [MSG], timeoutMs: 60_000 });
  });

  it.each([
    ["seen", 0],
    ["delivered", 0],
    ["undeliverable", 4],
    ["queued", 5],
    ["offered", 5],
    ["queued_in_codex", 5],
  ] as const)("exits as triage's does when the message is %s: %i", async (state, code) => {
    s.daemon
      .answer(toAgent(OTHER), SendMessageResponse, { messageId: MSG, eventIds: [1] })
      .answer(WAIT, WaitMessagesResponse, waited([MSG, OTHER, state]));
    const ran = await send([OTHER, "hi", "--wait"]);
    expect([ran.code, ran.stdout]).toEqual([code, `${MSG} to ${OTHER}: ${state}\n`]);
  });

  it("refuses a timeout without --wait, past the most, or not whole, and --wait on another verb", async () => {
    const runs = await Promise.all([
      send([OTHER, "hi", "--timeout", "5"]),
      send([OTHER, "hi", "--wait", "--timeout", "601"]),
      send([OTHER, "hi", "--wait", "--timeout", "1.5"]),
      s.bazhen(["tasks", "list", "--wait"], asAgent),
      s.bazhen(["tasks", "list", "--timeout", "5"], asAgent),
    ]);
    expect(runs.map((r) => [r.code, r.stdout])).toEqual(runs.map(() => [2, ""]));
    expect(runs.map((r) => r.stderr)).toEqual([
      expect.stringContaining("give --wait too"),
      expect.stringContaining("at most 600"),
      expect.stringContaining("not 1.5"),
      expect.stringContaining("--wait is for agents send and tasks send"),
      expect.stringContaining("--timeout is for agents send and tasks send"),
    ]);
    expect(s.daemon.received).toEqual([]);
  });
});

const sent = (...pairs: [string, string][]) =>
  pairs.map(([agentId, messageId]) => ({ agentId, messageId }));

describe("bazhen tasks send", () => {
  const skipped = [{ agentId: AGENT, reason: "it is closing" }];

  it("sends every word after the task to the task's assignees, and says what it sent", async () => {
    s.daemon.answer(toTask, BroadcastMessageResponse, {
      sent: sent([OTHER, MSG]),
      skipped: [],
      eventIds: [1],
    });
    const ran = await taskSend([TASK, "Rebase", "now."]);
    expect([ran.code, ran.stdout]).toEqual([0, `sent ${MSG} to ${OTHER}\n`]);
    expect(s.daemon.calls(toTask)[0]?.body).toEqual({
      idempotencyKey: expect.stringMatching(UUID),
      body: "Rebase now.",
    });
  });

  it("reads the task from the first word after the verb, whatever options come before it", async () => {
    s.daemon.answer(toTask, BroadcastMessageResponse, {
      sent: sent([OTHER, MSG]),
      skipped: [],
      eventIds: [1],
    });
    writeFileSync(join(s.dir, "m.md"), "file text");
    const ran = await taskSend(["--file", "m.md", TASK]);
    expect(ran.code).toBe(0);
    expect(s.daemon.calls(toTask).map((r) => r.body)).toEqual([
      { idempotencyKey: expect.stringMatching(UUID), body: "file text" },
    ]);
  });

  it("reads the text to send from stdin, given /dev/stdin", async () => {
    s.daemon.answer(toTask, BroadcastMessageResponse, {
      sent: [{ agentId: OTHER, messageId: MSG }],
      skipped: [],
      eventIds: [1],
    });
    const ran = await s.bazhen(
      ["tasks", "send", TASK, "--file", "/dev/stdin"],
      asAgent,
      "from a pipe\n",
    );
    expect(ran.code).toBe(0);
    expect(s.daemon.calls(toTask).map((r) => r.body)).toEqual([
      { idempotencyKey: expect.stringMatching(UUID), body: "from a pipe\n" },
    ]);
  });

  it.for([
    ["a device with no end", (): string => "/dev/zero", "not a regular file"],
    [
      "a FIFO no one writes to",
      (): string => {
        const fifo = join(s.dir, "fifo");
        execFileSync("mkfifo", [fifo]);
        return fifo;
      },
      "not a regular file",
    ],
    [
      "a file larger than any message",
      (): string => {
        const big = join(s.dir, "big");
        writeFileSync(big, "x".repeat((1 << 20) + 1));
        return big;
      },
      "more than 1048576 bytes",
    ],
  ] as const)("refuses, sending nothing, to send %s", async ([, make, why]) => {
    const path = make();
    const ran = await s.bazhen(["tasks", "send", TASK, "--file", path], asAgent);
    expect(ran).toEqual({ code: 1, stdout: "", stderr: `can't read ${path}: ${why}\n` });
    expect(s.daemon.received).toEqual([]);
  });

  it("fails, sending nothing, when the file to send can't be read", async () => {
    const ran = await s.bazhen(["tasks", "send", TASK, "--file", "missing.md"], asAgent);
    expect([ran.code, ran.stdout, ran.stderr]).toEqual([
      1,
      "",
      expect.stringContaining("missing.md"),
    ]);
    expect(s.daemon.received).toEqual([]);
  });

  it("wants the task and one text to send, and sends nothing without them", async () => {
    const runs = await Promise.all([
      taskSend([]),
      taskSend([TASK]),
      taskSend([TASK, "hi", "--file", "f"]),
    ]);
    expect(runs.map((r) => [r.code, r.stdout])).toEqual(runs.map(() => [2, ""]));
    expect(runs.map((r) => r.stderr)).toEqual([
      expect.stringContaining("missing the task to send to"),
      expect.stringContaining("the text"),
      expect.stringContaining("not both"),
    ]);
    expect(s.daemon.received).toEqual([]);
  });

  it("exits as bounced when it skipped anyone, without --wait too", async () => {
    s.daemon.answer(toTask, BroadcastMessageResponse, {
      sent: sent([OTHER, MSG]),
      skipped,
      eventIds: [1],
    });
    const ran = await taskSend([TASK, "hi"]);
    expect([ran.code, ran.stdout]).toEqual([
      4,
      `sent ${MSG} to ${OTHER}\nskipped ${AGENT}: it is closing\n`,
    ]);
  });

  it("exits as bounced when it could send to no one, waiting or not, and waits on nothing", async () => {
    s.daemon.answer(toTask, BroadcastMessageResponse, { sent: [], skipped, eventIds: [] });
    const plain = await taskSend([TASK, "hi"]);
    const waiting = await taskSend([TASK, "hi", "--wait"]);
    expect([plain.code, plain.stdout, waiting.code, waiting.stdout]).toEqual([
      4,
      `skipped ${AGENT}: it is closing\n`,
      4,
      `skipped ${AGENT}: it is closing\n`,
    ]);
    expect(s.daemon.calls(WAIT)).toEqual([]);
  });

  it.each([
    ["seen", "delivered", 0],
    ["seen", "queued", 5],
    ["queued", "undeliverable", 4],
  ] as const)(
    "waits on every message it sent, and exits with the worst of %s and %s: %i",
    async (first, second, code) => {
      s.daemon
        .answer(toTask, BroadcastMessageResponse, {
          sent: sent([OTHER, MSG], [AGENT, MSG2]),
          skipped: [],
          eventIds: [],
        })
        .answer(WAIT, WaitMessagesResponse, waited([MSG, OTHER, first], [MSG2, AGENT, second]));
      const ran = await taskSend([TASK, "hi", "--wait"]);
      expect([ran.code, ran.stderr]).toEqual([
        code,
        `sent ${MSG} to ${OTHER}\nsent ${MSG2} to ${AGENT}\nwaiting up to 60 s\n`,
      ]);
      expect(s.daemon.calls(WAIT)[0]?.body).toEqual({
        messageIds: [MSG, MSG2],
        timeoutMs: 60_000,
      });
    },
  );

  it("exits as bounced when it skipped anyone, though every message it sent landed", async () => {
    s.daemon
      .answer(toTask, BroadcastMessageResponse, { sent: sent([OTHER, MSG]), skipped, eventIds: [] })
      .answer(WAIT, WaitMessagesResponse, waited([MSG, OTHER, "seen"]));
    const ran = await taskSend([TASK, "hi", "--wait"]);
    expect([ran.code, ran.stdout]).toEqual([
      4,
      `skipped ${AGENT}: it is closing\n${MSG} to ${OTHER}: seen\n`,
    ]);
  });
});

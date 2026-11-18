import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SendMessageResponse,
  StateSnapshot,
  WAIT_MAX_MS,
  WaitRequest,
  WaitResponse,
} from "@bazhen/protocol";
import { FakeDaemon, type Scene, scene } from "./cli.ts";
import { AGENT, MSG, MSG2, OTHER, TASK, agent, shell, snapshot, task } from "./fixtures.ts";

let s: Scene;
beforeEach(async () => {
  s = await scene();
});
afterEach(async () => {
  await s.cleanup();
});

const SH1 = "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c71";
const WAITS = "POST /v1/waits";
const reviewer = (state: "starting" | "running" | "closed") => agent(AGENT, "reviewer", { state });

/** The daemon's answers to the waits, in turn, the last kept once they run out. */
const answers = (first: WaitResponse, ...then: WaitResponse[]) => {
  const held = [first, ...then];
  s.daemon.answerWith(
    WAITS,
    WaitResponse,
    () => (held.length > 1 ? held.shift() : held[0]) ?? first,
  );
};
/** What the CLI asked each wait. */
const asked = () => s.daemon.calls(WAITS).map((r) => WaitRequest.parse(r.body));

describe("bazhen agents wait, shells wait and tasks wait", () => {
  it("asks the daemon to wait on the agent named, and prints what it says once met", async () => {
    s.daemon.answer("GET /v1/state", StateSnapshot, snapshot({ agents: [reviewer("starting")] }));
    answers({ verdict: "met", said: `reviewer (${AGENT}) is idle` });
    const ran = await s.bazhen(["agents", "wait", "reviewer", "idle", "--timeout", "30"]);
    expect([ran, asked()]).toEqual([
      { code: 0, stdout: `reviewer (${AGENT}) is idle\n`, stderr: "" },
      [
        {
          condition: { on: "agent", agentId: AGENT, until: "idle" },
          timeoutMs: expect.any(Number),
        },
      ],
    ]);
    expect(asked()[0]?.timeoutMs).toBeGreaterThan(29_000);
  });

  it("holds no one call longer than the daemon takes, however long the timeout", async () => {
    answers({ verdict: "met", said: "ship it is done" });
    const ran = await s.bazhen(["tasks", "wait", TASK, "done", "--timeout", "3600"]);
    expect([ran.code, asked().map((r) => r.timeoutMs)]).toEqual([0, [WAIT_MAX_MS]]);
  });

  it("asks again while the answer is pending and time is left", async () => {
    s.daemon.answer("GET /v1/state", StateSnapshot, snapshot({ agents: [reviewer("starting")] }));
    answers(
      { verdict: "pending", said: "reviewer is starting" },
      { verdict: "met", said: "reviewer is ready" },
    );
    const ran = await s.bazhen(["agents", "wait", "reviewer", "ready"]);
    expect([ran.code, ran.stdout, asked().length]).toEqual([0, "reviewer is ready\n", 2]);
  });

  it("exits 1 when it can't be met now, saying what the daemon said", async () => {
    s.daemon.answer("GET /v1/state", StateSnapshot, snapshot({ agents: [reviewer("starting")] }));
    answers({ verdict: "never", said: "reviewer is closed, and can't be running now" });
    expect(await s.bazhen(["agents", "wait", "reviewer", "running"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "reviewer is closed, and can't be running now\n",
    });
  });

  it("exits 5 when the timeout runs out first, saying where it stands", async () => {
    s.daemon.answer("GET /v1/state", StateSnapshot, snapshot({ agents: [reviewer("starting")] }));
    s.daemon.answerLater(WAITS, WaitResponse, async (r) => {
      await new Promise((resolve) => setTimeout(resolve, WaitRequest.parse(r.body).timeoutMs));
      return { verdict: "pending", said: "reviewer is starting" };
    });
    expect(await s.bazhen(["agents", "wait", "reviewer", "running", "--timeout", "1"])).toEqual({
      code: 5,
      stdout: "",
      stderr: "reviewer is starting still, after 1 s\n",
    });
  });

  it("exits 5 on time though the daemon never answers the wait", async () => {
    s.daemon.answer("GET /v1/state", StateSnapshot, snapshot({ agents: [reviewer("starting")] }));
    s.daemon.hang(WAITS);
    const started = Date.now();
    const ran = await s.bazhen(["agents", "wait", "reviewer", "running", "--timeout", "1"]);
    expect([ran.code, Date.now() - started < 4000]).toEqual([5, true]);
  });

  it("asks again once the daemon is back, though it went away mid-wait", async () => {
    s.daemon.answer("GET /v1/state", StateSnapshot, snapshot({ agents: [reviewer("starting")] }));
    const held = new Promise<void>((resolve) =>
      s.daemon.answerWith(WAITS, WaitResponse, () => {
        resolve();
        return { verdict: "pending", said: "reviewer is starting" };
      }),
    );
    const run = s.start(["agents", "wait", "reviewer", "running", "--timeout", "10"]);
    await held;
    await s.daemon.close();
    const back = await FakeDaemon.listen(s.socket);
    try {
      back.answer(WAITS, WaitResponse, { verdict: "met", said: "reviewer is running" });
      expect(await run.ended).toEqual({ code: 0, stdout: "reviewer is running\n", stderr: "" });
    } finally {
      await back.close();
    }
  });

  it("waits on a shell named, and on a task, printing the daemon's whole answer with --json", async () => {
    const build = shell(SH1, { name: "build", state: "closed" });
    s.daemon.answer(
      "GET /v1/state",
      StateSnapshot,
      snapshot({ shells: [shell(SH1, { name: "build" })] }),
    );
    const done = {
      verdict: "met",
      said: "ship it is done",
      task: task(TASK, "ship it", { state: "done" }),
    } as const;
    answers({ verdict: "met", said: "build is closed", shell: build }, done);
    const ran = [
      await s.bazhen(["shells", "wait", "BUILD", "ended", "--json"]),
      await s.bazhen(["tasks", "wait", TASK, "done", "--json"]),
    ];
    expect(ran.map((r) => [r.code, JSON.parse(r.stdout)])).toEqual([
      [0, { verdict: "met", said: "build is closed", shell: build }],
      [0, done],
    ]);
    expect(asked().map((r) => r.condition)).toEqual([
      { on: "shell", shellId: SH1, until: "ended" },
      { on: "task", taskId: TASK, until: "done" },
    ]);
  });

  it("prints a never with --json on stdout, and still exits 1", async () => {
    answers({ verdict: "never", said: "ship it is cancelled, and can't be done now" });
    const ran = await s.bazhen(["tasks", "wait", TASK, "done", "--json"]);
    expect([ran.code, JSON.parse(ran.stdout).verdict, ran.stderr]).toEqual([1, "never", ""]);
  });

  it("refuses a condition its noun hasn't, a target the daemon hasn't, and a bad timeout", async () => {
    s.daemon.answer(
      "GET /v1/state",
      StateSnapshot,
      snapshot({ agents: [reviewer("starting")], shells: [shell(SH1)] }),
    );
    const ran = await Promise.all(
      [
        ["agents", "wait", "reviewer", "creating"],
        ["shells", "wait", SH1, "idle"],
        ["tasks", "wait", TASK, "cancelled"],
        ["tasks", "wait", "ship-it", "done"],
        ["agents", "wait", "nobody", "running"],
        ["shells", "wait", "reviewer", "running"],
        ["agents", "wait", "reviewer", "running", "--timeout", "soon"],
        ["agents", "wait", "reviewer"],
        ["agents", "wait", "reviewer", "idle", "now"],
        ["tasks", "wait", TASK, "done", "--all"],
      ].map((args) => s.bazhen(args)),
    );
    expect(ran.map((r) => [r.code, r.stderr.split("\n")[0]])).toEqual([
      [
        2,
        "an agent is waited on to be starting, running, exited, unknown, lost, closing, closed, failed, ended, ready, or idle; not creating",
      ],
      [
        2,
        "a shell is waited on to be creating, running, exited, unknown, lost, closing, closed, failed, or ended; not idle",
      ],
      [2, "a task is waited on to be done; not cancelled"],
      [2, "<task> is a task's id, not ship-it"],
      [1, "the daemon has no agent nobody"],
      [1, "the daemon has no open shell reviewer"],
      [2, "--timeout is whole seconds, not soon"],
      [2, "missing what to wait for"],
      [2, "agents wait takes no now"],
      [2, "tasks wait takes no --all"],
    ]);
    expect(asked()).toEqual([]);
  });

  it("refuses no timeout before asking the daemon, and exits 3 when no daemon answers", async () => {
    await s.daemon.close();
    const ran = await Promise.all(
      [
        ["agents", "wait", "reviewer", "running", "--timeout", "0"],
        ["agents", "wait", "reviewer", "running"],
        ["tasks", "wait", TASK, "done"],
      ].map((args) => s.bazhen(args)),
    );
    expect(ran.map((r) => [r.code, r.stderr.split("\n")[0]])).toEqual([
      [2, "--timeout is at least 1 s"],
      [3, "bazhen is not running; start it with `bazhen start`"],
      [3, "bazhen is not running; start it with `bazhen start`"],
    ]);
  });
});

/** The send `--reply` makes, from an agent: the daemon takes it, and queues the message. */
const sent = () =>
  s.daemon.takes(AGENT).answer(`POST /v1/agents/${OTHER}/messages`, SendMessageResponse, {
    messageId: MSG,
    eventIds: [1],
  });

describe("bazhen agents send --reply", () => {
  it("sends, then waits for the reply, printing who replied and its id but not its text", async () => {
    sent();
    answers({ verdict: "met", said: `worker (${OTHER}) replied`, replyId: MSG2 });
    const ran = await s.bazhen(["agents", "send", OTHER, "review", "this", "--reply"]);
    expect([ran, asked().map((r) => r.condition)]).toEqual([
      {
        code: 0,
        stdout: `worker (${OTHER}) replied: ${MSG2}\n`,
        stderr: `sent ${MSG} to ${OTHER}\nwaiting up to 60 s for a reply\n`,
      },
      [{ on: "reply", messageId: MSG }],
    ]);
  });

  it("exits 4 when the message bounced, and 5 when no reply came in time", async () => {
    sent();
    answers({ verdict: "bounced", said: "the message to worker bounced" });
    const bounced = await s.bazhen(["agents", "send", OTHER, "hi", "--reply"]);
    answers({ verdict: "pending", said: "worker hasn't replied" });
    s.daemon.answerLater(WAITS, WaitResponse, async (r) => {
      await new Promise((resolve) => setTimeout(resolve, WaitRequest.parse(r.body).timeoutMs));
      return { verdict: "pending", said: "worker hasn't replied" };
    });
    const late = await s.bazhen(["agents", "send", OTHER, "hi", "--reply", "--timeout", "1"]);
    expect([bounced.code, late.code, late.stderr.split("\n").at(-2)]).toEqual([
      4,
      5,
      "worker hasn't replied still, after 1 s",
    ]);
  });

  it("refuses the human, and --reply beside --wait or on tasks send, before sending", async () => {
    s.daemon.takes(null);
    const ran = await Promise.all(
      [
        ["agents", "send", OTHER, "hi", "--reply"],
        ["agents", "send", OTHER, "hi", "--reply", "--wait"],
        ["tasks", "send", TASK, "hi", "--reply"],
      ].map((args) => s.bazhen(args)),
    );
    expect(ran.map((r) => [r.code, r.stderr.split("\n")[0]])).toEqual([
      [
        2,
        "agents send --reply runs inside an agent Bazhen launched: only an agent can be replied to",
      ],
      [2, "give --wait or --reply, not both: a reply comes after the message arrives"],
      [2, "--reply is for agents send"],
    ]);
    expect(s.daemon.routes().filter((r) => r.includes("/messages"))).toEqual([]);
  });
});

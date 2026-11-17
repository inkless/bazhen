import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EventEnvelope, type EventEnvelopeFrame, StateSnapshot } from "@bazhen/protocol";
import { type EventStream, FakeDaemon, type Running, type Scene, scene } from "./cli.ts";
import { AGENT, agent, shell, snapshot } from "./fixtures.ts";

let s: Scene;
beforeEach(async () => {
  s = await scene();
});
afterEach(async () => {
  await s.cleanup();
});

const SH1 = "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c71";
const TERM = "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c72";
const AT = "2026-11-16T12:00:00.000Z";
const NOT_RUNNING = "bazhen is not running; start it with `bazhen start`\n";

const event = (id: number, type = "agent.running", entityId = AGENT): EventEnvelope => ({
  id,
  ts: AT,
  type,
  entityType: type.split(".")[0] ?? "agent",
  entityId,
  actor: "daemon",
  causationId: null,
  correlationId: null,
  payload: {},
});
const line = (id: number, type = "agent.running", entityId = AGENT) =>
  `${id} ${AT} ${type} ${type.split(".")[0]} ${entityId} daemon\n`;

/** The daemon's state: `states` in turn, one a read, the last kept once they run out. */
const states = (...held: StateSnapshot[]) => {
  let read = 0;
  s.daemon.answerWith(
    "GET /v1/state",
    StateSnapshot,
    () => held[Math.min(read++, held.length - 1)],
  );
};
const reviewer = (state: "starting" | "running" | "closed") => agent(AGENT, "reviewer", { state });
const sends =
  (...frames: EventEnvelopeFrame[]) =>
  (stream: EventStream) => {
    for (const frame of frames) stream.send(frame);
  };
const resets = (reason: "stale" | "foreign") => (stream: EventStream) => {
  stream.send({ type: "reset", reason });
  stream.close();
};
/** Ends a follow as `head` does: stops reading, and the next event finds no one to print to. */
const stopReading = (run: Running, daemon: FakeDaemon = s.daemon) => {
  run.stopReading();
  daemon.opened.at(-1)?.send({ type: "event", event: event(99) });
  return run.ended;
};
const streams = () => s.daemon.routes().filter((r) => r.startsWith("GET /v1/events"));

describe("bazhen events --follow", () => {
  it("prints each event a line, from the state's cursor", async () => {
    states(snapshot({ epoch: "e1", eventId: 7 }));
    s.daemon.events(
      sends(
        { type: "event", event: event(8) },
        { type: "event", event: event(9, "terminal.renamed", SH1) },
      ),
    );
    const run = s.start(["events", "--follow"]);
    await run.printed(line(9, "terminal.renamed", SH1));
    expect(await stopReading(run)).toEqual({
      code: 0,
      stdout: line(8) + line(9, "terminal.renamed", SH1),
      stderr: "",
    });
    expect(streams()).toEqual(["GET /v1/events?epoch=e1&after=7"]);
  });

  it("prints each event as the daemon sent it with --json, and follows from --after", async () => {
    states(snapshot({ epoch: "e1", eventId: 7 }));
    const sent = { ...event(3), payload: { name: "x" }, causationId: 2, correlationId: "c" };
    s.daemon.events(sends({ type: "event", event: sent }));
    const run = s.start(["events", "--follow", "--json", "--after", "2"]);
    await run.printed("\n");
    expect(await stopReading(run)).toEqual({
      code: 0,
      stdout: `${JSON.stringify(sent)}\n`,
      stderr: "",
    });
    expect(streams()).toEqual(["GET /v1/events?epoch=e1&after=2"]);
  });

  it("ends, exiting 0, once no one reads what it prints, as under head", async () => {
    states(snapshot());
    s.daemon.events(sends({ type: "event", event: event(2) }));
    const run = s.start(["events", "--follow"]);
    await run.printed(line(2));
    run.stopReading();
    s.daemon.opened[0]?.send({ type: "event", event: event(3) });
    expect((await run.ended).code).toBe(0);
  });

  it("says events were missed after a reset, and follows on from the state read again", async () => {
    states(snapshot({ epoch: "e1", eventId: 7 }), snapshot({ epoch: "e2", eventId: 20 }));
    s.daemon.events(resets("foreign"), sends({ type: "event", event: event(21) }));
    const run = s.start(["events", "--follow"]);
    await run.printed(line(21));
    expect(await stopReading(run)).toEqual({
      code: 0,
      stdout: line(21),
      stderr: "events were missed (foreign); following on from the daemon's state now\n",
    });
    expect(streams()).toEqual([
      "GET /v1/events?epoch=e1&after=7",
      "GET /v1/events?epoch=e2&after=20",
    ]);
  });

  it("prints a reset as a line of its own with --json", async () => {
    states(snapshot(), snapshot({ eventId: 30 }));
    s.daemon.events(resets("stale"));
    const run = s.start(["events", "--follow", "--json"]);
    await run.printed("\n");
    await expect(stopReading(run)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringMatching(/^\{"type":"reset","reason":"stale"\}\n/) as unknown,
      stderr: "",
    });
  });

  it("opens a dropped stream again after the last event it printed", async () => {
    states(snapshot({ epoch: "e1", eventId: 7 }));
    s.daemon.events(
      (stream) => {
        stream.send({ type: "event", event: event(8) });
        stream.close();
      },
      sends({ type: "event", event: event(9) }),
    );
    const run = s.start(["events", "--follow"]);
    await run.printed(line(9));
    expect(await stopReading(run)).toEqual({ code: 0, stdout: line(8) + line(9), stderr: "" });
    expect(streams()).toEqual([
      "GET /v1/events?epoch=e1&after=7",
      "GET /v1/events?epoch=e1&after=8",
    ]);
  });

  it("says once that the daemon went away, and follows on once it is back", async () => {
    states(snapshot({ epoch: "e1", eventId: 7 }));
    const opened = new Promise<void>((resolve) => s.daemon.events(() => resolve()));
    const run = s.start(["events", "--follow"]);
    await opened;
    await s.daemon.close();
    await run.printed("trying again");
    // Past the retries at 0.5 s and 1 s after it: still said only once.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const back = await FakeDaemon.listen(s.socket);
    try {
      back.events(sends({ type: "event", event: event(8) }));
      await run.printed(line(8));
      expect(await stopReading(run, back)).toEqual({
        code: 0,
        stdout: line(8),
        stderr: "the daemon isn't answering; trying again\n",
      });
      expect(back.routes()).toEqual(["GET /v1/events?epoch=e1&after=7"]);
    } finally {
      await back.close();
    }
  });

  it("prints the events that came in the same write as the stream's answer", async () => {
    states(snapshot({ epoch: "e1", eventId: 7 }));
    s.daemon.eventsWithTheAnswer(JSON.stringify({ type: "event", event: event(8) }));
    const run = s.start(["events", "--follow"]);
    await run.printed(line(8));
    expect(await stopReading(run)).toEqual({ code: 0, stdout: line(8), stderr: "" });
  });

  it("prints the events before a frame it can't read, then says it can't read it", async () => {
    states(snapshot());
    s.daemon.eventsWithTheAnswer(
      JSON.stringify({ type: "event", event: event(8) }),
      JSON.stringify({ type: "hello" }),
    );
    const ran = await s.bazhen(["events", "--follow"]);
    expect([ran.code, ran.stdout, ran.stderr.split(":")[0]]).toEqual([
      1,
      line(8),
      "the daemon sent an event this build can't read",
    ]);
  });

  it("prints the daemon's refusal of the stream, and exits 1", async () => {
    states(snapshot());
    s.daemon.refuseEvents(403, { error: "forbidden", message: "agents can't follow events" });
    const ran = await s.bazhen(["events", "--follow"]);
    expect(ran).toEqual({ code: 1, stdout: "", stderr: "agents can't follow events\n" });
  });

  it("exits 3 when no daemon answers", async () => {
    await s.daemon.close();
    expect(await s.bazhen(["events", "--follow"])).toEqual({
      code: 3,
      stdout: "",
      stderr: NOT_RUNNING,
    });
  });

  it("refuses no --follow, an --after not an id, and another's option, sending nothing", async () => {
    const ran = await Promise.all(
      [
        ["events"],
        ["events", "--follow", "--after", "x"],
        ["events", "--follow", "--all"],
        ["events", "--follow", "now"],
      ].map((args) => s.bazhen(args)),
    );
    expect(ran.map((r) => [r.code, r.stderr.split("\n")[0]])).toEqual([
      [2, "events takes --follow: the daemon keeps no history to list"],
      [2, "--after is an event's id, not x"],
      [2, "events takes no --all"],
      [2, "events takes no now"],
    ]);
    expect(s.daemon.received).toEqual([]);
  });
});

describe("bazhen wait", () => {
  it("exits 0 at once for an agent already in the state, opening no stream", async () => {
    states(snapshot({ agents: [reviewer("running")] }));
    expect(await s.bazhen(["wait", "reviewer", "running"])).toEqual({
      code: 0,
      stdout: `reviewer (${AGENT}) is running\n`,
      stderr: "",
    });
    expect(streams()).toEqual([]);
  });

  it("waits through events for the state, reading the state again after them", async () => {
    states(
      snapshot({ agents: [reviewer("starting")] }),
      snapshot({ agents: [reviewer("starting")] }),
      snapshot({ agents: [reviewer("running")] }),
    );
    s.daemon.events((stream) => {
      stream.send({ type: "event", event: event(2, "agent.created") });
      setTimeout(() => stream.send({ type: "event", event: event(3) }), 50);
    });
    expect(await s.bazhen(["wait", AGENT, "running"])).toEqual({
      code: 0,
      stdout: `reviewer (${AGENT}) is running\n`,
      stderr: "",
    });
  });

  it("judges again from the state a reset reads", async () => {
    states(
      snapshot({ agents: [reviewer("starting")] }),
      snapshot({ agents: [reviewer("running")] }),
    );
    s.daemon.events(resets("stale"));
    expect((await s.bazhen(["wait", "reviewer", "running"])).code).toBe(0);
  });

  it("exits 1 once the agent ends otherwise, saying what it became", async () => {
    states(
      snapshot({ agents: [reviewer("starting")] }),
      snapshot({ agents: [reviewer("closed")] }),
    );
    s.daemon.events(sends({ type: "event", event: event(2, "agent.closed") }));
    expect(await s.bazhen(["wait", "reviewer", "running"])).toEqual({
      code: 1,
      stdout: "",
      stderr: `reviewer (${AGENT}) is closed, and can't be running now\n`,
    });
  });

  it("exits 5 when the timeout runs out first, saying where it stands", async () => {
    states(snapshot({ agents: [reviewer("starting")] }));
    s.daemon.events();
    expect(await s.bazhen(["wait", "reviewer", "running", "--timeout", "1"])).toEqual({
      code: 5,
      stdout: "",
      stderr: `reviewer (${AGENT}) is starting still, after 1 s\n`,
    });
  });

  it("exits 5 on time though the stream is never quiet", async () => {
    // Each read of the state brings another event, so the stream is never found idle.
    let opened: EventStream | undefined;
    s.daemon.answerWith("GET /v1/state", StateSnapshot, () => {
      opened?.send({ type: "event", event: event(2) });
      return snapshot({ agents: [reviewer("starting")] });
    });
    s.daemon.events((stream) => {
      opened = stream;
      stream.send({ type: "event", event: event(2) });
    });
    const started = Date.now();
    const ran = await s.bazhen(["wait", "reviewer", "running", "--timeout", "1"]);
    expect([ran.code, Date.now() - started < 4000]).toEqual([5, true]);
  });

  it("exits 5 on time though the daemon never answers the stream", async () => {
    states(snapshot({ agents: [reviewer("starting")] }));
    s.daemon.hangEvents();
    const started = Date.now();
    const ran = await s.bazhen(["wait", "reviewer", "running", "--timeout", "1"]);
    expect([ran.code, Date.now() - started < 4000]).toEqual([5, true]);
  });

  it("judges again once the daemon is back, though no event says what changed", async () => {
    states(snapshot({ agents: [reviewer("starting")] }));
    const opened = new Promise<void>((resolve) => s.daemon.events(() => resolve()));
    const run = s.start(["wait", "reviewer", "running", "--timeout", "10"]);
    await opened;
    await s.daemon.close();
    const back = await FakeDaemon.listen(s.socket);
    try {
      back.answer("GET /v1/state", StateSnapshot, snapshot({ agents: [reviewer("running")] }));
      back.events();
      expect(await run.ended).toEqual({
        code: 0,
        stdout: `reviewer (${AGENT}) is running\n`,
        stderr: "",
      });
    } finally {
      await back.close();
    }
  });

  it("reads the state again only after an event on the agent or its terminal", async () => {
    let now: "starting" | "running" = "starting";
    s.daemon.answerWith("GET /v1/state", StateSnapshot, () =>
      snapshot({ agents: [agent(AGENT, "reviewer", { state: now, terminalId: TERM })] }),
    );
    s.daemon.events((stream) => {
      stream.send({ type: "event", event: event(2, "terminal.renamed", SH1) });
      setTimeout(() => {
        now = "running";
        stream.send({ type: "event", event: event(3, "terminal.ready", TERM) });
      }, 200);
    });
    const ran = await s.bazhen(["wait", "reviewer", "running", "--timeout", "5"]);
    expect([ran.code, s.daemon.calls("GET /v1/state").length]).toEqual([0, 2]);
  });

  it("waits on a shell named, for it to end, printing its record with --json", async () => {
    const build = shell(SH1, { name: "build", state: "closed" });
    states(snapshot({ shells: [shell(SH1, { name: "build" })] }), snapshot({ shells: [build] }));
    s.daemon.events(sends({ type: "event", event: event(2, "terminal.closed", SH1) }));
    const ran = await s.bazhen(["wait", "BUILD", "ended", "--json"]);
    expect([ran.code, JSON.parse(ran.stdout)]).toEqual([0, build]);
  });

  it("refuses a state its kind hasn't, a target the daemon hasn't, and a bad timeout", async () => {
    states(snapshot({ agents: [reviewer("starting")], shells: [shell(SH1)] }));
    const ran = await Promise.all(
      [
        ["wait", "reviewer", "creating"],
        ["wait", SH1, "starting"],
        ["wait", "nobody", "running"],
        ["wait", "reviewer", "running", "--timeout", "soon"],
        ["wait", "reviewer"],
      ].map((args) => s.bazhen(args)),
    );
    expect(ran.map((r) => [r.code, r.stderr.split("\n")[0]])).toEqual([
      [
        2,
        "an agent's state is starting, running, exited, unknown, lost, closing, closed, failed, or ended; not creating",
      ],
      [
        2,
        "a shell's state is creating, running, exited, unknown, lost, closing, closed, failed, or ended; not starting",
      ],
      [1, "the daemon has no agent or open shell nobody"],
      [2, "--timeout is whole seconds, not soon"],
      [2, "missing the state"],
    ]);
    expect(streams()).toEqual([]);
  });

  it("refuses a state no agent or shell has, and no timeout, before asking the daemon", async () => {
    await s.daemon.close();
    const ran = await Promise.all(
      [
        ["wait", "reviewer", "bogus"],
        ["wait", "reviewer", "running", "--timeout", "0"],
      ].map((args) => s.bazhen(args)),
    );
    expect(ran.map((r) => [r.code, r.stderr.split("\n")[0]])).toEqual([
      [
        2,
        "the state is an agent's (starting, running, exited, unknown, lost, closing, closed, failed), a shell's (creating, running, exited, unknown, lost, closing, closed, failed), or ended; not bogus",
      ],
      [2, "--timeout is at least 1 s"],
    ]);
  });

  it("exits 3 when no daemon answers", async () => {
    await s.daemon.close();
    expect((await s.bazhen(["wait", "reviewer", "running"])).code).toBe(3);
  });
});

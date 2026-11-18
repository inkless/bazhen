import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EventEnvelope, type EventEnvelopeFrame, StateSnapshot } from "@bazhen/protocol";
import { type EventStream, FakeDaemon, type Running, type Scene, scene } from "./cli.ts";
import { AGENT, snapshot } from "./fixtures.ts";

let s: Scene;
beforeEach(async () => {
  s = await scene();
});
afterEach(async () => {
  await s.cleanup();
});

const SH1 = "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c71";
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

describe("bazhen events follow", () => {
  it("prints each event a line, from the state's cursor", async () => {
    states(snapshot({ epoch: "e1", eventId: 7 }));
    s.daemon.events(
      sends(
        { type: "event", event: event(8) },
        { type: "event", event: event(9, "terminal.renamed", SH1) },
      ),
    );
    const run = s.start(["events", "follow"]);
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
    const run = s.start(["events", "follow", "--json", "--after", "2"]);
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
    const run = s.start(["events", "follow"]);
    await run.printed(line(2));
    run.stopReading();
    s.daemon.opened[0]?.send({ type: "event", event: event(3) });
    expect((await run.ended).code).toBe(0);
  });

  it("says events were missed after a reset, and follows on from the state read again", async () => {
    states(snapshot({ epoch: "e1", eventId: 7 }), snapshot({ epoch: "e2", eventId: 20 }));
    s.daemon.events(resets("foreign"), sends({ type: "event", event: event(21) }));
    const run = s.start(["events", "follow"]);
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
    const run = s.start(["events", "follow", "--json"]);
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
    const run = s.start(["events", "follow"]);
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
    const run = s.start(["events", "follow"]);
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
    const run = s.start(["events", "follow"]);
    await run.printed(line(8));
    expect(await stopReading(run)).toEqual({ code: 0, stdout: line(8), stderr: "" });
  });

  it("prints the events before a frame it can't read, then says it can't read it", async () => {
    states(snapshot());
    s.daemon.eventsWithTheAnswer(
      JSON.stringify({ type: "event", event: event(8) }),
      JSON.stringify({ type: "hello" }),
    );
    const ran = await s.bazhen(["events", "follow"]);
    expect([ran.code, ran.stdout, ran.stderr.split(":")[0]]).toEqual([
      1,
      line(8),
      "the daemon sent an event this build can't read",
    ]);
  });

  it("prints the daemon's refusal of the stream, and exits 1", async () => {
    states(snapshot());
    s.daemon.refuseEvents(403, { error: "forbidden", message: "agents can't follow events" });
    const ran = await s.bazhen(["events", "follow"]);
    expect(ran).toEqual({ code: 1, stdout: "", stderr: "agents can't follow events\n" });
  });

  it("exits 3 when no daemon answers", async () => {
    await s.daemon.close();
    expect(await s.bazhen(["events", "follow"])).toEqual({
      code: 3,
      stdout: "",
      stderr: NOT_RUNNING,
    });
  });

  it("refuses no follow, an --after not an id, and another's option, sending nothing", async () => {
    const ran = await Promise.all(
      [
        ["events"],
        ["events", "follow", "--after", "x"],
        ["events", "follow", "--all"],
        ["events", "follow", "now"],
      ].map((args) => s.bazhen(args)),
    );
    expect(ran.map((r) => [r.code, r.stderr.split("\n")[0]])).toEqual([
      [2, "events needs a verb"],
      [2, "--after is an event's id, not x"],
      [2, "events follow takes no --all"],
      [2, "events follow takes no now"],
    ]);
    expect(s.daemon.received).toEqual([]);
  });
});

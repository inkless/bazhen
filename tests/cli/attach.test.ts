import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HealthResponse, StateSnapshot } from "@bazhen/protocol";
import { type Scene, scene } from "./cli.ts";
import { AGENT, ANOTHER_BUILD, OTHER, THIRD, agent, health, snapshot } from "./fixtures.ts";

let s: Scene;
beforeEach(async () => {
  s = await scene();
});
afterEach(async () => {
  await s.cleanup();
});

const TERM = "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";

/** A fleet of three: one attachable, one on a holder no shared major reaches, one closed. */
const fleet = () =>
  snapshot({
    agents: [
      agent(AGENT, "worker", { terminalId: TERM, attachCommand: `bazhen attach ${TERM}` }),
      agent(OTHER, "stale", {
        terminalId: "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c8d",
        needsRestart: { holderPid: 4242, served: false },
      }),
      agent(THIRD, "gone", { state: "closed" }),
    ],
  });

/** `bazhen attach` with `args`, against the fleet above. */
const attach = (...args: string[]) => {
  s.daemon.answer("GET /v1/health", HealthResponse, health());
  s.daemon.answer("GET /v1/state", StateSnapshot, fleet());
  return s.bazhen(["attach", ...args]);
};

describe("bazhen attach", () => {
  it("refuses a target that names no agent, shell or terminal", async () => {
    const ran = await attach("nobody");
    expect([ran.code, ran.stderr.trim()]).toEqual([
      1,
      "no agent, shell or terminal is named nobody",
    ]);
  });

  it("refuses an agent on a holder this build can't speak to, saying to restart it", async () => {
    const ran = await attach("stale");
    expect([ran.code, ran.stderr.trim()]).toEqual([
      1,
      "stale runs on a holder this build can't speak to: restart it, then attach",
    ]);
  });

  it("finds an agent by its name in another case, as the daemon does", async () => {
    const ran = await attach("STALE");
    expect([ran.code, ran.stderr.trim()]).toEqual([
      1,
      "STALE runs on a holder this build can't speak to: restart it, then attach",
    ]);
  });

  it("refuses an agent with no running terminal", async () => {
    const ran = await attach("gone");
    expect([ran.code, ran.stderr.trim()]).toEqual([1, "gone has no running terminal to attach to"]);
  });

  it("finds an agent by name, id or terminal, and then wants a terminal to take over", async () => {
    const refusal =
      "bazhen attach takes over a terminal: run it in one, not from a pipe or a script";
    const ran = await Promise.all(["worker", AGENT, TERM].map((target) => attach(target)));
    expect(ran.map((r) => [r.code, r.stderr.trim()])).toEqual([
      [1, refusal],
      [1, refusal],
      [1, refusal],
    ]);
  });

  it("takes exactly one target, and no option but --direct and --home", async () => {
    const ran = await Promise.all([
      s.bazhen(["attach"]),
      s.bazhen(["attach", "a", "b"]),
      s.bazhen(["attach", "a", "--all"]),
    ]);
    expect(ran.map((r) => [r.code, r.stderr.split("\n")[0]])).toEqual([
      [
        2,
        "bazhen attach takes one agent, shell or terminal, and no option but --direct and --home",
      ],
      [
        2,
        "bazhen attach takes one agent, shell or terminal, and no option but --direct and --home",
      ],
      [
        2,
        "bazhen attach takes one agent, shell or terminal, and no option but --direct and --home",
      ],
    ]);
  });

  it("refuses to attach through a daemon of another build, saying to restart it", async () => {
    s.daemon.answer("GET /v1/health", HealthResponse, health({ protocolId: "f".repeat(64) }));
    const ran = await s.bazhen(["attach", "worker"]);
    expect([ran.code, ran.stderr.trim()]).toEqual([1, ANOTHER_BUILD]);
  });

  it("says the daemon isn't running when nothing answers", async () => {
    await s.daemon.close();
    const ran = await s.bazhen(["attach", "worker"]);
    expect([ran.code, ran.stderr.trim()]).toEqual([
      3,
      "bazhen is not running; start it with `bazhen start`",
    ]);
  });
});

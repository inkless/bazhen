import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HealthResponse } from "@bazhen/protocol";
import { type FakeHolder, fakeHolder, type Scene, scene } from "./cli.ts";
import { health } from "./fixtures.ts";

let s: Scene;
let holder: FakeHolder | undefined;
beforeEach(async () => {
  s = await scene();
});
afterEach(async () => {
  await holder?.close();
  holder = undefined;
  await s.cleanup();
});

const TERM = "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const NOT_A_TERMINAL =
  "bazhen attach takes over a terminal: run it in one, not from a pipe or a script";

/** A fake holder of TERM beside the scene's daemon socket, as the daemon's holders are. */
async function holding(): Promise<FakeHolder> {
  const dir = join(s.home, "run", "holders");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  holder = await fakeHolder(join(dir, `${TERM}.sock`), TERM);
  return holder;
}

describe("bazhen attach --direct", () => {
  it("asks the holder for no input while the daemon answers", async () => {
    s.daemon.answer("GET /v1/health", HealthResponse, health());
    const fake = await holding();
    const ran = await s.bazhen(["attach", TERM, "--direct"]);
    expect([ran.code, ran.stderr.trim(), fake.hellos.map((h) => h.writer)]).toEqual([
      1,
      NOT_A_TERMINAL,
      [false],
    ]);
  });

  it("asks the holder for its input when no daemon answers", async () => {
    await s.daemon.close();
    const fake = await holding();
    const ran = await s.bazhen(["attach", TERM, "--direct"]);
    expect([ran.code, ran.stderr.trim(), fake.hellos.map((h) => h.writer)]).toEqual([
      1,
      NOT_A_TERMINAL,
      [true],
    ]);
  });

  it("goes straight to the holder of a terminal id when no daemon answers, without --direct", async () => {
    await s.daemon.close();
    const fake = await holding();
    const ran = await s.bazhen(["attach", TERM]);
    expect([ran.code, ran.stderr.trim().split("\n"), fake.hellos.map((h) => h.writer)]).toEqual([
      1,
      ["bazhen is not running: attaching straight to the terminal's holder", NOT_A_TERMINAL],
      [true],
    ]);
  });

  it("says the daemon isn't running for a name, which only it can resolve", async () => {
    await s.daemon.close();
    const ran = await s.bazhen(["attach", "worker"]);
    expect([ran.code, ran.stderr.trim()]).toEqual([
      3,
      "bazhen is not running; start it with `bazhen start`",
    ]);
  });

  it("takes a terminal id only", async () => {
    const ran = await s.bazhen(["attach", "worker", "--direct"]);
    expect([ran.code, ran.stderr.trim()]).toEqual([
      2,
      "bazhen attach --direct takes a terminal id: names are the daemon's to resolve",
    ]);
  });

  it("says no holder answers for a terminal that has none", async () => {
    s.daemon.answer("GET /v1/health", HealthResponse, health());
    const ran = await s.bazhen(["attach", TERM, "--direct"]);
    expect([ran.code, ran.stderr]).toEqual([
      1,
      expect.stringContaining(
        `no holder answers for ${TERM} at ${s.home}/run/holders/${TERM}.sock`,
      ),
    ]);
  });
});

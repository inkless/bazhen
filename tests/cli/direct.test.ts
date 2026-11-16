import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeHolder, fakeHolder, type Scene, scene } from "./cli.ts";

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
  it("wants a terminal before it says a word to the holder, so a pipe never holds its input", async () => {
    await s.daemon.close();
    const fake = await holding();
    const ran = await s.bazhen(["attach", TERM, "--direct"]);
    expect([ran.code, ran.stderr.trim(), fake.hellos]).toEqual([1, NOT_A_TERMINAL, []]);
  });

  it("goes straight to the holder of a terminal id when no daemon is there, without --direct", async () => {
    await s.daemon.close();
    const fake = await holding();
    const ran = await s.bazhen(["attach", TERM]);
    expect([ran.code, ran.stderr.trim().split("\n"), fake.hellos]).toEqual([
      1,
      ["bazhen is not running: attaching straight to the terminal's holder", NOT_A_TERMINAL],
      [],
    ]);
  });

  it("won't go around a daemon that listens but doesn't answer, saying --direct can view", async () => {
    s.daemon.hang("GET /v1/health");
    const fake = await holding();
    const ran = await s.bazhen(["attach", TERM]);
    expect([ran.code, ran.stderr.trim(), fake.hellos]).toEqual([
      3,
      "the daemon doesn't answer, but may be running (something listens on its socket), so " +
        `attach won't go around it: \`bazhen attach --direct ${TERM}\` can view the terminal`,
      [],
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
});

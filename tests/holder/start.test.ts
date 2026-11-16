// Starting a real holder the way the daemon does, through host-guard's startHolder.

import { connectHolder } from "@bazhen/runtime-holder";
import { afterEach, describe, expect, it } from "vitest";
import { closeHolder, type SpawnedHolder, spawnHolder } from "../support/holder-spawn.ts";

const running: SpawnedHolder[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((holder) => closeHolder(holder)));
});

async function exitOf(holder: SpawnedHolder) {
  const client = await connectHolder(holder.socket, { onEvent: () => {} });
  try {
    return client.hello.exit;
  } finally {
    client.end();
  }
}

describe("starting a holder", () => {
  it("runs the spec's program from the spec's PATH, with nothing in the holder's own env", async () => {
    const holder = await spawnHolder("bare", ["sh", "-c", "exit 7"], { bareHolder: true });
    running.push(holder);
    await expect.poll(() => exitOf(holder)).toEqual({ type: "exited", code: 7 });
  });

  it("fails with the holder's own exit code and reason for a spec it refuses", async () => {
    const refused = spawnHolder("nul", ["sh", "-c", "a\0b"]);
    await expect(refused).rejects.toMatchObject({
      ending: { code: 2 },
      stderr: expect.stringContaining("NUL"),
    });
  });
});

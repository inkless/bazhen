import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Daemon, waitUntil } from "./daemon.ts";
import { readKeyLog } from "../support/key-log.ts";

const probe = fileURLToPath(new URL("../support/key-probe.ts", import.meta.url));
const ECHO_MS = 300;

let daemon: Daemon;
beforeAll(async () => {
  daemon = await Daemon.start({ runtime: "tmux" });
});
afterAll(async () => {
  await daemon?.stop();
});

/** When the probe first received a chunk holding `matches`, or never. */
function arrivedAt(log: string, matches: (bytes: Buffer) => boolean): number | undefined {
  return readKeyLog(log).find((a) => matches(Buffer.from(a.hex, "hex")))?.at;
}

describe("a prompt typed through a view", () => {
  it("is submitted only once the program has drawn it, though the screen showed it before", async () => {
    const log = join(daemon.work, "prompt.log");
    const program = await daemon.program([
      process.execPath,
      probe,
      log,
      "--lines=1",
      `--echo-after=${ECHO_MS}`,
    ]);
    await waitUntil(
      () => daemon.screen(program.agentId).includes("key-probe ready"),
      "the key probe",
    );
    await daemon.prompt(program, "line 1");
    await expect.poll(() => arrivedAt(log, (b) => b.includes("\r"))).toBeDefined();
    const typed = Number(arrivedAt(log, (b) => b.includes("line 1")));
    const entered = Number(arrivedAt(log, (b) => b.includes("\r")));
    expect(entered - typed).toBeGreaterThanOrEqual(ECHO_MS);
  });
});

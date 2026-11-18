import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { Daemon, waitUntil } from "./daemon.ts";

const probe = fileURLToPath(new URL("../support/upgrade-probe.ts", import.meta.url));
const PROBE_OUT = "upgrade-probe.txt";
const probeOut = (daemon: Daemon) => `${daemon.work}/${PROBE_OUT}`;
/** What the probe has received so far, empty until its first chunk. */
const answered = (daemon: Daemon) => daemon.workFile(PROBE_OUT) ?? "";

describe.each([
  { pairing: "auto", env: {} },
  { pairing: "always", env: { BAZHEN_PAIRING: "always" } },
])("a terminal's stream on the daemon's socket, with web.pairing = $pairing", ({ env }) => {
  let daemon: Daemon;
  let ids: { agentId: string; terminalId: string };
  beforeAll(async () => {
    daemon = await Daemon.start({ runtime: "tmux", env });
    ids = await daemon.program(["sh", "-c", "exec sleep 600"]);
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  // tmux runs a respawned pane's process as the runtime's own, in a pane the daemon recorded for
  // another process.
  it("refuses a process Bazhen's runtime runs in no agent's or shell's terminal, by its process", async () => {
    const route = `/v1/terminals/${ids.terminalId}/stream`;
    const { agentId } = await daemon.program(["sleep", "300"]);
    daemon.runInTerminal(agentId, [
      process.execPath,
      probe,
      daemon.socket,
      route,
      probeOut(daemon),
    ]);
    await waitUntil(() => answered(daemon).includes("\r\n\r\n"), "the probe's answer");
    expect(answered(daemon).split("\r\n\r\n")).toEqual([
      expect.stringMatching(/^HTTP\/1\.1 403 Forbidden\r\n/),
      JSON.stringify({
        error: "forbidden",
        message: "the caller runs under Bazhen's runtime, in no terminal",
      }),
    ]);
  });
});

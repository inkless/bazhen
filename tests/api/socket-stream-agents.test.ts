import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { SendMessageResponse, StateSnapshot } from "@bazhen/protocol";
import { Daemon, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";
import { outcome } from "./upgrade-outcome.ts";

const probe = fileURLToPath(new URL("../support/upgrade-probe.ts", import.meta.url));
const PROBE_OUT = "upgrade-probe.txt";
const probeOut = (daemon: Daemon) => `${daemon.work}/${PROBE_OUT}`;
/** The open attention item whose summary names `text`, if one is open. */
const openItemNaming = async (daemon: Daemon, text: string) =>
  StateSnapshot.parse((await daemon.request("/v1/state")).body)
    .attention.filter((a) => a.state === "open")
    .find((a) => a.summary.includes(text))?.id;
/** What the probe has received so far, empty until its first chunk. */
const answered = (daemon: Daemon) => daemon.workFile(PROBE_OUT) ?? "";

describe.each([
  { pairing: "auto", env: {} },
  { pairing: "always", env: { BAZHEN_PAIRING: "always" } },
])("a terminal's stream on the daemon's socket, with web.pairing = $pairing", ({ env }) => {
  let daemon: Daemon;
  let ids: { agentId: string; terminalId: string };
  beforeAll(async () => {
    daemon = await Daemon.start({ env });
    ids = await daemon.program(["sh", "-c", "echo on-the-socket; exec sleep 600"]);
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  const onSocket = () => `ws+unix://${daemon.socket}:/v1/terminals/${ids.terminalId}/stream`;

  it("refuses the terminal's own agent, by the token it runs with", async () => {
    const token = await daemon.agentToken(ids.agentId);
    expect(await outcome(onSocket(), { "bazhen-agent-token": token })).toEqual([
      403,
      "an agent can't open a stream",
    ]);
  });

  it("opens the human the event stream, and refuses it the terminal's agent", async () => {
    const { epoch } = StateSnapshot.parse((await daemon.request("/v1/state")).body);
    const events = `ws+unix://${daemon.socket}:/v1/events?epoch=${encodeURIComponent(epoch)}&after=0`;
    const token = await daemon.agentToken(ids.agentId);
    expect([await outcome(events), await outcome(events, { "bazhen-agent-token": token })]).toEqual(
      ["open", [403, "an agent can't open a stream"]],
    );
  });
});

describe("a process an agent runs, asking for a terminal's stream on the socket", () => {
  let model: FakeModel;
  let daemon: Daemon;
  beforeAll(async () => {
    model = await startFakeModel();
    daemon = await Daemon.start({ modelUrl: model.url });
  });
  afterAll(async () => {
    await daemon?.stop();
    await model?.close();
  });

  it("is refused as the agent by its process tree alone, presenting nothing", async () => {
    const target = await daemon.program(["sh", "-c", "exec sleep 600"]);
    const { agentId } = await daemon.launch("asker");
    await waitUntil(
      async () => (await daemon.screen(agentId)).includes("Claude Code"),
      "Claude Code's TUI",
    );
    const route = `/v1/terminals/${target.terminalId}/stream`;
    const command = `${process.execPath} ${probe} ${daemon.socket} ${route} ${probeOut(daemon)}`;
    SendMessageResponse.parse(
      (
        await daemon.request(`/v1/agents/${agentId}/messages`, {
          method: "POST",
          body: { idempotencyKey: "probe", body: `[[fake:bash:${command}]]` },
        })
      ).body,
    );
    const asked = () => openItemNaming(daemon, probe);
    await waitUntil(async () => (await asked()) !== undefined, "the agent asking to run the probe");
    await daemon.request(`/v1/attention/${String(await asked())}/answer`, {
      method: "POST",
      body: { idempotencyKey: "allow", decision: "allow" },
    });
    await waitUntil(() => answered(daemon).includes("\r\n\r\n"), "the probe's answer");
    expect(answered(daemon).split("\r\n\r\n")).toEqual([
      expect.stringMatching(/^HTTP\/1\.1 403 Forbidden\r\n/),
      JSON.stringify({ error: "forbidden", message: "an agent can't open a stream" }),
    ]);
  });
});

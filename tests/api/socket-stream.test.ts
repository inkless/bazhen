import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { SendMessageResponse, StateSnapshot } from "@bazhen/protocol";
import { Daemon, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";

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

/** How an upgrade to `url` went: "open", or the status and message it was refused with. */
const outcome = (url: string, headers: Record<string, string> = {}) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => {
      resolve("open");
      ws.close();
    });
    ws.once("unexpected-response", (_q, res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      res.on("end", () => resolve([res.statusCode, body === "" ? null : JSON.parse(body).message]));
    });
    ws.once("error", reject);
  });

describe.each([
  { pairing: "auto", env: {}, unpaired: "open" },
  { pairing: "always", env: { BAZHEN_PAIRING: "always" }, unpaired: [401, null] },
])(
  "a terminal's stream on the daemon's socket, with web.pairing = $pairing",
  ({ env, unpaired }) => {
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

    it("attaches the human, who sees the terminal as a browser does", async () => {
      const view = await daemon.socketView(ids.terminalId, "interactive");
      await view.attached();
      await waitUntil(() => view.output().includes("on-the-socket"), "the program's output");
      view.close();
      expect(view.frames.map((f) => f.type)).toContain("attached");
    });

    it("refuses the terminal's own agent, by the token it runs with", async () => {
      const token = daemon.agentToken(ids.agentId);
      expect(await outcome(onSocket(), { "bazhen-agent-token": token })).toEqual([
        403,
        "an agent can't attach to a terminal",
      ]);
    });

    it("refuses a process Bazhen's runtime runs in no agent's or shell's terminal, by its process", async () => {
      const route = `/v1/terminals/${ids.terminalId}/stream`;
      await daemon.program([process.execPath, probe, daemon.socket, route, probeOut(daemon)]);
      await waitUntil(() => answered(daemon).includes("\r\n\r\n"), "the probe's answer");
      expect(answered(daemon).split("\r\n\r\n")).toEqual([
        expect.stringMatching(/^HTTP\/1\.1 403 Forbidden\r\n/),
        JSON.stringify({
          error: "forbidden",
          message: "the caller runs under Bazhen's runtime, in no terminal",
        }),
      ]);
    });

    it("leaves the loopback port's Host, Origin and pairing guard as they were", async () => {
      const overTcp = `${daemon.url.replace("http", "ws")}/v1/terminals/${ids.terminalId}/stream`;
      expect([
        await outcome(overTcp, { host: "evil.example", origin: daemon.url }),
        await outcome(overTcp, { origin: "http://evil.example" }),
        await outcome(overTcp, { origin: daemon.url }),
      ]).toEqual([[421, null], [403, null], unpaired]);
    });
  },
);

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
    await waitUntil(() => daemon.screen(agentId).includes("Claude Code"), "Claude Code's TUI");
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
      JSON.stringify({ error: "forbidden", message: "an agent can't attach to a terminal" }),
    ]);
  });
});

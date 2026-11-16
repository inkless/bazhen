import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Daemon, waitUntil } from "./daemon.ts";

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

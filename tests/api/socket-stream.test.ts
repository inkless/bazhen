import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Daemon, waitUntil } from "./daemon.ts";
import { outcome } from "./upgrade-outcome.ts";

describe.each([
  { pairing: "auto", env: {}, unpaired: "open" },
  { pairing: "always", env: { BAZHEN_PAIRING: "always" }, unpaired: [401, null] },
])(
  "a terminal's stream on the daemon's socket, with web.pairing = $pairing",
  ({ env, unpaired }) => {
    let daemon: Daemon;
    let ids: { terminalId: string };
    beforeAll(async () => {
      daemon = await Daemon.start({ env });
      ids = await daemon.shellProgram(["sh", "-c", "echo on-the-socket; exec sleep 600"]);
    });
    afterAll(async () => {
      await daemon?.stop();
    });

    it("attaches the human, who sees the terminal as a browser does", async () => {
      const view = await daemon.socketView(ids.terminalId, "interactive");
      await view.attached();
      await waitUntil(() => view.output().includes("on-the-socket"), "the program's output");
      view.close();
      expect(view.frames.map((f) => f.type)).toContain("attached");
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

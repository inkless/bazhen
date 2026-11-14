import { describe, expect, it } from "vitest";
import { answer, NO_FRAMING, refuseUpgrade, servesHere } from "./loopback.ts";

/** Whether a request from a page at `origin` is answered. */
const at = (origin: string) => servesHere({ host: "127.0.0.1:7901", origin }, 7901);

/** Whether a page of the given fetch destination is answered. */
const loading = (dest: string) =>
  servesHere({ host: "127.0.0.1:7901", "sec-fetch-dest": dest }, 7901);

/** What a request leaves behind: the headers set, the status, and whether the app's own handlers ran. */
const through = (headers: Record<string, string>) => {
  const sent: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string) => (sent[name] = value),
    end: () => undefined,
  };
  let passed = false;
  answer(headers, res, 7901, () => (passed = true));
  return {
    csp: sent["content-security-policy"],
    frame: sent["x-frame-options"],
    status: res.statusCode,
    passed,
  };
};

describe("the web dev server's own-machine check", () => {
  it("answers a loopback Host on its own port", () => {
    expect([
      servesHere({ host: "127.0.0.1:7901" }, 7901),
      servesHere({ host: "localhost:7901" }, 7901),
    ]).toEqual([true, true]);
  });

  it("refuses another host, an IP address included, and loopback on another port", () => {
    const hosts = ["192.168.1.20:7901", "192.168.1.20", "bazhen.example.com", "localhost:7900"];
    expect(hosts.map((host) => servesHere({ host }, 7901))).toEqual(hosts.map(() => false));
  });

  it("refuses a request any proxy header marks as forwarded", () => {
    const names = ["via", "x-real-ip", "x-forwarded-host", "x-forwarded-proto"];
    expect(names.map((name) => servesHere({ host: "127.0.0.1:7901", [name]: "x" }, 7901))).toEqual(
      names.map(() => false),
    );
  });

  it("answers its own page's requests, and refuses a page from anywhere else", () => {
    expect([
      at("http://127.0.0.1:7901"),
      at("http://localhost:7901"),
      at("https://bazhen.example.com"),
      at("http://127.0.0.1:7900"),
      at("null"),
    ]).toEqual([true, true, false, false, false]);
  });

  it("refuses a page another page embeds, and serves the same page opened on its own", () => {
    expect(["iframe", "frame", "embed", "object"].map(loading)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(["document", "script", "empty"].map(loading)).toEqual([true, true, true]);
  });

  it("refuses a request a proxy forwarded, even one presenting a loopback Host", () => {
    expect([
      servesHere({ host: "127.0.0.1:7901", "x-forwarded-for": "192.168.1.30" }, 7901),
      servesHere({ host: "127.0.0.1:7901", "x-forwarded-for": "127.0.0.1" }, 7901),
      servesHere({ host: "127.0.0.1:7901", forwarded: "for=192.168.1.30" }, 7901),
      servesHere({}, 7901),
    ]).toEqual([false, false, false, false]);
  });
});

describe("refusing an upgrade the dev server shouldn't answer", () => {
  it("points it where no later listener proxies or answers it, and closes the socket", () => {
    const req = { url: "/v1/agents/agent_1/stream" };
    let destroyed = false;
    refuseUpgrade(req, { destroy: () => (destroyed = true) });
    expect([req.url.startsWith("/v1"), req.url === "/", destroyed]).toEqual([false, false, true]);
  });
});

describe("the web dev server's first middleware", () => {
  it("forbids framing on a request it passes on and on one it refuses", () => {
    expect([through({ host: "127.0.0.1:7901" }), through({ host: "192.168.1.20:7901" })]).toEqual([
      { csp: NO_FRAMING, frame: "DENY", status: 200, passed: true },
      { csp: NO_FRAMING, frame: "DENY", status: 403, passed: false },
    ]);
  });
});

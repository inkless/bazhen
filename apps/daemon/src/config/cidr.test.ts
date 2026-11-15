import { describe, expect, it } from "vitest";
import { admitted, localSubnets, pairingKey, parseCidr } from "./cidr.ts";

const ranges = (...texts: string[]) =>
  texts.map((t) => {
    const r = parseCidr(t);
    if (r === undefined) throw new Error(t);
    return r;
  });

describe("an address range", () => {
  it("parses IPv4 and IPv6 ranges, and refuses what isn't one", () => {
    expect(
      ["192.168.1.0/24", "fe80::/10", "::/0", "10.0.0.1/32"].map((t) => parseCidr(t) !== undefined),
    ).toEqual([true, true, true, true]);
    expect(
      [
        "192.168.1.0",
        "192.168.1.0/33",
        "256.0.0.0/8",
        "fe80::/129",
        "1::2::3/64",
        "192.168.01.0/24",
        "a/1",
      ].map((t) => parseCidr(t)),
    ).toEqual(Array(7).fill(undefined));
  });

  it("admits an address inside it and nothing just outside", () => {
    const allow = ranges("192.168.1.0/24", "fdeb:9f4b:2183:4c5b::/64");
    expect(
      [
        "192.168.1.30",
        "192.168.2.30",
        "fdeb:9f4b:2183:4c5b:69b3:6800:1294:d29e",
        "fdeb:9f4b:2183:4c5c::1",
        undefined,
        "not an address",
      ].map((peer) => admitted(allow, peer)),
    ).toEqual([true, false, true, false, false, false]);
  });

  it("compares an IPv4 peer a dual-stack socket reports as ::ffff: as IPv4", () => {
    expect([
      admitted(ranges("127.0.0.0/8"), "::ffff:127.0.0.1"),
      admitted(ranges("::ffff:0:0/96"), "::ffff:127.0.0.1"),
    ]).toEqual([true, false]);
  });

  it("admits a link-local peer whatever its zone", () => {
    expect(admitted(ranges("fe80::/10"), "fe80::913:71f0:4c3:c6ec%eno1")).toBe(true);
  });
});

describe("the key pairing attempts are counted under", () => {
  it("is an IPv4 peer's address, and an IPv6 peer's /64", () => {
    expect([
      pairingKey("::ffff:192.168.1.30"),
      pairingKey("fdeb:9f4b:2183:4c5b:69b3:6800:1294:d29e"),
      pairingKey("fdeb:9f4b:2183:4c5b::1"),
    ]).toEqual(["192.168.1.30", "fdeb:9f4b:2183:4c5b::/64", "fdeb:9f4b:2183:4c5b::/64"]);
  });
});

describe("the subnets suggested for web.lan_allow", () => {
  it("are each interface's network, with link-local IPv6 once, and no loopback", () => {
    expect(
      localSubnets({
        lo: [{ family: "IPv4", cidr: "127.0.0.1/8", internal: true }],
        eno1: [
          { family: "IPv4", cidr: "192.168.1.126/24", internal: false },
          { family: "IPv6", cidr: "fdeb:9f4b:2183:4c5b:366c:61b3:4eb8:cbe3/64", internal: false },
          { family: "IPv6", cidr: "fdeb:9f4b:2183:4c5b:86a5:d35a:c904:d29e/64", internal: false },
          { family: "IPv6", cidr: "fe80::913:71f0:4c3:c6ec/64", internal: false },
        ],
        docker0: [{ family: "IPv4", cidr: "172.17.0.1/16", internal: false }],
        wlan0: [{ family: "IPv6", cidr: "fe80::1/64", internal: false }],
      }),
    ).toEqual([
      { interface: "eno1", cidr: "192.168.1.0/24" },
      { interface: "eno1", cidr: "fdeb:9f4b:2183:4c5b::/64" },
      { interface: "link-local", cidr: "fe80::/10" },
      { interface: "docker0", cidr: "172.17.0.0/16" },
    ]);
  });
});

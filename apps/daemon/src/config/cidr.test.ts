import { describe, expect, it } from "vitest";
import { admitted, localSubnets, pairingKey, parseCidr, parseRange } from "./cidr.ts";

const ranges = (...texts: string[]) =>
  texts.map((t) => {
    const r = parseCidr(t);
    if (r === undefined) throw new Error(t);
    return r;
  });
const problem = (text: string) => {
  const parsed = parseRange(text);
  return "problem" in parsed ? parsed.problem : null;
};

describe("an address range", () => {
  it("parses IPv4, IPv6 and interface-scoped link-local ranges", () => {
    expect(
      ["192.168.1.0/24", "fdeb:9f4b:2183:4c5b::/64", "fe80::/10%eno1", "10.0.0.1/32"].map(
        (t) => parseCidr(t) !== undefined,
      ),
    ).toEqual([true, true, true, true]);
  });

  it("refuses what isn't a range", () => {
    expect(
      [
        "192.168.1.0",
        "192.168.1.0/33",
        "256.0.0.0/8",
        "fe80::/129",
        "1::2::3/64",
        "192.168.01.0/24",
        "a/1",
        "1.2.3.4::/32",
        "fe80::%eno1/10",
      ].map((t) => parseCidr(t)),
    ).toEqual(Array(9).fill(undefined));
  });

  it("refuses a range that admits every address", () => {
    expect([problem("0.0.0.0/0"), problem("::/0")]).toEqual([
      "admits every address; list your own network's range",
      "admits every address; list your own network's range",
    ]);
  });

  it("refuses link-local without its interface, and an interface on anything else", () => {
    expect([
      problem("fe80::/10"),
      problem("fe80::/64"),
      problem("fc00::/6"),
      problem("192.168.1.0/24%eno1"),
      problem("fdeb:9f4b:2183:4c5b::/64%eno1"),
    ]).toEqual([
      "is link-local, so it needs its interface, such as fe80::/10%eno1",
      "is link-local, so it needs its interface, such as fe80::/10%eno1",
      "covers link-local addresses on every interface",
      "names an interface, which only link-local takes",
      "names an interface, which only link-local takes",
    ]);
  });

  it("refuses an IPv4 range written as IPv6, which no peer would match", () => {
    expect(problem("::ffff:192.168.1.0/120")).toBe(
      "is IPv4 written as IPv6, which no peer is compared as; list the IPv4 range",
    );
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
    expect(admitted(ranges("127.0.0.0/8"), "::ffff:127.0.0.1")).toBe(true);
  });

  it("admits a link-local peer on the range's interface only", () => {
    const allow = ranges("fe80::/10%eno1");
    expect(
      ["fe80::913:71f0:4c3:c6ec%eno1", "fe80::913:71f0:4c3:c6ec%wlan0", "fe80::1"].map((peer) =>
        admitted(allow, peer),
      ),
    ).toEqual([true, false, false]);
  });
});

describe("the key pairing attempts are counted under", () => {
  it("is an IPv4 peer's address, an IPv6 peer's /64, and a link-local peer's own address", () => {
    expect([
      pairingKey("::ffff:192.168.1.30"),
      pairingKey("fdeb:9f4b:2183:4c5b:69b3:6800:1294:d29e"),
      pairingKey("fdeb:9f4b:2183:4c5b::1"),
      pairingKey("fe80::1%eno1"),
      pairingKey("fe80::2%eno1"),
    ]).toEqual([
      "192.168.1.30",
      "fdeb:9f4b:2183:4c5b::/64",
      "fdeb:9f4b:2183:4c5b::/64",
      "fe80::1%eno1",
      "fe80::2%eno1",
    ]);
  });
});

describe("the subnets suggested for web.lan_allow", () => {
  it("are each interface's network once, link-local once per interface, and no loopback", () => {
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
      { interface: "eno1", cidr: "fe80::/10%eno1" },
      { interface: "docker0", cidr: "172.17.0.0/16" },
      { interface: "wlan0", cidr: "fe80::/10%wlan0" },
    ]);
  });
});

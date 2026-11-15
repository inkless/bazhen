/**
 * An address range, as `web.lan_allow` lists it: IPv4 or IPv6, held as a number and a length. A
 * link-local range is on one interface, its `zone`: the same addresses exist on every link.
 */
export interface Cidr {
  readonly v6: boolean;
  readonly base: bigint;
  readonly bits: number;
  readonly zone?: string;
}

interface Address {
  readonly v6: boolean;
  readonly value: bigint;
  readonly zone?: string;
}

function ipv4(text: string): bigint | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255) return undefined;
    value = (value << 8n) | BigInt(part);
  }
  return value;
}

/**
 * The 16-bit groups of one side of an IPv6 address's `::`. A trailing IPv4 part counts as two,
 * and only where it ends the whole address.
 */
function groups(half: string, endsAddress: boolean): bigint[] | undefined {
  if (half === "") return [];
  const out: bigint[] = [];
  const parts = half.split(":");
  for (const [i, part] of parts.entries()) {
    if (endsAddress && i === parts.length - 1 && part.includes(".")) {
      const v4 = ipv4(part);
      if (v4 === undefined) return undefined;
      out.push(v4 >> 16n, v4 & 0xffffn);
    } else if (/^[0-9a-f]{1,4}$/i.test(part)) out.push(BigInt(`0x${part}`));
    else return undefined;
  }
  return out;
}

function ipv6(text: string): bigint | undefined {
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const [first = "", second] = halves;
  const head = groups(first, second === undefined);
  const tail = second === undefined ? [] : groups(second, true);
  if (head === undefined || tail === undefined) return undefined;
  const missing = 8 - head.length - tail.length;
  if (second === undefined ? missing !== 0 : missing < 1) return undefined;
  const all = [...head, ...Array<bigint>(second === undefined ? 0 : missing).fill(0n), ...tail];
  return all.reduce((value, group) => (value << 16n) | group, 0n);
}

/** An address as a socket reports it, with its `%zone` if it has one; undefined if it isn't one. */
function parseAddress(raw: string): Address | undefined {
  const [text = "", zone, ...rest] = raw.split("%");
  if (rest.length > 0 || zone === "") return undefined;
  const v6 = text.includes(":");
  const value = v6 ? ipv6(text) : ipv4(text);
  if (value === undefined || (zone !== undefined && !v6)) return undefined;
  return zone === undefined ? { v6, value } : { v6, value, zone };
}

const mask = (v6: boolean, bits: number) => {
  const width = v6 ? 128n : 32n;
  return ((1n << width) - 1n) ^ ((1n << (width - BigInt(bits))) - 1n);
};

const LINK_LOCAL = { base: 0xfe80n << 112n, bits: 10 };
const isLinkLocal = (a: { v6: boolean; value: bigint }) =>
  a.v6 && (a.value & mask(true, LINK_LOCAL.bits)) === LINK_LOCAL.base;
const MAPPED_V4 = 0xffffn << 32n;
const isMapped = (a: { v6: boolean; value: bigint }) => a.v6 && a.value >> 32n === 0xffffn;

/**
 * A range like `192.168.1.0/24`, `fdeb:9f4b:2183:4c5b::/64` or `fe80::/10%eno1`, or why it
 * can't be one `web.lan_allow` admits.
 */
export function parseRange(text: string): { range: Cidr } | { problem: string } {
  const match = /^([^/%]+)\/(0|[1-9][0-9]{0,2})(?:%([A-Za-z0-9_.-]+))?$/.exec(text);
  const address = match?.[1] === undefined ? undefined : parseAddress(match[1]);
  if (match === null || address === undefined) {
    return { problem: "is not a range, such as 192.168.1.0/24" };
  }
  const bits = Number(match[2]);
  const zone = match[3];
  if (bits > (address.v6 ? 128 : 32)) return { problem: "is longer than an address" };
  if (bits === 0) return { problem: "admits every address; list your own network's range" };
  const base = address.value & mask(address.v6, bits);
  const range = { v6: address.v6, base, bits };
  const network = { v6: address.v6, value: base };
  if (isMapped(network) && bits >= 96) {
    return {
      problem: "is IPv4 written as IPv6, which no peer is compared as; list the IPv4 range",
    };
  }
  if (address.v6 && bits < LINK_LOCAL.bits && (LINK_LOCAL.base & mask(true, bits)) === base) {
    return { problem: "covers link-local addresses on every interface" };
  }
  if (isLinkLocal(network)) {
    if (zone === undefined) {
      return { problem: "is link-local, so it needs its interface, such as fe80::/10%eno1" };
    }
    // A peer's zone is reported by interface name, so a numeric zone would never match one.
    if (/^[0-9]+$/.test(zone))
      return { problem: "names its interface by number; use its name, such as eno1" };
    return { range: { ...range, zone } };
  }
  if (zone !== undefined) return { problem: "names an interface, which only link-local takes" };
  return { range };
}

export function parseCidr(text: string): Cidr | undefined {
  const parsed = parseRange(text);
  return "range" in parsed ? parsed.range : undefined;
}

/**
 * A peer's address as compared: an IPv4 address that a dual-stack socket reports as
 * `::ffff:a.b.c.d` is the IPv4 address it is.
 */
function normalise(raw: string): Address | undefined {
  const parsed = parseAddress(raw);
  if (parsed !== undefined && isMapped(parsed))
    return { v6: false, value: parsed.value ^ MAPPED_V4 };
  return parsed;
}

/** Whether a peer's address is inside any of the ranges, on the same interface for link-local. */
export function admitted(ranges: readonly Cidr[], peer: string | undefined): boolean {
  const address = peer === undefined ? undefined : normalise(peer);
  if (address === undefined) return false;
  return ranges.some(
    (r) =>
      r.v6 === address.v6 &&
      (address.value & mask(r.v6, r.bits)) === r.base &&
      r.zone === (isLinkLocal(address) ? address.zone : undefined),
  );
}

/**
 * What pairing attempts from a peer are counted under: its IPv4 address; its IPv6 /64, since one
 * host can take any address in its network; or, on link-local, where every device shares fe80::/64,
 * its whole address on its interface.
 */
export function pairingKey(peer: string | undefined): string {
  const address = peer === undefined ? undefined : normalise(peer);
  if (address === undefined) return "unknown";
  if (!address.v6) return format(address.value, false);
  if (isLinkLocal(address)) return `${format(address.value, true)}%${address.zone ?? ""}`;
  return `${format(address.value & mask(true, 64), true)}/64`;
}

/**
 * One device, for sharing connections out: its own address, with its interface on link-local. An
 * IPv6 network's devices all sit in one /64, so pairingKey's /64 would make them share.
 */
export function peerKey(peer: string | undefined): string {
  const address = peer === undefined ? undefined : normalise(peer);
  if (address === undefined) return "unknown";
  const text = format(address.value, address.v6);
  return isLinkLocal(address) ? `${text}%${address.zone ?? ""}` : text;
}

function format(value: bigint, v6: boolean): string {
  if (!v6) return [24n, 16n, 8n, 0n].map((s) => String((value >> s) & 0xffn)).join(".");
  const hex = Array.from({ length: 8 }, (_, i) =>
    ((value >> BigInt((7 - i) * 16)) & 0xffffn).toString(16),
  );
  let best = { at: -1, length: 1 };
  for (let i = 0; i < 8; i++) {
    let j = i;
    while (j < 8 && hex[j] === "0") j++;
    if (j - i > best.length) best = { at: i, length: j - i };
  }
  if (best.at < 0) return hex.join(":");
  const head = hex.slice(0, best.at).join(":");
  const tail = hex.slice(best.at + best.length).join(":");
  return `${head}::${tail}`;
}

/** One network interface's address, as `os.networkInterfaces()` lists it. */
export interface InterfaceAddress {
  readonly family: string;
  readonly cidr: string | null;
  readonly internal: boolean;
}

/**
 * The ranges this host's interfaces are on, each with its interface, for suggesting a
 * `web.lan_allow`: each network once, and link-local once per interface, with its zone.
 */
export function localSubnets(
  interfaces: Readonly<Record<string, readonly InterfaceAddress[] | undefined>>,
): { interface: string; cidr: string }[] {
  const seen = new Set<string>();
  const out: { interface: string; cidr: string }[] = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    // Only a name a range can carry as its zone; parseRange takes no other.
    const zoneable = /^[A-Za-z0-9_.-]+$/.test(name) && !/^[0-9]+$/.test(name);
    for (const a of addresses ?? []) {
      if (a.internal || a.cidr === null) continue;
      const [text = "", length = ""] = a.cidr.split("/");
      const address = parseAddress(text);
      const bits = Number(length);
      if (address === undefined || !Number.isInteger(bits)) continue;
      if (isLinkLocal(address) && !zoneable) continue;
      const cidr = isLinkLocal(address)
        ? `fe80::/10%${name}`
        : `${format(address.value & mask(address.v6, bits), address.v6)}/${bits}`;
      if (seen.has(cidr)) continue;
      seen.add(cidr);
      out.push({ interface: name, cidr });
    }
  }
  return out;
}

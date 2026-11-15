/** An address range, as `web.lan_allow` lists it: IPv4 or IPv6, held as a number and a length. */
export interface Cidr {
  readonly v6: boolean;
  readonly base: bigint;
  readonly bits: number;
}

/** An address as a number, or undefined if it isn't one; a `%zone` is dropped. */
function parseAddress(raw: string): { v6: boolean; value: bigint } | undefined {
  const text = raw.split("%")[0] ?? "";
  if (!text.includes(":")) {
    const value = ipv4(text);
    return value === undefined ? undefined : { v6: false, value };
  }
  const value = ipv6(text);
  return value === undefined ? undefined : { v6: true, value };
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

/** The 16-bit groups on one side of an IPv6 address's `::`; a trailing IPv4 part counts as two. */
function groups(half: string | undefined): bigint[] | undefined {
  if (half === undefined || half === "") return [];
  const out: bigint[] = [];
  const parts = half.split(":");
  for (const [i, part] of parts.entries()) {
    if (i === parts.length - 1 && part.includes(".")) {
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
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  if (head === undefined || tail === undefined) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const all = [...head, ...Array<bigint>(halves.length === 1 ? 0 : missing).fill(0n), ...tail];
  return all.reduce((value, group) => (value << 16n) | group, 0n);
}

const mask = (v6: boolean, bits: number) => {
  const width = v6 ? 128n : 32n;
  return ((1n << width) - 1n) ^ ((1n << (width - BigInt(bits))) - 1n);
};

/** A range like `192.168.1.0/24` or `fe80::/10`, or undefined if it isn't one. */
export function parseCidr(text: string): Cidr | undefined {
  const [address, length, ...rest] = text.split("/");
  if (address === undefined || length === undefined || rest.length > 0) return undefined;
  const parsed = parseAddress(address);
  if (parsed === undefined || !/^(0|[1-9][0-9]{0,2})$/.test(length)) return undefined;
  const bits = Number(length);
  if (bits > (parsed.v6 ? 128 : 32)) return undefined;
  return { v6: parsed.v6, base: parsed.value & mask(parsed.v6, bits), bits };
}

const MAPPED_V4 = 0xffffn << 32n;

/**
 * A peer's address as compared: an IPv4 address that a dual-stack socket reports as
 * `::ffff:a.b.c.d` is the IPv4 address it is.
 */
function normalise(raw: string): { v6: boolean; value: bigint } | undefined {
  const parsed = parseAddress(raw);
  if (parsed?.v6 === true && parsed.value >> 32n === 0xffffn) {
    return { v6: false, value: parsed.value ^ MAPPED_V4 };
  }
  return parsed;
}

/** Whether a peer's address is inside any of the ranges. */
export function admitted(ranges: readonly Cidr[], peer: string | undefined): boolean {
  const address = peer === undefined ? undefined : normalise(peer);
  if (address === undefined) return false;
  return ranges.some((r) => r.v6 === address.v6 && (address.value & mask(r.v6, r.bits)) === r.base);
}

/**
 * What pairing attempts from a peer are counted under: its IPv4 address, or its IPv6 /64, since
 * one IPv6 host can take any address in its network.
 */
export function pairingKey(peer: string | undefined): string {
  const address = peer === undefined ? undefined : normalise(peer);
  if (address === undefined) return "unknown";
  if (!address.v6) return format(address.value, false);
  return `${format(address.value & mask(true, 64), true)}/64`;
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
 * `web.lan_allow`. Link-local IPv6 is one range for every interface.
 */
export function localSubnets(
  interfaces: Readonly<Record<string, readonly InterfaceAddress[] | undefined>>,
): { interface: string; cidr: string }[] {
  const seen = new Set<string>();
  const out: { interface: string; cidr: string }[] = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const a of addresses ?? []) {
      if (a.internal || a.cidr === null) continue;
      const range = parseCidr(a.cidr);
      if (range === undefined) continue;
      const linkLocal = range.v6 && range.base >> 118n === 0x3fan;
      const cidr = linkLocal ? "fe80::/10" : `${format(range.base, range.v6)}/${range.bits}`;
      if (seen.has(cidr)) continue;
      seen.add(cidr);
      out.push({ interface: linkLocal ? "link-local" : name, cidr });
    }
  }
  return out;
}

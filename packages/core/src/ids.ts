declare const brand: unique symbol;
declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };
type Branded<T, B extends string> = T & { readonly [brand]: B };

export type HostId = Branded<string, "HostId">;
export type TerminalId = Branded<string, "TerminalId">;
export type AttachmentId = Branded<string, "AttachmentId">;

const ID_PATTERN = /^(host|term|att|lease|dev)_[0-9a-f]{32}$/;

/** A prefixed UUIDv7: time-ordered, unique, never reused, and never a runtime identifier. */
export type IdPrefix = "host" | "term" | "att" | "lease" | "dev";

export function newId(
  prefix: IdPrefix,
  now: number = Date.now(),
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  const bytes = random(16);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function isId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** The only place a string becomes a TerminalId; anything not shaped like one is rejected. */
export function toTerminalId(value: string): TerminalId | null {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- branding requires one cast, guarded by the pattern check
  return value.startsWith("term_") && isId(value) ? (value as TerminalId) : null;
}

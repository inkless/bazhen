declare const brand: unique symbol;
declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };
type Branded<B extends string> = string & { readonly [brand]: B };

export type HostId = Branded<"HostId">;
export type EnvironmentId = Branded<"EnvironmentId">;
export type AgentSessionId = Branded<"AgentSessionId">;
export type TaskId = Branded<"TaskId">;
export type AssignmentId = Branded<"AssignmentId">;
export type AttentionId = Branded<"AttentionId">;
export type MessageId = Branded<"MessageId">;
export type TerminalId = Branded<"TerminalId">;
export type DeviceId = Branded<"DeviceId">;
export type AttachmentId = Branded<"AttachmentId">;
export type LeaseId = Branded<"LeaseId">;

/** Each prefix and the identity it names (foundation-design §3). */
export interface IdKinds {
  host: HostId;
  env: EnvironmentId;
  agent: AgentSessionId;
  task: TaskId;
  asgn: AssignmentId;
  attn: AttentionId;
  msg: MessageId;
  term: TerminalId;
  dev: DeviceId;
  att: AttachmentId;
  lease: LeaseId;
}
export type IdPrefix = keyof IdKinds;

/** The UUIDv7 layout: version nibble 7, variant bits 10. */
const ID_PATTERN = /^[a-z]+_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/;

/**
 * The only way a string becomes a Bazhen id: a prefixed UUIDv7, time-ordered, never reused, and
 * never a runtime identifier such as a tmux `%pane`.
 */
export function isId<P extends IdPrefix>(prefix: P, value: string): value is IdKinds[P] {
  return value.startsWith(`${prefix}_`) && ID_PATTERN.test(value);
}

export function newId<P extends IdPrefix>(
  prefix: P,
  now: number = Date.now(),
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): IdKinds[P] {
  const bytes = random(16);
  if (bytes.length !== 16)
    throw new RangeError(`random source returned ${bytes.length} bytes, not 16`);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const id = `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  if (!isId(prefix, id)) throw new RangeError(`not a valid ${prefix} id: ${id}`);
  return id;
}

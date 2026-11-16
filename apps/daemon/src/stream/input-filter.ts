import { hasKeystrokes, withoutReplies } from "@bazhen/protocol";

export interface ViewInput {
  /** The input with every terminal reply removed; pasted text is left exactly as pasted. */
  readonly bytes: Uint8Array;
  /** Whether anything is left beyond focus and mouse reports: what a person typed or pasted. */
  readonly keystrokes: boolean;
}

/** Separates what a view sent into what may reach the program and whether the user typed. */
export function classifyInput(input: Uint8Array): ViewInput {
  if (!input.includes(0x1b)) return { bytes: input, keystrokes: input.length > 0 };
  const text = Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("latin1");
  return {
    bytes: Buffer.from(withoutReplies(text), "latin1"),
    keystrokes: hasKeystrokes(text),
  };
}

// The web platform's text codecs and timer, which every runtime Bazhen runs on provides. Core
// type-checks against no platform's globals, so the few the test doubles use are declared here.

declare const TextEncoder: new () => { encode(text: string): Uint8Array };
declare const TextDecoder: new () => { decode(bytes: Uint8Array): string };
declare function setTimeout(callback: () => void, ms: number): unknown;

export const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
export const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

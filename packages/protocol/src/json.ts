/** JSON from a peer, or undefined when it isn't JSON: a frame's schema then rejects it. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

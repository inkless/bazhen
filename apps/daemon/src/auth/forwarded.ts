/**
 * Whether a proxy says the request came from another machine: any address in its
 * `X-Forwarded-For` or `Forwarded` chain that isn't loopback. Caddy sets the chain, and the web
 * dev server adds its hop, so a phone's request names the phone however its Host was rewritten.
 * A local process can forge the chain, but it is on loopback already; it can't erase a hop a
 * proxy added.
 */
export function forwardedFromElsewhere(headers: {
  readonly xForwardedFor: string | undefined;
  readonly forwarded: string | undefined;
}): boolean {
  const fromXff = (headers.xForwardedFor ?? "").split(",");
  const fromForwarded = [...(headers.forwarded ?? "").matchAll(/for=("[^"]*"|[^;,\s]*)/gi)].map(
    (m) => m[1] ?? "",
  );
  return [...fromXff, ...fromForwarded]
    .map(bareAddress)
    .some((address) => address !== "" && !isLoopback(address));
}

/** An address without the quotes, brackets and port a header may wrap it in. */
function bareAddress(raw: string): string {
  const unquoted = raw.trim().replace(/^"|"$/g, "");
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(unquoted);
  if (bracketed !== null) return (bracketed[1] ?? "").toLowerCase();
  const v4WithPort = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(unquoted);
  return (v4WithPort?.[1] ?? unquoted).toLowerCase();
}

function isLoopback(address: string): boolean {
  if (address === "::1" || address === "localhost") return true;
  const v4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return /^127\.\d+\.\d+\.\d+$/.test(v4);
}

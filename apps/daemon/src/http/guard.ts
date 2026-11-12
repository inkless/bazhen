export interface Allowlists {
  /** Host header values accepted; anything else is refused as a DNS-rebinding defence. */
  readonly hosts: readonly string[];
  /** Origins a browser may act from. */
  readonly origins: readonly string[];
}

export interface Arrival {
  readonly host: string | undefined;
  readonly origin: string | undefined;
  /** It changes state or opens a socket, rather than only reading. */
  readonly acting: boolean;
}

/**
 * Why a request is refused, or null to admit it (foundation-design §9.1). A browser always
 * sends Origin when it acts, so a page elsewhere can't act through the user's browser; a request
 * without one comes from a local process, which the Host check and, later, pairing govern.
 */
export function refusal(
  allow: Allowlists,
  arrival: Arrival,
): "host_not_allowed" | "origin_not_allowed" | null {
  if (!allow.hosts.includes(arrival.host ?? "")) return "host_not_allowed";
  const { origin } = arrival;
  if (arrival.acting && origin !== undefined && !allow.origins.includes(origin)) {
    return "origin_not_allowed";
  }
  return null;
}

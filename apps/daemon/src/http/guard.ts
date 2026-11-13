export interface Allowlists {
  /** Host header values accepted; anything else is refused as a DNS-rebinding defence. */
  readonly hosts: readonly string[];
  /** Origins a browser may act from. */
  readonly origins: readonly string[];
}

/** The daemon's own loopback name; it never listens anywhere else. */
const LOOPBACK = "127.0.0.1";
const loopback = (port: number | string) => [`${LOOPBACK}:${port}`, `localhost:${port}`];

/**
 * Who may reach the daemon: its own loopback address; the web dev server's pages, which keep
 * their origin through its proxy, when the dev scripts name its port; and each external origin
 * the user configured, as a host and as an origin (foundation-design §9.2).
 */
export function allowlists(opts: {
  readonly port: number;
  readonly webPort: string | undefined;
  readonly externalOrigins: readonly string[];
}): Allowlists {
  const own = loopback(opts.port);
  const web = opts.webPort === undefined ? [] : loopback(opts.webPort);
  return {
    hosts: [...own, ...opts.externalOrigins.map((origin) => new URL(origin).host)],
    origins: [...[...own, ...web].map((host) => `http://${host}`), ...opts.externalOrigins],
  };
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

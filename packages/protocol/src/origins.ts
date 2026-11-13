// The external origins a user's own route to the daemon presents (foundation-design §9.2). The
// daemon and the web dev server both admit them, so both check them here, the same way.

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A web origin exactly as a browser sends it: scheme, host and any port, and nothing more. */
export function isOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
}

/** Plain HTTP to a host other than this machine, which anyone on the network can read. */
export function isPlainRemote(origin: string): boolean {
  const url = new URL(origin);
  return url.protocol === "http:" && !LOOPBACK.has(url.hostname);
}

/** A comma-separated list, as an environment variable holds one; empty for none. */
export function originList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/**
 * Why `origins` can't be admitted, or null when every one can. Plain HTTP to another host needs
 * `allowInsecure`, since a device's credentials would cross the network readable.
 */
export function originsProblem(origins: readonly string[], allowInsecure: boolean): string | null {
  const bad = origins.find((origin) => !isOrigin(origin));
  if (bad !== undefined) return `${bad} must be an origin, such as https://bazhen.example.com`;
  const plain = origins.find(isPlainRemote);
  if (plain !== undefined && !allowInsecure) {
    return `${plain} is plain HTTP to another host; use https, or set web.allow_insecure_origins`;
  }
  return null;
}

/**
 * The header the web dev server's proxy adds to every request: the external origins it admits,
 * comma-separated. The daemon refuses one naming an origin it doesn't admit itself.
 */
export const DEV_ORIGINS_HEADER = "bazhen-dev-origins";

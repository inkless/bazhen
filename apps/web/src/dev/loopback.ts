/** Request headers as Node gives them. */
type Headers = Readonly<Record<string, string | string[] | undefined>>;

/** Headers a proxy adds on its way through; this machine's own browser sends none of them. */
const PROXY_HEADERS = [
  "x-forwarded-for",
  "forwarded",
  "via",
  "x-real-ip",
  "x-forwarded-host",
  "x-forwarded-proto",
];

/**
 * Whether the web dev server should answer a request: this machine's own browser, by a loopback
 * Host on its own port, from a page on that origin if any, with no proxy header. The dev server
 * serves the repository's source (`/@fs/` included), and Vite's own host check admits any IP
 * address, so a proxy given this machine's LAN address would put that source on the network.
 *
 * It can't see a forwarder that presents a loopback Host and adds no header: `socat`, `ssh -R`,
 * or a proxy set to rewrite Host and send no forwarding header reaches the source unrefused.
 * Point no forwarder at this port; a phone reaches the daemon, which serves the built app
 * (docs/caddy.md).
 */
export function servesHere(headers: Headers, port: number): boolean {
  const own = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = headers["host"];
  const origin = headers["origin"];
  if (typeof host !== "string" || !own.includes(host)) return false;
  if (origin !== undefined && !own.some((h) => origin === `http://${h}`)) return false;
  return PROXY_HEADERS.every((name) => headers[name] === undefined);
}

/** No listener answers this path: not the HMR socket at "/", not the `/v1` proxy. */
export const REFUSED_PATH = "/__bazhen-refused";

/**
 * Refuses an upgrade the dev server shouldn't answer. Every `upgrade` listener still runs after
 * this one, and Vite's proxy would open the connection to the daemon even for a destroyed
 * socket, so the request is first pointed at a path none of them matches.
 */
export function refuseUpgrade(req: { url?: string | undefined }, socket: { destroy(): void }) {
  req.url = REFUSED_PATH;
  socket.destroy();
}

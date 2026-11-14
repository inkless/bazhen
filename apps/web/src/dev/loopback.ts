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

/** What a browser sends as `Sec-Fetch-Dest` for a page another page embeds. */
const FRAMED = ["iframe", "frame", "embed", "object"];

/**
 * Whether the web dev server should answer a request: this machine's own browser, by a loopback
 * Host on its own port, from a page on that origin if any, not framed by another page, with no proxy header. The dev server
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
  const dest = headers["sec-fetch-dest"];
  if (typeof dest === "string" && FRAMED.includes(dest)) return false;
  if (origin !== undefined && !own.some((h) => origin === `http://${h}`)) return false;
  return PROXY_HEADERS.every((name) => headers[name] === undefined);
}

/** What the dev server's response is refused framing by: a page on another local port may not embed it. */
export const NO_FRAMING = "frame-ancestors 'none'";

/** The reply to a request `servesHere` refused. */
export const REFUSAL =
  "The web dev server serves this machine only; reach Bazhen through the daemon.\n";

/** The slice of a Node response `answer` uses. */
interface Reply {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body: string): unknown;
}

/**
 * The dev server's first middleware: forbids framing on every response it goes on to send, the
 * refusal included, then lets a request `servesHere` admits through and refuses the rest. A framed
 * load carries the page's own Host and no Origin, so `servesHere` alone admits it.
 */
export function answer(headers: Headers, res: Reply, port: number, next: () => void) {
  res.setHeader("content-security-policy", NO_FRAMING);
  res.setHeader("x-frame-options", "DENY");
  if (servesHere(headers, port)) return next();
  res.statusCode = 403;
  res.end(REFUSAL);
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

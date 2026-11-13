import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";
import { getMimeType } from "hono/utils/mime";

/** Where `pnpm build` leaves the web client: `apps/web/dist`, beside this app in the checkout. */
export const BUNDLE = fileURLToPath(new URL("../../../web/dist", import.meta.url));

/** What the page answers when there is no bundle to serve. */
export const NOT_BUILT = "The web app isn't built. Run `pnpm build`, then reload.";

/** Vite names these by their content, so a new build never reuses a name. */
const ASSETS = "/assets/";

/** On every page response: no sniffing a type, no referrer, and no framing by another site. */
const HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "frame-ancestors 'none'",
};

/**
 * The built web client (`apps/web/dist`), for every GET that no API route answered. A path that
 * names no file loads the app, so a reload on any of its views works; a missing asset is a 404,
 * never the app served as a script. The bundle is read on each request, so a rebuild needs no
 * restart, and a daemon started before the first build serves it once it exists.
 */
export function webPage(root: string) {
  return async (c: Context) => {
    const { path } = c.req;
    if (path === "/v1" || path.startsWith("/v1/")) return c.notFound();
    // A path naming a file that isn't there is a 404; only a view's path loads the app.
    const view = !path.startsWith(ASSETS) && !/\.[^/]*$/.test(path);
    const file = (await bundled(root, path)) ?? (view ? await bundled(root, "/index.html") : null);
    if (file === null) {
      return (await built(root)) ? c.notFound() : c.text(NOT_BUILT, 404, HEADERS);
    }
    return c.body(file.body, 200, {
      ...HEADERS,
      "content-type": getMimeType(file.path) ?? "application/octet-stream",
      "cache-control": path.startsWith(ASSETS) ? "public, max-age=31536000, immutable" : "no-cache",
    });
  };
}

/** A path segment that can name only a file inside the directory it is in. */
const plain = (segment: string) =>
  segment !== "" && !segment.startsWith(".") && !/[\\%\0]/.test(segment);

/** Whether `root` holds a bundle the page can serve. */
export async function built(root: string): Promise<boolean> {
  return (await bundled(root, "/index.html")) !== null;
}

/**
 * The bundle's file at `path`, or null. Only a plain file inside the bundle counts: no dotfile,
 * no empty, `.` or `..` segment, no escape left encoded, and nothing a symlink leads out to.
 */
export async function bundled(
  root: string,
  path: string,
): Promise<{ path: string; body: Buffer<ArrayBuffer> } | null> {
  const segments = path.split("/").slice(1);
  if (!segments.every(plain)) return null;
  try {
    const base = await realpath(root);
    const file = await realpath(join(base, ...segments));
    if (!file.startsWith(base + sep) || !(await stat(file)).isFile()) return null;
    // Read here too: a rebuild empties the bundle, and a file gone since is simply not found.
    return { path: file, body: await readFile(file) };
  } catch {
    return null;
  }
}

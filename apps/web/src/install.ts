import { isApple } from "./terminal/keymap.ts";

/**
 * Whether to offer Bazhen as an installed app: only where a browser tab keeps Ctrl+W, Ctrl+T and
 * Ctrl+N for itself, which an app window passes on to the terminal. A phone, an iPad and a Mac
 * never lose those keys, so they get no manifest and Add to Home Screen does what it always did.
 */
export const offersInstall = (userAgent: string): boolean =>
  !isApple(userAgent) && !/Android/.test(userAgent);

/** Links the web app manifest, where `offersInstall`. */
export function linkManifest(page: Document, userAgent: string): void {
  if (!offersInstall(userAgent)) return;
  const link = page.createElement("link");
  link.rel = "manifest";
  link.href = "/manifest.webmanifest";
  page.head.append(link);
}

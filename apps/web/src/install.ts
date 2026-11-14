import { wantsKeyBar, type Device } from "./terminal/bar-keys.ts";
import { isApple } from "./terminal/keymap.ts";

/**
 * Whether to offer Bazhen as an installed app: only on a desktop whose browser tabs keep Ctrl+W,
 * Ctrl+T and Ctrl+N for themselves, which an app window passes on to the terminal. A Mac never
 * loses those keys, nor does a phone or a tablet, an Android one asking for the desktop site
 * included, so none of them gets a manifest, an app icon or the close guard.
 */
export const offersInstall = (device: Device): boolean =>
  !wantsKeyBar(device) && !isApple(device.userAgent) && !/Android/.test(device.userAgent);

/** Whether this browser can install a page as an app here: a Chromium one, on a secure origin. */
export const canInstall = (): boolean => isSecureContext && "onbeforeinstallprompt" in window;

/** This browser's device, as `offersInstall` reads it. */
export const thisDevice = (): Device => ({
  coarse: matchMedia("(pointer: coarse)").matches,
  maxTouchPoints: navigator.maxTouchPoints,
  userAgent: navigator.userAgent,
});

/** Links the web app manifest and the app icon, where `offersInstall`. */
export function linkAppFiles(page: Document, device: Device): void {
  if (!offersInstall(device)) return;
  for (const [rel, href] of [
    ["manifest", "/manifest.webmanifest"],
    ["icon", "/icon.svg"],
  ] as const) {
    const link = page.createElement("link");
    link.rel = rel;
    link.href = href;
    page.head.append(link);
  }
}

import { wantsKeyBar, type Device } from "./terminal/bar-keys.ts";
import { isApple } from "./terminal/keymap.ts";

/**
 * The key bar's device, and whether its browser is a mobile one, which an Android tablet asking
 * for the desktop site still gives away by having `window.orientation`.
 */
export interface Platform extends Device {
  readonly mobile: boolean;
}

/**
 * Whether to offer Bazhen as an installed app, and guard closes in a tab: only on a Linux, Windows
 * or ChromeOS desktop, whose browser tabs keep Ctrl+W, Ctrl+T and Ctrl+N for themselves, which an
 * app window passes on to the terminal. A Mac doesn't lose those keys, and a phone or a tablet is
 * touch-first, so none of them gets a manifest, an app icon or the close guard.
 */
export const offersInstall = (platform: Platform): boolean =>
  !platform.mobile &&
  !wantsKeyBar(platform) &&
  !isApple(platform.userAgent) &&
  !/Android/.test(platform.userAgent);

export const thisPlatform = (): Platform => ({
  coarse: matchMedia("(pointer: coarse)").matches,
  maxTouchPoints: navigator.maxTouchPoints,
  userAgent: navigator.userAgent,
  mobile: "orientation" in window,
});

/** Whether this window is an installed app's, where Ctrl+W already reaches the terminal. */
export const inAppWindow = (): boolean => matchMedia("(display-mode: standalone)").matches;

/** What decides whether the browser can install Bazhen from this page now. */
export interface Here {
  /** Installing needs a secure origin: loopback, or HTTPS. */
  readonly secure: boolean;
  /** A Chromium browser, which can install a page; Firefox and Safari's desktop tabs can't. */
  readonly prompts: boolean;
  /** The manifest is linked, which a page loaded on a touch-first posture lacks until a reload. */
  readonly linked: boolean;
  readonly inApp: boolean;
}

/** Whether to tell a user who lost Ctrl+W to the tab that the installed app would pass it on. */
export const suggestsApp = (here: Here): boolean =>
  here.secure && here.prompts && here.linked && !here.inApp;

export const here = (): Here => ({
  secure: isSecureContext,
  prompts: "onbeforeinstallprompt" in window,
  linked: document.querySelector('link[rel="manifest"]') !== null,
  inApp: inAppWindow(),
});

/** Links the web app manifest and the app icon, where `offersInstall`. */
export function linkAppFiles(page: Document, platform: Platform): void {
  if (!offersInstall(platform)) return;
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

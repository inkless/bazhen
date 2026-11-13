// Desktop notifications: the only processes host-guard starts that aren't tmux. Each entry builds
// its own argv, with an absolute binary and a fixed shape, so no caller can point it at another
// program, file or URL.

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { runBounded, type RunOutcome } from "./signal.ts";

/** What a notification says. */
export interface DesktopNotification {
  readonly title: string;
  readonly body: string;
}

/** Shows one notification, and answers how the command ended; it never throws. */
export type ShowNotification = (n: DesktopNotification) => Promise<RunOutcome>;

/** Where distributions install notify-send; it is looked for here, never on PATH. */
export const NOTIFY_SEND_PATHS = ["/usr/bin/notify-send", "/usr/local/bin/notify-send"] as const;

/** notify-send, if it is installed in one of the known places. */
export function findNotifySend(exists: (path: string) => boolean = existsSync): string | null {
  return NOTIFY_SEND_PATHS.find((path) => exists(path)) ?? null;
}

/** notify-send's argv: "--" ends its options, so a title or body that starts with "-" stays text. */
export const notifySendArgs = (n: DesktopNotification) => [
  "--app-name=Bazhen",
  "--",
  n.title,
  n.body,
];

/** Notifications through notify-send at `binary`, one of `NOTIFY_SEND_PATHS`. */
export function linuxNotifier(binary: string): ShowNotification {
  if (!(NOTIFY_SEND_PATHS as readonly string[]).includes(binary)) {
    throw new RangeError(`refusing to run ${binary} as notify-send`);
  }
  return (n) => runBounded(binary, notifySendArgs(n), { timeoutMs: 5_000 });
}

const OPEN = "/usr/bin/open";
/** How long the macOS notifier stays after posting; a click after it exits relaunches it. */
const MAC_STAYS_S = 5;

/**
 * `open`'s argv for Bazhen.app. `-W` waits for the instance to exit, so a caller that runs one
 * at a time has one instance at a time; `-n` starts a fresh one, which is the only kind that
 * reads `--args`. The app builds the inbox's URL from `port` itself.
 */
export const macNotifierArgs = (app: string, port: number, n: DesktopNotification) => [
  "-nW",
  app,
  "--args",
  "--title",
  n.title,
  "--body",
  n.body,
  "--port",
  String(port),
  "--timeout",
  String(MAC_STAYS_S),
];

/**
 * Notifications through Bazhen.app at `app`, which a click opens the daemon's inbox from, on
 * `port`. Only a bundle named Bazhen.app, by absolute path, is run.
 */
export function macNotifier(app: string, port: number): ShowNotification {
  if (!isAbsolute(app) || !app.endsWith("/Bazhen.app")) {
    throw new RangeError(`refusing to run ${app} as Bazhen's notifier`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError(`refusing port ${port}`);
  }
  return (n) =>
    runBounded(OPEN, macNotifierArgs(app, port, n), { timeoutMs: (MAC_STAYS_S + 10) * 1_000 });
}

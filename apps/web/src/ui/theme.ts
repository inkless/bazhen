import { useSyncExternalStore } from "react";
import type { Scheme } from "./token-sheet.ts";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** Per device, as the terminal settings are; index.html's head reads the same key. */
export const THEME_KEY = "bazhen.theme";

export const parseTheme = (stored: string | null): Theme =>
  THEMES.find((t) => t === stored) ?? "system";

/**
 * The device's stored theme. Storage throws when site data is blocked, even on access, so it is
 * reached through `storage` and a failure reads as "system".
 */
export function loadTheme(storage: () => Pick<Storage, "getItem">): Theme {
  try {
    return parseTheme(storage().getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

/** Stores the choice where it can; with storage blocked it lasts until the page reloads. */
export function saveTheme(theme: Theme, storage: () => Pick<Storage, "setItem" | "removeItem">) {
  try {
    if (theme === "system") storage().removeItem(THEME_KEY);
    else storage().setItem(THEME_KEY, theme);
  } catch {
    // Nothing to keep it in; the page still shows it.
  }
}

/** "system" leaves the choice to `prefers-color-scheme`, through tokens.css's `color-scheme`. */
export function applyTheme(
  theme: Theme,
  root: Pick<HTMLElement, "dataset"> = document.documentElement,
): void {
  if (theme === "system") delete root.dataset["theme"];
  else root.dataset["theme"] = theme;
}

/** What a theme store reads from the page; the browser's own in the app, fakes in tests. */
export interface ThemeHost {
  readonly storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly root: Pick<HTMLElement, "dataset">;
  readonly matchMedia: (query: string) => {
    readonly matches: boolean;
    addEventListener(type: "change", listener: () => void): void;
  };
  /** Where another tab's change to storage is announced. */
  readonly events: {
    addEventListener(
      type: "storage",
      listener: (event: Pick<StorageEvent, "key" | "newValue">) => void,
    ): void;
  };
}

export interface ThemeStore {
  readonly theme: () => Theme;
  /** Stores, applies and announces a choice. */
  readonly choose: (theme: Theme) => void;
  /** Light or dark as shown: the choice, or the system's under "system". */
  readonly scheme: () => Scheme;
  readonly moreContrast: () => boolean;
  /**
   * Calls `listener` whenever what is shown may have changed: a choice here or in another tab of
   * this device, or the system's scheme or contrast preference. Returns the unsubscribe.
   */
  readonly subscribe: (listener: () => void) => () => void;
}

const DARK = "(prefers-color-scheme: dark)";
const MORE_CONTRAST = "(prefers-contrast: more)";

export function themeStore(host: ThemeHost): ThemeStore {
  let theme = loadTheme(host.storage);
  const listeners = new Set<() => void>();
  const announce = () => {
    for (const listener of listeners) listener();
  };
  const dark = host.matchMedia(DARK);
  const contrast = host.matchMedia(MORE_CONTRAST);
  dark.addEventListener("change", announce);
  contrast.addEventListener("change", announce);
  host.events.addEventListener("storage", (event) => {
    // A null key is another tab clearing all of storage.
    if (event.key !== null && event.key !== THEME_KEY) return;
    theme = parseTheme(event.newValue);
    applyTheme(theme, host.root);
    announce();
  });
  return {
    theme: () => theme,
    choose: (next) => {
      saveTheme(next, host.storage);
      applyTheme(next, host.root);
      theme = next;
      announce();
    },
    scheme: () => (theme === "system" ? (dark.matches ? "dark" : "light") : theme),
    moreContrast: () => contrast.matches,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

let shared: ThemeStore | undefined;

/** The page's one store, made on first use, so a module import touches no browser API. */
export const pageTheme = (): ThemeStore =>
  (shared ??= themeStore({
    storage: () => localStorage,
    root: document.documentElement,
    matchMedia: (query) => matchMedia(query),
    events: window,
  }));

/** This device's theme, and a setter that stores and applies it. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const store = pageTheme();
  const theme = useSyncExternalStore(store.subscribe, store.theme);
  return [theme, store.choose];
}

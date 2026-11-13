import { useState } from "react";

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
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === "system") delete root.dataset["theme"];
  else root.dataset["theme"] = theme;
}

/** This device's theme, and a setter that stores and applies it. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState(() => loadTheme(() => localStorage));
  const choose = (next: Theme) => {
    saveTheme(next, () => localStorage);
    applyTheme(next);
    setTheme(next);
  };
  return [theme, choose];
}

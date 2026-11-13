export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** Per device, as the terminal settings are; the daemon never syncs it. */
export const THEME_KEY = "bazhen.theme";

export const parseTheme = (stored: string | null): Theme =>
  THEMES.find((t) => t === stored) ?? "system";

export function loadTheme(storage: Pick<Storage, "getItem">): Theme {
  return parseTheme(storage.getItem(THEME_KEY));
}

/** "system" leaves the choice to `prefers-color-scheme`, through tokens.css's `color-scheme`. */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === "system") delete root.dataset["theme"];
  else root.dataset["theme"] = theme;
}

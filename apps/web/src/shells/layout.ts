import { useSyncExternalStore } from "react";

/** Where an agent's shell dock sits and whether it shows, kept per device. */
export interface DockLayout {
  readonly position: "bottom" | "right";
  readonly hidden: boolean;
}

export const DOCK_KEY = "bazhen.dock";
const DEFAULT: DockLayout = { position: "bottom", hidden: false };

/** A stored layout, or the default for anything it can't read as one. */
export function parseLayout(stored: string | null): DockLayout {
  try {
    const value: unknown = JSON.parse(stored ?? "null");
    const position = Reflect.get(Object(value), "position");
    const hidden = Reflect.get(Object(value), "hidden");
    return {
      position: position === "right" ? "right" : "bottom",
      hidden: hidden === true,
    };
  } catch {
    return DEFAULT;
  }
}

/**
 * The dock layout store, read and written through `storage`. Storage throws when site data is
 * blocked, so a failure reads as the default and a change lasts until the page reloads.
 */
export function layoutStore(storage: () => Pick<Storage, "getItem" | "setItem">) {
  const listeners = new Set<() => void>();
  let current: DockLayout | undefined;
  const read = (): DockLayout => {
    if (current !== undefined) return current;
    try {
      current = parseLayout(storage().getItem(DOCK_KEY));
    } catch {
      current = DEFAULT;
    }
    return current;
  };
  return {
    read,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    write: (next: DockLayout) => {
      current = next;
      try {
        storage().setItem(DOCK_KEY, JSON.stringify(next));
      } catch {
        // Nowhere to keep it; the page still shows it.
      }
      for (const listener of listeners) listener();
    },
  };
}

let shared: ReturnType<typeof layoutStore> | undefined;

/** This page's dock layout, in the browser's local storage. */
export const dockLayout = () => (shared ??= layoutStore(() => localStorage));

/** Where the dock can sit beside the TUI rather than under it, as app.css lays it out. */
export const SIDE_BY_SIDE = "(min-width: 70rem)";

/** Whether `query` matches now, and again whenever that changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (changed) => {
      const list = matchMedia(query);
      list.addEventListener("change", changed);
      return () => list.removeEventListener("change", changed);
    },
    () => matchMedia(query).matches,
  );
}

/**
 * The dock layout this page shows: the device's own choice, but below where the dock fits beside
 * the TUI it sits under it, whatever was chosen, so a phone never scrolls through both stacked.
 */
export function useDockLayout(): DockLayout & { readonly canSit: boolean } {
  const store = dockLayout();
  const chosen = useSyncExternalStore(store.subscribe, store.read);
  const canSit = useMediaQuery(SIDE_BY_SIDE);
  return { ...chosen, position: canSit ? chosen.position : "bottom", canSit };
}

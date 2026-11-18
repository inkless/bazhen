/**
 * What this device keeps for itself. With site data blocked, even reaching the browser's storage
 * throws, and the page goes on without it: a read that fails finds nothing, and a write that fails
 * is dropped.
 */
export interface DeviceStorage {
  read(key: string): string | null;
  /** Stores `value` under `key`, or forgets the key for `null`. */
  write(key: string, value: string | null): void;
}

/** A device storage over `storage`, which is reached on each call, inside the guard. */
export function deviceStorageOf(
  storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">,
): DeviceStorage {
  return {
    read: (key) => {
      try {
        return storage().getItem(key);
      } catch {
        return null;
      }
    },
    write: (key, value) => {
      try {
        if (value === null) storage().removeItem(key);
        else storage().setItem(key, value);
      } catch {
        // Nowhere to keep it.
      }
    },
  };
}

/** The browser's local storage: the one place in the app that reaches it. */
export const deviceStorage: DeviceStorage = deviceStorageOf(() => localStorage);

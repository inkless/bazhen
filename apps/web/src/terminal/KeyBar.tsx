import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../ui/Button.tsx";
import { ToggleButton } from "../ui/ToggleButton.tsx";
import { Toolbar } from "../ui/Toolbar.tsx";
import { useMediaQuery } from "../shells/layout.ts";
import { keyBar, wantsKeyBar, type BarKey } from "./bar-keys.ts";

/** `"hidden"` when this device's user hid the bar; nothing is synced by the daemon. */
const HIDDEN_KEY = "bazhen.keyBar";

type Key = { readonly key: BarKey; readonly label: string; readonly name?: string };

const BEFORE_CTRL: readonly Key[] = [
  { key: "escape", label: "Esc", name: "Escape" },
  { key: "tab", label: "Tab" },
];

const AFTER_CTRL: readonly Key[] = [
  { key: "left", label: "←", name: "Left arrow" },
  { key: "down", label: "↓", name: "Down arrow" },
  { key: "up", label: "↑", name: "Up arrow" },
  { key: "right", label: "→", name: "Right arrow" },
  { key: "newline", label: "⇧⏎", name: "Newline" },
  { key: "enter", label: "⏎", name: "Enter" },
];

/**
 * The keys a phone's or iPad's keyboard lacks, for the terminal last touched, along the app's
 * bottom, which sits on the soft keyboard. A key goes through that terminal's input like a typed
 * one: from a view that doesn't drive, it takes over instead of reaching the program. The user can
 * hide it, per device.
 */
export function KeyBar() {
  const coarse = useMediaQuery("(pointer: coarse)");
  const wanted = wantsKeyBar({
    coarse,
    maxTouchPoints: navigator.maxTouchPoints,
    userAgent: navigator.userAgent,
  });
  const store = keyBar();
  const present = useSyncExternalStore(store.subscribe, () => store.target() !== undefined);
  const ctrl = useSyncExternalStore(store.subscribe, store.ctrl);
  const [hidden, setHidden] = useState(() => localStorage.getItem(HIDDEN_KEY) === "hidden");
  const hide = (next: boolean) => {
    if (next) localStorage.setItem(HIDDEN_KEY, "hidden");
    else localStorage.removeItem(HIDDEN_KEY);
    setHidden(next);
  };
  useCtrlReleased(wanted && present && !hidden);
  if (!wanted || !present) return null;
  if (hidden) {
    return (
      <div className="key-bar-show">
        <Button preventFocusOnPress aria-label="Show keys" onPress={() => hide(false)}>
          Keys
        </Button>
      </div>
    );
  }

  // Pressing a key mustn't move focus off the terminal, or a phone closes its soft keyboard.
  const button = ({ key, label, name }: Key) => (
    <Button
      key={key}
      preventFocusOnPress
      {...(name !== undefined && { "aria-label": name })}
      onPress={() => store.target()?.press(key)}
    >
      {label}
    </Button>
  );
  return (
    <div className="key-bar">
      <Toolbar label="terminal keys">
        {BEFORE_CTRL.map(button)}
        <ToggleButton
          preventFocusOnPress
          isSelected={ctrl}
          onChange={(on) => {
            store.setCtrl(on);
            // The letter to send with it is typed on the soft keyboard, which focus opens; the
            // focus engages the terminal, as a tap on it does.
            if (on) store.target()?.focus();
          }}
        >
          Ctrl
        </ToggleButton>
        {AFTER_CTRL.map(button)}
        {/* Safari's own Done is on an accessory bar that may not show; this does the same. */}
        <Button
          preventFocusOnPress
          aria-label="Close keyboard"
          onPress={() => store.target()?.blur()}
        >
          Done
        </Button>
        <Button variant="quiet" preventFocusOnPress onPress={() => hide(true)}>
          Hide
        </Button>
      </Toolbar>
    </div>
  );
}

/** Once the bar isn't `shown`, hidden or gone, releases Ctrl, which would otherwise land unseen. */
function useCtrlReleased(shown: boolean): void {
  useEffect(() => {
    if (!shown) return undefined;
    return () => keyBar().setCtrl(false);
  }, [shown]);
}

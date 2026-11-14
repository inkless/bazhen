import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../ui/Button.tsx";
import { ToggleButton } from "../ui/ToggleButton.tsx";
import { useMediaQuery } from "../shells/layout.ts";
import { keyBar, lift, type BarKey } from "./bar-keys.ts";

/**
 * Any touchscreen, not only a touch-first one: an iPad with a trackpad reports a fine pointer, and
 * its keyboard has no Esc either.
 */
const TOUCH = "(any-pointer: coarse)";

const KEYS: readonly { readonly key: BarKey; readonly label: string; readonly name?: string }[] = [
  { key: "escape", label: "Esc", name: "Escape" },
  { key: "tab", label: "Tab" },
];

const MOVES: readonly { readonly key: BarKey; readonly label: string; readonly name: string }[] = [
  { key: "left", label: "←", name: "Left arrow" },
  { key: "down", label: "↓", name: "Down arrow" },
  { key: "up", label: "↑", name: "Up arrow" },
  { key: "right", label: "→", name: "Right arrow" },
  { key: "newline", label: "⇧⏎", name: "Newline" },
  { key: "enter", label: "⏎", name: "Enter" },
];

/**
 * The keys a touch keyboard lacks, for the terminal last touched, above the soft keyboard. A key
 * goes through that terminal's input like a typed one: from a view that doesn't drive, it takes
 * over instead of reaching the program.
 */
export function KeyBar() {
  const touch = useMediaQuery(TOUCH);
  const store = keyBar();
  const present = useSyncExternalStore(store.subscribe, () => store.target() !== undefined);
  const ctrl = useSyncExternalStore(store.subscribe, store.ctrl);
  const raised = useLift(touch && present);
  if (!touch || !present) return null;

  // Pressing a key mustn't move focus off the terminal, or a phone closes its soft keyboard.
  const button = ({ key, label, name }: { key: BarKey; label: string; name?: string }) => (
    <Button
      key={key}
      variant="secondary"
      preventFocusOnPress
      {...(name !== undefined && { "aria-label": name })}
      onPress={() => store.target()?.press(key)}
    >
      {label}
    </Button>
  );
  return (
    <>
      <div className="key-bar-room" />
      <div
        role="toolbar"
        aria-label="terminal keys"
        className="key-bar"
        style={{ bottom: `${raised}px` }}
      >
        {KEYS.map(button)}
        <ToggleButton
          preventFocusOnPress
          aria-label="Control"
          isSelected={ctrl}
          onChange={(on) => {
            store.setCtrl(on);
            // The letter to send with it is typed on the soft keyboard, which focus opens.
            if (on) store.target()?.focus();
          }}
        >
          Ctrl
        </ToggleButton>
        {MOVES.map(button)}
      </div>
    </>
  );
}

/** How far to raise the bar to keep it above the soft keyboard, while `active`. */
function useLift(active: boolean): number {
  const [raised, setRaised] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || viewport === null) return undefined;
    const update = () => setRaised(lift(window.innerHeight, viewport));
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [active]);
  return raised;
}

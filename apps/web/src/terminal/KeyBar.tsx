import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../ui/Button.tsx";
import { ToggleButton } from "../ui/ToggleButton.tsx";
import { Toolbar } from "../ui/Toolbar.tsx";
import { useMediaQuery } from "../shells/layout.ts";
import { keyBar, lift, wantsKeyBar, type BarKey } from "./bar-keys.ts";

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
 * The keys a phone's or iPad's keyboard lacks, for the terminal last touched, above the soft
 * keyboard. A key goes through that terminal's input like a typed one: from a view that doesn't
 * drive, it takes over instead of reaching the program. The user can hide it, per device.
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
  const bar = useRef<HTMLDivElement>(null);
  const raised = useBarLayout(wanted && present && !hidden, bar);
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
    <>
      <div className="key-bar-room" />
      <div ref={bar} className="key-bar" style={{ bottom: `${raised}px` }}>
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
          <Button variant="quiet" preventFocusOnPress onPress={() => hide(true)}>
            Hide
          </Button>
        </Toolbar>
      </div>
    </>
  );
}

/**
 * While `shown`, keeps the bar above the soft keyboard and tells the terminals how much room they
 * have above it. Returns how far to raise the bar.
 */
function useBarLayout(shown: boolean, bar: { readonly current: HTMLElement | null }): number {
  const [raised, setRaised] = useState(0);
  useEffect(() => {
    if (!shown) return undefined;
    const store = keyBar();
    const viewport = window.visualViewport;
    const update = () => {
      const height = bar.current?.offsetHeight ?? 0;
      setRaised(lift(window.innerHeight, viewport));
      store.setLayout({ room: (viewport?.height ?? window.innerHeight) - height, bar: height });
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      store.setLayout(null);
    };
  }, [shown, bar]);
  return raised;
}

import { describe, expect, it, vi } from "vitest";
import {
  barBytes,
  keyBarStore,
  lift,
  settled,
  wantsKeyBar,
  withCtrl,
  type BarKey,
} from "./bar-keys.ts";
import { DEFAULT_KEY_MAP, parseKeyMap, type KeyMap } from "./keymap.ts";

const plain = { keyMap: DEFAULT_KEY_MAP, ctrl: false, appCursor: false };

function parsedMap(raw: unknown): KeyMap {
  const parsed = parseKeyMap(raw);
  if (!parsed.ok) throw new Error(`fixture map rejected: ${parsed.error}`);
  return parsed.map;
}

describe("key bar bytes", () => {
  it.each<[BarKey, string]>([
    ["escape", "\x1b"],
    ["tab", "\t"],
    ["enter", "\r"],
    ["up", "\x1b[A"],
    ["down", "\x1b[B"],
    ["right", "\x1b[C"],
    ["left", "\x1b[D"],
  ])("sends %s as a desktop keyboard would", (key, bytes) => {
    expect(barBytes(key, plain)).toBe(bytes);
  });

  it("sends newline as the key map's Shift+Enter, ESC CR by default", () => {
    expect(barBytes("newline", plain)).toBe("\x1b\r");
  });

  it("sends arrows in application cursor form when the program asks for it", () => {
    expect(barBytes("up", { ...plain, appCursor: true })).toBe("\x1bOA");
    expect(barBytes("left", { ...plain, appCursor: true })).toBe("\x1bOD");
  });

  it("sends Ctrl+arrow in xterm's modifier form, in either cursor mode", () => {
    expect(barBytes("right", { ...plain, ctrl: true })).toBe("\x1b[1;5C");
    expect(barBytes("right", { ...plain, ctrl: true, appCursor: true })).toBe("\x1b[1;5C");
  });

  it("keeps newline a newline with Ctrl armed, never the CR that submits", () => {
    expect(barBytes("newline", { ...plain, ctrl: true })).toBe("\x1b\r");
    expect(barBytes("tab", { ...plain, ctrl: true })).toBe("\t");
  });

  it("sends newline as ESC CR even where Shift+Enter is unbound, never the CR that submits", () => {
    const keyMap = parsedMap({ "shift+enter": null });
    expect(barBytes("newline", { ...plain, keyMap })).toBe("\x1b\r");
  });

  it("takes a user's binding for a bar key over the default", () => {
    const keyMap = parsedMap({ escape: "E", "shift+enter": "\n", "ctrl+arrowup": "U" });
    expect(barBytes("escape", { ...plain, keyMap })).toBe("E");
    expect(barBytes("newline", { ...plain, keyMap })).toBe("\n");
    expect(barBytes("up", { ...plain, keyMap, ctrl: true })).toBe("U");
  });
});

describe("Ctrl on a typed character", () => {
  it.each([
    ["c", "\x03"],
    ["C", "\x03"],
    ["a", "\x01"],
    ["z", "\x1a"],
    ["@", "\x00"],
    [" ", "\x00"],
    ["[", "\x1b"],
    ["_", "\x1f"],
    ["?", "\x7f"],
    ["2", "\x00"],
    ["3", "\x1b"],
    ["7", "\x1f"],
    ["/", "\x1f"],
    ["-", "\x1f"],
    ["8", "\x7f"],
  ])("turns %j into its control code", (typed, code) => {
    expect(withCtrl(typed)).toBe(code);
  });

  it("leaves what has no control code, or is more than one character, as typed", () => {
    expect(withCtrl("1")).toBe("1");
    expect(withCtrl("é")).toBe("é");
    expect(withCtrl("ß")).toBe("ß");
    expect(withCtrl("ı")).toBe("ı");
    expect(withCtrl("ab")).toBe("ab");
  });
});

function view(kind: "agent" | "shell" = "shell", focused = false) {
  return {
    kind,
    press: vi.fn<(key: BarKey) => void>(),
    focus: vi.fn<() => void>(),
    holdsFocus: () => focused,
  };
}

describe("key bar store", () => {
  it("types into the agent's terminal until another is engaged", () => {
    const store = keyBarStore();
    const agent = view("agent");
    const shell = view();
    store.register(agent);
    store.register(shell);
    expect(store.target()).toBe(agent);
    store.engaged(shell);
    expect(store.target()).toBe(shell);
  });

  it("prefers the terminal focus is in over the agent's, before any is engaged", () => {
    const store = keyBarStore();
    store.register(view("agent"));
    const shell = view("shell", true);
    store.register(shell);
    expect(store.target()).toBe(shell);
  });

  it("types into the newest view when none is an agent's or has focus", () => {
    const store = keyBarStore();
    store.register(view());
    const newest = view();
    store.register(newest);
    expect(store.target()).toBe(newest);
  });

  it("falls back when the engaged view goes", () => {
    const store = keyBarStore();
    const agent = view("agent");
    const shell = view();
    store.register(agent);
    const unregister = store.register(shell);
    store.engaged(shell);
    unregister();
    expect(store.target()).toBe(agent);
  });

  it("has no target once every view has gone", () => {
    const store = keyBarStore();
    store.register(view())();
    expect(store.target()).toBeUndefined();
  });

  it("arms Ctrl for one key only", () => {
    const store = keyBarStore();
    store.setCtrl(true);
    expect(store.takeCtrl()).toBe(true);
    expect(store.takeCtrl()).toBe(false);
  });

  it("releases Ctrl when the target changes, so it never lands on another terminal", () => {
    const store = keyBarStore();
    store.register(view("agent"));
    const shell = view();
    store.register(shell);
    store.setCtrl(true);
    store.engaged(shell);
    expect(store.ctrl()).toBe(false);
  });

  it("tells subscribers when Ctrl, the views or the layout change, and only then", () => {
    const store = keyBarStore();
    const changed = vi.fn<() => void>();
    store.subscribe(changed);
    store.register(view());
    store.setCtrl(true);
    store.setCtrl(true);
    store.takeCtrl();
    store.setLayout({ bar: 53 });
    store.setLayout({ bar: 53 });
    store.setLayout(null);
    expect(changed).toHaveBeenCalledTimes(5);
  });
});

describe("lift above the soft keyboard", () => {
  it("is how far the visible viewport's bottom sits above the layout viewport's", () => {
    expect(lift(800, { height: 500, offsetTop: 0 })).toBe(300);
    expect(lift(800, { height: 500, offsetTop: 100 })).toBe(200);
  });

  it("is zero when nothing covers the page, or the browser has no visual viewport", () => {
    expect(lift(800, { height: 800, offsetTop: 0 })).toBe(0);
    expect(lift(800, { height: 820, offsetTop: 0 })).toBe(0);
    expect(lift(800, null)).toBe(0);
  });
});

describe("which devices get the key bar", () => {
  const iPad =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";
  const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0";

  it("gives it to a phone, and to an iPad with a trackpad and keyboard", () => {
    expect(wantsKeyBar({ coarse: true, maxTouchPoints: 5, userAgent: "iPhone" })).toBe(true);
    expect(wantsKeyBar({ coarse: false, maxTouchPoints: 5, userAgent: iPad })).toBe(true);
  });

  it("leaves it off a touch-screen laptop and a Mac, whose keyboards have every key", () => {
    expect(wantsKeyBar({ coarse: false, maxTouchPoints: 10, userAgent: windows })).toBe(false);
    expect(wantsKeyBar({ coarse: false, maxTouchPoints: 0, userAgent: iPad })).toBe(false);
  });
});

describe("the soft keyboard, once the viewport settles", () => {
  it("is a change of a keyboard's height in how much of the page is covered", () => {
    expect(settled(0, 800, { height: 450, scale: 1 })).toEqual({ covered: 350, keyboard: true });
    expect(settled(350, 800, { height: 800, scale: 1 })).toEqual({ covered: 0, keyboard: true });
  });

  it("is not a toolbar collapsing as the page scrolls", () => {
    expect(settled(0, 800, { height: 750, scale: 1 })).toEqual({ covered: 50, keyboard: false });
  });

  it("is never read while the user has zoomed in", () => {
    expect(settled(0, 800, { height: 300, scale: 2 })).toBeNull();
  });
});

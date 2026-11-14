import { describe, expect, it, vi } from "vitest";
import { barBytes, keyBarStore, lift, withCtrl, type BarKey } from "./bar-keys.ts";
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

const view = () => ({ press: vi.fn<(key: BarKey) => void>(), focus: vi.fn<() => void>() });

describe("key bar store", () => {
  it("types into the last view mounted until another is engaged", () => {
    const store = keyBarStore();
    const agent = view();
    const shell = view();
    store.register(agent);
    store.register(shell);
    expect(store.target()).toBe(shell);
    store.engaged(agent);
    expect(store.target()).toBe(agent);
  });

  it("falls back to the view mounted last when its target goes", () => {
    const store = keyBarStore();
    const agent = view();
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
    const agent = view();
    store.register(agent);
    store.register(view());
    store.setCtrl(true);
    store.engaged(agent);
    expect(store.ctrl()).toBe(false);
  });

  it("tells subscribers when Ctrl or the views change", () => {
    const store = keyBarStore();
    const changed = vi.fn<() => void>();
    store.subscribe(changed);
    store.register(view());
    store.setCtrl(true);
    store.takeCtrl();
    expect(changed).toHaveBeenCalledTimes(3);
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

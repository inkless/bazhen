import { describe, expect, it } from "vitest";
import {
  APPLE_KEY_MAP,
  DEFAULT_KEY_MAP,
  isApple,
  matchKey,
  parseKeyMap,
  type KeyChord,
  type KeyMap,
} from "./keymap.ts";

function keydown(key: string, mods: Partial<KeyChord> = {}): KeyChord {
  return {
    type: "keydown",
    key,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 13,
    ...mods,
  };
}

function parsedMap(raw: unknown): KeyMap {
  const parsed = parseKeyMap(raw);
  if (!parsed.ok) throw new Error(`fixture map rejected: ${parsed.error}`);
  return parsed.map;
}

describe("terminal key map", () => {
  it("sends ESC CR for Shift+Enter by default", () => {
    expect(matchKey(keydown("Enter", { shiftKey: true }), DEFAULT_KEY_MAP)).toBe("\x1b\r");
  });

  it("sends Esc for Cmd+. on Apple's platforms, for an iPad keyboard with no Esc key", () => {
    expect(matchKey(keydown(".", { metaKey: true }), APPLE_KEY_MAP)).toBe("\x1b");
    expect(matchKey(keydown(".", { metaKey: true }), DEFAULT_KEY_MAP)).toBeNull();
  });

  it("knows an iPad by its Mac user agent, and Windows as not Apple's", () => {
    const iPad =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";
    const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0";
    expect([isApple(iPad), isApple(windows)]).toEqual([true, false]);
  });

  it("unbinds a default chord bound to null, leaving the key to xterm.js", () => {
    const map = parsedMap({ "shift+enter": null });
    expect(matchKey(keydown("Enter", { shiftKey: true }), map)).toBeNull();
  });

  it("leaves plain Enter to xterm.js, so it still submits", () => {
    expect(matchKey(keydown("Enter"), DEFAULT_KEY_MAP)).toBeNull();
  });

  it("does not match Ctrl+Shift+Enter against a Shift+Enter binding", () => {
    expect(
      matchKey(keydown("Enter", { shiftKey: true, ctrlKey: true }), DEFAULT_KEY_MAP),
    ).toBeNull();
  });

  it("leaves a key pressed during IME composition to the IME", () => {
    expect(
      matchKey(keydown("Enter", { shiftKey: true, isComposing: true }), DEFAULT_KEY_MAP),
    ).toBeNull();
  });

  it("leaves the key that ends a Safari IME composition to the IME", () => {
    expect(
      matchKey(keydown("Enter", { shiftKey: true, keyCode: 229 }), DEFAULT_KEY_MAP),
    ).toBeNull();
  });

  it("applies a user binding written in kitty's chord style", () => {
    expect(matchKey(keydown("Enter", { ctrlKey: true }), parsedMap({ "ctrl+enter": "\n" }))).toBe(
      "\n",
    );
  });

  it("rejects a whole map when any chord names an unknown modifier", () => {
    expect(parseKeyMap({ "shift+enter": "\x1b\r", "hyper+enter": "x" })).toMatchObject({
      ok: false,
    });
  });

  it("rejects a map whose binding is not a string of bytes", () => {
    expect(parseKeyMap({ "shift+enter": 13 })).toMatchObject({ ok: false });
  });

  it("reads a chord whatever the order and case of its modifiers", () => {
    const map = parsedMap({ "Shift+Ctrl+Enter": "x" });
    expect(matchKey(keydown("Enter", { shiftKey: true, ctrlKey: true }), map)).toBe("x");
  });

  it("keeps the default bindings under a user's own", () => {
    const map = parsedMap({ "ctrl+enter": "\n" });
    expect(matchKey(keydown("Enter", { shiftKey: true }), map)).toBe("\x1b\r");
  });
});

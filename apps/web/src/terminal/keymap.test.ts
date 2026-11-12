import { describe, expect, it } from "vitest";
import { DEFAULT_KEY_MAP, matchKey, parseKeyMap, type KeyChord, type KeyMap } from "./keymap.ts";

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

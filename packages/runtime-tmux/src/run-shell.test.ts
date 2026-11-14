import { describe, expect, it } from "vitest";
import { paneHook } from "./index.ts";

describe("paneHook", () => {
  it("quotes each word for the shell and tmux, and appends the pane's id as a format", () => {
    expect(paneHook(["/a b/hook", "pane-title", `/s"$x\\y`])).toBe(
      `run-shell -b "'/a b/hook' 'pane-title' '/s\\"\\$x\\\\y' '#{pane_id}' >/dev/null 2>&1 || :"`,
    );
  });

  it("doubles a # in a word, so tmux takes it as itself and not as a format", () => {
    expect(paneHook(["/run/#{session_name}/hook", "it's"])).toBe(
      `run-shell -b "'/run/##{session_name}/hook' 'it'\\\\''s' '#{pane_id}' >/dev/null 2>&1 || :"`,
    );
  });
});

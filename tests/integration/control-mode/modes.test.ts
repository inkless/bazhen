import { afterEach, describe, expect, it } from "vitest";
import type { ConfiguredTmuxServer } from "@bazhen/host-guard";
import { newTerminal, report, sleep, spikeServer } from "./spike.ts";

const servers: ConfiguredTmuxServer[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.kill();
});

// Each mode a program can set that a view opening later must know, with the formats that might
// expose it. A format tmux doesn't know prints as empty.
const MODES: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ["bracketed paste", "\\033[?2004h", ["bracket_paste_flag", "pane_bracket_paste"]],
  ["DECCKM cursor keys", "\\033[?1h", ["keypad_cursor_flag"]],
  ["application keypad", "\\033=", ["keypad_flag"]],
  ["mouse 1000", "\\033[?1000h", ["mouse_standard_flag", "mouse_any_flag"]],
  ["mouse 1002", "\\033[?1002h", ["mouse_button_flag", "mouse_any_flag"]],
  ["mouse 1003", "\\033[?1003h", ["mouse_all_flag", "mouse_any_flag"]],
  ["mouse SGR 1006", "\\033[?1006h", ["mouse_sgr_flag"]],
  ["mouse UTF-8 1005", "\\033[?1005h", ["mouse_utf8_flag"]],
  ["alternate screen", "\\033[?1049h", ["alternate_on"]],
  ["cursor hidden", "\\033[?25l", ["cursor_flag"]],
  ["scroll region 5-20", "\\033[5;20r", ["scroll_region_upper", "scroll_region_lower"]],
  ["origin mode", "\\033[?6h", ["origin_flag"]],
  ["insert mode", "\\033[4h", ["insert_flag"]],
  ["autowrap off", "\\033[?7l", ["wrap_flag"]],
  ["focus reports", "\\033[?1004h", ["focus_flag", "pane_focus_flag"]],
  ["cursor style bar", "\\033[5 q", ["cursor_shape", "cursor_style", "cursor_blinking"]],
  ["extended keys (kitty)", "\\033[>1u", ["pane_key_mode", "extended_keys_flag"]],
  ["extended keys (xterm)", "\\033[>4;2m", ["pane_key_mode", "extended_keys_flag"]],
  ["pen red, no reset", "\\033[31m", ["cursor_colour"]],
];

function read(server: ConfiguredTmuxServer, pane: string, formats: readonly string[]): string[] {
  const line = formats.map((f) => `#{${f}}`).join("\t");
  return server.runSync(["display-message", "-p", "-t", pane, line]).replace(/\n$/, "").split("\t");
}

async function probe(name: string, seq: string, formats: readonly string[]) {
  const server = spikeServer(`modes-${servers.length}`);
  servers.push(server);
  const off = newTerminal(server, "off", "sh -c 'exec sleep 3600'");
  const on = newTerminal(server, "on", `sh -c 'printf "${seq}"; exec sleep 3600'`);
  await sleep(300);
  const before = read(server, off.pane, formats);
  const after = read(server, on.pane, formats);
  const exposed = formats.filter((_f, i) => before[i] !== after[i]);
  const row = { mode: name, formats, off: before, on: after, exposedBy: exposed };
  report("late-joiner-mode", row);
  server.kill();
  return row;
}

describe("a view opening late learns the pane's modes from formats", () => {
  it.each(MODES)("%s", async (name, seq, formats) => {
    const row = await probe(name, seq, formats);
    expect(row.formats.length).toBeGreaterThan(0);
  });
});

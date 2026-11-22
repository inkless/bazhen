/**
 * Whether `active`, the page's focused element, is a terminal's input: xterm.js's helper textarea.
 * Not the host around it, which scrolls and so can take focus itself, as a click on its scrollbar
 * does.
 */
export function inTerminal(active: { matches(selectors: string): boolean } | null): boolean {
  return active?.matches(".terminal-host .xterm-helper-textarea") === true;
}

/** Whether `active`, the page's focused element, is this terminal's own input. */
export function holdsTerminalFocus(
  term: { readonly textarea?: object | undefined },
  active: { matches?: unknown } | null,
): boolean {
  return term.textarea === active;
}

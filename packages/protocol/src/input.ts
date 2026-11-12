const ESC = "\\x1b";

/**
 * Reports a terminal sends on its own, not keystrokes: focus in and out, and mouse reports in the
 * SGR, urxvt and X10 encodings. tmux turns focus reporting on in every view's terminal, so a view
 * sends them whatever the program asked for.
 */
const EVENT_REPORT = new RegExp(
  [
    `${ESC}\\[[IO]`,
    `${ESC}\\[<\\d+;\\d+;\\d+[Mm]`,
    `${ESC}\\[\\d+;\\d+;\\d+M`,
    `${ESC}\\[M[\\s\\S]{3}`,
  ].join("|"),
  "g",
);

/**
 * A view's input without its focus and mouse reports: what a person typed or pasted. Only that
 * asks for the lease (foundation-design §4.3); a report never does, so an old driver losing focus,
 * or a mouse moving over a view that isn't driving, can't take it.
 */
export function withoutEventReports(text: string): string {
  return text.replace(EVENT_REPORT, "");
}

/** JSON from a peer, or undefined when it isn't JSON: a frame's schema then rejects it. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

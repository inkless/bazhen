import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  EPOCH_FRAMES_SINCE,
  isAtLeast,
  parseJson,
  PROTOCOL_VERSION,
  StreamServerFrame,
  withoutEventReports,
  type StreamClientFrame,
  type TuiTheme,
} from "@bazhen/protocol";
import { matchKey } from "./keymap.ts";
import { Backoff } from "./reconnect.ts";
import { wheelAction, type TerminalKind } from "./scroll.ts";
import { attachScrollInput } from "./scroll-input.ts";
import { loadSettings } from "./settings.ts";
import { attachTakeover } from "./takeover.ts";
import { terminalTheme } from "./theme.ts";
import { pageTheme } from "../ui/theme.ts";

type Status =
  | { kind: "connecting" }
  | { kind: "viewing" }
  | { kind: "driving" }
  | { kind: "reconnecting" }
  | { kind: "ended"; message: string };

interface Report {
  readonly status: Status;
  /** Something that went wrong without ending the view. */
  readonly notice: string | null;
}

/** One terminal's real screen, interactive, as foundation-design §5.9 sets it out. */
export function TerminalView({
  terminalId,
  kind,
  scheme,
  height = "70vh",
}: {
  terminalId: string;
  kind: TerminalKind;
  /** The theme its program was started for, which it is drawn in whatever the page's. */
  scheme: TuiTheme;
  /** How tall it is drawn, as a CSS length: less when a shell dock shares the screen. */
  height?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [report, setReport] = useState<Report>({ status: { kind: "connecting" }, notice: null });

  useEffect(() => {
    const element = host.current;
    return element === null ? undefined : connect(element, terminalId, kind, scheme, setReport);
  }, [terminalId, kind, scheme]);

  const { status, notice } = report;
  return (
    <section aria-label="terminal">
      {status.kind === "ended" ? (
        <p role="alert">{status.message}</p>
      ) : (
        <p aria-live="polite">{STATUS_TEXT[status.kind]}</p>
      )}
      {notice !== null && <p role="status">{notice}</p>}
      <div
        ref={host}
        // xterm.js paints whole rows; the strip below the last one is the host's.
        style={{
          height,
          background: "var(--color-terminal-bg)",
          colorScheme: scheme,
        }}
      />
    </section>
  );
}

const STATUS_TEXT = {
  connecting: "Connecting…",
  viewing: "Viewing — click to type",
  driving: "Driving",
  reconnecting: "Reconnecting…",
} as const;

/**
 * Renders the terminal's stream into `element` and sends what the user types while this view
 * drives. Returns the teardown.
 */
function connect(
  element: HTMLElement,
  terminalId: string,
  kind: TerminalKind,
  scheme: TuiTheme,
  onReport: (report: Report) => void,
) {
  const settings = loadSettings(localStorage);
  const page = pageTheme();
  const colours = () => terminalTheme(scheme, page.moreContrast());
  const term = new Xterm({
    theme: colours(),
    // Bold is weight, not colour: bright white in light, or bright black in dark, is another
    // colour a program didn't ask for.
    drawBoldTextInBrightColors: false,
    allowProposedApi: true,
    cursorBlink: true,
    macOptionIsMeta: settings.optionIsMeta,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.open(element);
  loadRenderer(term);
  fit.fit();
  swallowReplies(term);

  let status: Status = { kind: "connecting" };
  let notice = settings.problem;
  const report = (next: Partial<Report>) => {
    status = next.status ?? status;
    notice = next.notice === undefined ? notice : next.notice;
    onReport({ status, notice });
  };
  report({});

  const encoder = new TextEncoder();
  const backoff = new Backoff();
  let ws: WebSocket | undefined;
  let attached = false;
  let driving = false;
  /** The latest lease epoch, and whether the daemon reads the epoch input is typed under. */
  let epoch: number | undefined;
  let declares = false;
  let wantsToDrive = false;
  /** Whether the program is on its alternate screen, which only the daemon can see. */
  let alternate = false;
  let over = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const unhook = exposeForTests(terminalId, term, () => alternate);

  const send = (frame: StreamClientFrame) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  /** What it types from now on counts only under this epoch (§4.3). */
  const declare = () => {
    if (declares && epoch !== undefined) send({ type: "epoch", epoch });
  };
  const engage = () => {
    if (attached) send({ type: "engage" });
    else wantsToDrive = true;
  };
  /**
   * Input goes only from the driver. Anything else is dropped; a keystroke also asks for the
   * lease, a focus or mouse report or a scroll never does (§4.3).
   */
  const input = (bytes: Uint8Array<ArrayBuffer>, keystroke: boolean) => {
    if (driving && ws?.readyState === WebSocket.OPEN) ws.send(bytes);
    else if (keystroke) engage();
  };
  const end = (message: string) => {
    over = true;
    ws?.close();
    report({ status: { kind: "ended", message } });
  };

  const open = () => {
    const socket = new WebSocket(
      `${location.origin.replace("http", "ws")}/v1/terminals/${terminalId}/stream`,
    );
    ws = socket;
    epoch = undefined;
    declares = false;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      const { cols, rows } = term;
      send({ type: "hello", protocolVersion: PROTOCOL_VERSION, mode: "interactive", cols, rows });
    });
    socket.addEventListener("message", (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data !== "string") {
        term.write(new Uint8Array(e.data));
        return;
      }
      const frame = StreamServerFrame.safeParse(parseJson(e.data));
      if (!frame.success) return end("The daemon sent a frame this page can't read.");
      const f = frame.data;
      if (f.type === "snapshot_start") term.reset();
      else if (f.type === "snapshot_end") backoff.reset();
      else if (f.type === "screen") alternate = f.alternate;
      else if (f.type === "attached") {
        attached = true;
        declares = isAtLeast(f.protocolVersion ?? "1.0", EPOCH_FRAMES_SINCE);
        declare();
        // A view focused before its socket opened saw no focus event to claim the lease with.
        if (wantsToDrive || element.contains(document.activeElement)) engage();
        wantsToDrive = false;
      } else if (f.type === "lease") {
        epoch = f.epoch;
        declare();
        driving = f.driver;
        report({ status: { kind: driving ? "driving" : "viewing" } });
      } else if (f.type === "notice") report({ notice: f.message });
      else if (f.type === "error") end(`The daemon refused this view: ${f.message}`);
      else if (f.type === "exit") end("The terminal has closed.");
      // The daemon closes the socket next; its close is what reattaches.
      else if (f.type === "ended") report({ status: { kind: "reconnecting" } });
    });
    socket.addEventListener("close", () => {
      if (ws !== socket || over) return;
      attached = driving = false;
      report({ status: { kind: "reconnecting" }, notice: null });
      retry = setTimeout(open, backoff.next());
    });
  };
  open();

  term.attachCustomKeyEventHandler((event) => {
    const text = matchKey(event, settings.keyMap);
    if (text === null) return true;
    input(encoder.encode(text), true);
    event.preventDefault();
    return false;
  });
  const route = () =>
    wheelAction({ mouseTracking: term.modes.mouseTrackingMode !== "none", alternate, kind });
  const detachScroll = attachScrollInput(element, term, route, (bytes) => input(bytes, false));
  const typed = term.onData((data) =>
    input(encoder.encode(data), withoutEventReports(data) !== ""),
  );
  // Only X10 mouse reports come this way.
  const binary = term.onBinary((data) => input(latin1(data), false));
  const resize = term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
  const observer = new ResizeObserver(() => fit.fit());
  observer.observe(element);
  const detachTakeover = attachTakeover(element, engage);
  // A contrast preference can change while it is open; it repaints in place.
  const unfollow = page.subscribe(() => {
    term.options.theme = colours();
  });
  return () => {
    over = true;
    unfollow();
    clearTimeout(retry);
    detachTakeover();
    detachScroll();
    observer.disconnect();
    typed.dispose();
    binary.dispose();
    resize.dispose();
    ws?.close();
    term.dispose();
    unhook();
  };
}

/**
 * WebGL where it draws correctly, xterm.js's DOM renderer otherwise. Under phone emulation WebGL
 * drew every glyph about twice too large while the DOM renderer was right, so a touch-first
 * device gets the DOM renderer.
 */
function loadRenderer(term: Xterm): void {
  if (matchMedia("(pointer: coarse)").matches) return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // No WebGL in this browser: the DOM renderer is already drawing.
  }
}

/**
 * The daemon answers the terminal queries tmux's client asks (foundation-design §5.4). A browser
 * answering too would send its reply as input, and from a view that isn't driving it would ask
 * for the lease. These are the queries xterm.js 6 answers.
 */
function swallowReplies(term: Xterm): void {
  const { parser } = term;
  parser.registerCsiHandler({ final: "c" }, swallow);
  parser.registerCsiHandler({ prefix: ">", final: "c" }, swallow);
  parser.registerCsiHandler({ prefix: ">", final: "q" }, swallow);
  parser.registerCsiHandler({ final: "n" }, swallow);
  parser.registerCsiHandler({ prefix: "?", final: "n" }, swallow);
  parser.registerCsiHandler({ intermediates: "$", final: "p" }, swallow);
  parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, swallow);
  parser.registerCsiHandler({ final: "t" }, swallow);
  parser.registerDcsHandler({ intermediates: "$", final: "q" }, swallow);
  for (const id of [4, 10, 11, 12]) parser.registerOscHandler(id, (data) => data.includes("?"));
}

const swallow = () => true;

/**
 * For browser tests, per view: the screen as text, the top line in view, whether the view is at
 * the bottom (not scrolled back into the page's own scrollback), whether the daemon
 * reported the alternate screen, the background it paints, and the colours a program wrote text
 * in, whichever renderer draws.
 */
function exposeForTests(terminalId: string, term: Xterm, alternate: () => boolean): () => void {
  const views: Record<string, unknown> = Reflect.get(globalThis, "bazhenViews") ?? {};
  Reflect.set(globalThis, "bazhenViews", views);
  views[terminalId] = {
    screen: () => screenText(term),
    viewportTop: () => term.buffer.active.viewportY,
    atBottom: () => term.buffer.active.viewportY === term.buffer.active.baseY,
    alternate,
    background: () => term.options.theme?.background,
    foregrounds: () => foregrounds(term),
  };
  return () => delete views[terminalId];
}

/**
 * Each colour the text on screen, not in its history, is written in, once, as the program named
 * it: `#rrggbb`, a palette index, or `default`.
 */
function foregrounds(term: Xterm): string[] {
  const buffer = term.buffer.active;
  const seen = new Set<string>();
  for (let y = buffer.viewportY; y < buffer.viewportY + term.rows; y++) {
    const line = buffer.getLine(y);
    const width = line?.length ?? 0;
    for (let x = 0; x < width; x++) {
      const cell = line?.getCell(x);
      if (cell === undefined || cell.getChars().trim() === "") continue;
      if (cell.isFgRGB()) seen.add(`#${cell.getFgColor().toString(16).padStart(6, "0")}`);
      else if (cell.isFgPalette()) seen.add(String(cell.getFgColor()));
      else seen.add("default");
    }
  }
  return [...seen];
}

function screenText(term: Xterm): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

/** A string of byte values, as xterm.js hands binary input over. */
const latin1 = (data: string) => Uint8Array.from(data, (c) => c.charCodeAt(0));

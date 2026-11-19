import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  parseJson,
  StreamServerFrame,
  withoutEventReports,
  type StreamClientFrame,
  type TuiTheme,
} from "@bazhen/protocol";
import { Heartbeat, PING_EVERY_MS } from "./heartbeat.ts";
import { barBytes, keyBar, withCtrl, type BarTarget } from "./bar-keys.ts";
import { guardClose } from "./close-guard.ts";
import { closeNotice, offersInstall, pageNow, thisPlatform } from "../install.ts";
import { isApple, matchKey } from "./keymap.ts";
import { statusText, type Status } from "./status.ts";
import { Backoff } from "./reconnect.ts";
import { PAGE_PROTOCOL, checkBuild } from "../api.ts";
import {
  onAlternateScreen,
  scrollbackFor,
  startSnapshot,
  wheelAction,
  type TerminalKind,
} from "./scroll.ts";
import { attachScrollInput } from "./scroll-input.ts";
import { terminalFontFamily, terminalFontLoaded } from "./font.ts";
import { loadSettings, type TerminalSettings } from "./settings.ts";
import { deviceStorage } from "../storage.ts";
import { attachTakeover } from "./takeover.ts";
import { terminalTheme } from "./theme.ts";
import { LiveStatus } from "../ui/LiveStatus.tsx";
import { pageTheme } from "../ui/theme.ts";

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
}: {
  terminalId: string;
  kind: TerminalKind;
  /** The theme its program was started for, which it is drawn in whatever the page's. */
  scheme: TuiTheme;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [report, setReport] = useState<Report>({ status: { kind: "connecting" }, notice: null });

  useEffect(() => {
    const element = host.current;
    if (element === null) return undefined;
    const settings = loadSettings(deviceStorage, isApple(navigator.userAgent));
    let live = true;
    let teardown: (() => void) | undefined;
    void terminalFontLoaded(settings.fontFamily).then(() => {
      if (live) teardown = connect(element, terminalId, kind, scheme, settings, setReport);
    });
    return () => {
      live = false;
      teardown?.();
    };
  }, [terminalId, kind, scheme]);

  const { status, notice } = report;
  return (
    <section aria-label="terminal" className="terminal">
      {status.kind === "ended" ? (
        <p role="alert">{status.message}</p>
      ) : (
        <>
          <p aria-hidden>{statusText(status)}</p>
          <LiveStatus text={statusText(status)} />
        </>
      )}
      {notice !== null && <p role="status">{notice}</p>}
      <div
        ref={host}
        className="terminal-host"
        // xterm.js paints whole rows; the strip below the last one is the host's.
        style={{ colorScheme: scheme }}
      />
    </section>
  );
}

/**
 * Renders the terminal's stream into `element` and sends what the user types while this view
 * drives. Returns the teardown.
 */
function connect(
  element: HTMLElement,
  terminalId: string,
  kind: TerminalKind,
  scheme: TuiTheme,
  settings: TerminalSettings,
  onReport: (report: Report) => void,
) {
  const page = pageTheme();
  const colours = () => terminalTheme(scheme, page.moreContrast());
  const term = new Xterm({
    theme: colours(),
    fontFamily: terminalFontFamily(settings.fontFamily),
    // Bold is weight, not colour: bright white in light, or bright black in dark, is another
    // colour a program didn't ask for.
    drawBoldTextInBrightColors: false,
    allowProposedApi: true,
    cursorBlink: true,
    macOptionIsMeta: settings.optionIsMeta,
    scrollback: scrollbackFor(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.open(element);
  notAFormField(term);
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
  let heartbeat = new Heartbeat();
  let ws: WebSocket | undefined;
  let attached = false;
  let driving = false;
  /** Whether another view drives, and the name of the device it is on, when it is on one. */
  let driven = false;
  let driverDevice: string | undefined;
  /** This view's latest attachment and its token, which a reattach names so the daemon ends it. */
  let previous: { attachmentId: string; token: string } | undefined;
  /** Whether this view is coming back from a lost socket. */
  let returning = false;
  /** The latest lease epoch. */
  let epoch: number | undefined;
  let wantsToDrive = false;
  /** What the daemon last said of a screen switch the view's bytes don't carry (tmux's). */
  let daemonSaidAlternate = false;
  const alternate = () => onAlternateScreen(term, daemonSaidAlternate);
  let over = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const unhook = exposeForTests(terminalId, term, alternate, () => scroll.gliding());

  const send = (frame: StreamClientFrame) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  /** What it types from now on counts only under this epoch (§4.3). */
  const declare = () => {
    if (attached && epoch !== undefined) send({ type: "epoch", epoch });
  };
  const engage = () => {
    if (attached) send({ type: "engage" });
    else wantsToDrive = true;
  };
  /**
   * Input goes only from the driver. Anything else is dropped; a keystroke also asks for the
   * lease, a focus or mouse report or a scroll never does (§4.3).
   */
  const input = (bytes: Uint8Array<ArrayBuffer>, keystroke: boolean): boolean => {
    if (driving && ws?.readyState === WebSocket.OPEN) {
      ws.send(bytes);
      return true;
    }
    if (keystroke) engage();
    return false;
  };
  const leaseStatus = (): Status => {
    if (driving) return { kind: "driving" };
    return driven ? { kind: "taken", device: driverDevice } : { kind: "viewing" };
  };
  const end = (message: string) => {
    over = true;
    ws?.close();
    report({ status: { kind: "ended", message } });
  };

  /** The socket is gone, or as good as: reattach without waiting for it to say so. */
  const lost = (socket: WebSocket) => {
    if (ws !== socket || over) return;
    scroll.stopGlide();
    ws = undefined;
    attached = driving = driven = false;
    returning = true;
    report({ status: { kind: "reconnecting" }, notice: null });
    retry = setTimeout(open, backoff.next());
  };

  const open = () => {
    const socket = new WebSocket(
      `${location.origin.replace("http", "ws")}/v1/terminals/${terminalId}/stream`,
    );
    ws = socket;
    epoch = undefined;
    heartbeat = new Heartbeat();
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      const { cols, rows } = term;
      send({
        type: "hello",
        protocolId: PAGE_PROTOCOL,
        mode: "interactive",
        cols,
        rows,
        resumes: previous,
      });
    });
    socket.addEventListener("message", (e: MessageEvent<ArrayBuffer | string>) => {
      if (ws !== socket) return;
      if (heartbeat.heard() && status.kind === "checking") report({ status: leaseStatus() });
      if (typeof e.data !== "string") {
        term.write(new Uint8Array(e.data));
        return;
      }
      const frame = StreamServerFrame.safeParse(parseJson(e.data));
      if (!frame.success) return end("The daemon sent a frame this page can't read.");
      const f = frame.data;
      if (f.type === "snapshot_start") {
        // The view is redrawn from the top: a glide would carry on through the new screen.
        scroll.stopGlide();
        startSnapshot(term, f);
      } else if (f.type === "snapshot_end") backoff.reset();
      else if (f.type === "screen") daemonSaidAlternate = f.alternate;
      else if (f.type === "attached") {
        attached = true;
        declare();
        // A view focused before its socket opened saw no focus event to claim the lease with.
        // One coming back from a lost socket doesn't take the lease from a view that took it
        // meanwhile: only the user's next deliberate input does.
        const claims = wantsToDrive || element.contains(document.activeElement);
        if (claims && !(returning && driven)) engage();
        wantsToDrive = returning = false;
        const token = f.resumeToken;
        previous = token === undefined ? undefined : { attachmentId: f.attachmentId, token };
      } else if (f.type === "lease") {
        epoch = f.epoch;
        declare();
        driving = f.driver;
        driven = f.driven === true;
        driverDevice = f.driverDevice;
        report({ status: leaseStatus() });
      } else if (f.type === "notice") report({ notice: f.message });
      else if (f.type === "error") {
        // Refused as another build's page: the app's alert says so at once, rather than at the
        // event stream's next reconnect.
        checkBuild().catch(() => undefined);
        end(`The daemon refused this view: ${f.message}`);
      } else if (f.type === "exit") end("The terminal has closed.");
      // The daemon closes the socket next; its close is what reattaches.
      else if (f.type === "ended") report({ status: { kind: "reconnecting" } });
    });
    socket.addEventListener("close", () => lost(socket));
  };
  open();
  // A dead socket's close can take minutes to fire, so missed pongs reattach without it.
  const beating = setInterval(() => {
    const socket = ws;
    if (socket?.readyState !== WebSocket.OPEN || !attached) return;
    const beat = heartbeat.beat();
    if (beat === "dead") {
      lost(socket);
      socket.close();
      return;
    }
    // Keys typed now may go nowhere; say so.
    if (beat === "late" && driving) report({ status: { kind: "checking" } });
    send({ type: "ping" });
  }, PING_EVERY_MS);
  const shown = () => {
    if (document.visibilityState === "visible") heartbeat.resumed();
  };
  document.addEventListener("visibilitychange", shown);

  const bar = keyBar();
  /**
   * Sends a keystroke, with the bar's Ctrl if it is armed for this view, and releases Ctrl once the
   * key is sent. A key that only takes the lease leaves it armed for the key the user sends next.
   */
  const keystroke = (text: (ctrl: boolean) => string) => {
    // A key, typed or from the bar, ends a glide, as on a phone, before it reaches the program.
    scroll.stopGlide();
    const ctrl = bar.target() === target && bar.ctrl();
    if (input(encoder.encode(text(ctrl)), true) && ctrl) bar.takeCtrl();
  };
  term.attachCustomKeyEventHandler((event) => {
    const text = matchKey(event, settings.keyMap);
    if (text === null) return true;
    // Bound, it is the key an armed Ctrl was for, though it has no Ctrl form of its own.
    keystroke(() => text);
    event.preventDefault();
    return false;
  });
  const route = () =>
    wheelAction({
      mouseTracking: term.modes.mouseTrackingMode !== "none",
      alternate: alternate(),
      kind,
    });
  const scroll = attachScrollInput(element, term, route, (bytes) => input(bytes, false));
  const target: BarTarget = {
    kind,
    press: (key) =>
      keystroke((ctrl) =>
        barBytes(key, {
          keyMap: settings.keyMap,
          ctrl,
          appCursor: term.modes.applicationCursorKeysMode,
        }),
      ),
    focus: () => term.focus(),
    holdsFocus: () => element.contains(document.activeElement),
  };
  const unregister = bar.register(target);
  const unguard = offersInstall(thisPlatform())
    ? guardClose(
        { window, document },
        () => target.holdsFocus(),
        // Read on use: a tab Chrome moves into the app's window as it installs keeps this view.
        () => report({ notice: closeNotice(pageNow()) }),
      )
    : () => {};
  const typed = term.onData((data) => {
    // The bar's Ctrl, armed for the next key, applies to a letter typed on the soft keyboard.
    if (withoutEventReports(data) !== "") keystroke((ctrl) => (ctrl ? withCtrl(data) : data));
    else input(encoder.encode(data), false);
  });
  // Only X10 mouse reports come this way.
  const binary = term.onBinary((data) => input(latin1(data), false));
  const resize = term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
  const observer = new ResizeObserver(() => fit.fit());
  observer.observe(element);
  const detachTakeover = attachTakeover(element, engage);
  // The bar types into the terminal the user last touched, not one the window's focus reached.
  const aim = () => bar.engaged(target);
  element.addEventListener("pointerdown", aim);
  element.addEventListener("focusin", aim);
  // Focus leaving for anything but the bar, the soft keyboard closing say, ends what Ctrl was for.
  const left = (event: FocusEvent) => {
    const to = event.relatedTarget;
    const toBar = to instanceof Element && to.closest(".key-bar") !== null;
    if (!toBar && bar.target() === target) bar.setCtrl(false);
  };
  element.addEventListener("focusout", left);
  // A contrast preference can change while it is open; it repaints in place.
  const unfollow = page.subscribe(() => {
    term.options.theme = colours();
  });
  return () => {
    over = true;
    unfollow();
    clearTimeout(retry);
    clearInterval(beating);
    document.removeEventListener("visibilitychange", shown);
    detachTakeover();
    element.removeEventListener("pointerdown", aim);
    element.removeEventListener("focusin", aim);
    element.removeEventListener("focusout", left);
    unregister();
    unguard();
    scroll.detach();
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
 * xterm.js types through a hidden textarea, which iOS takes for a form field and offers to fill
 * with passwords, cards and addresses, and to correct and capitalise. xterm.js turns off
 * correction and spell checking; this turns off the rest a page can.
 */
function notAFormField(term: Xterm): void {
  const field = term.textarea;
  if (field === undefined) return;
  field.autocomplete = "off";
  field.autocapitalize = "none";
  field.setAttribute("autocorrect", "off");
  field.spellcheck = false;
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
 * the bottom (not scrolled back into the page's own scrollback), whether the program is on its
 * alternate screen, the background it paints, the colours a program wrote text in, whichever
 * renderer draws, and the font family it draws in.
 */
function exposeForTests(
  terminalId: string,
  term: Xterm,
  alternate: () => boolean,
  gliding: () => boolean,
): () => void {
  const views: Record<string, unknown> = Reflect.get(globalThis, "bazhenViews") ?? {};
  Reflect.set(globalThis, "bazhenViews", views);
  views[terminalId] = {
    screen: () => screenText(term),
    viewportTop: () => term.buffer.active.viewportY,
    atBottom: () => term.buffer.active.viewportY === term.buffer.active.baseY,
    alternate,
    gliding,
    background: () => term.options.theme?.background,
    foregrounds: () => foregrounds(term),
    fontFamily: () => term.options.fontFamily,
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

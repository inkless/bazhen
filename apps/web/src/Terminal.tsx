import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { PROTOCOL_VERSION, StreamServerFrame, type StreamClientFrame } from "@bazhen/protocol";

type Status =
  | { kind: "connecting" }
  | { kind: "viewing" }
  | { kind: "driving" }
  | { kind: "ended"; message: string };

/** One agent's real TUI, interactive. */
export function Terminal({ terminalId }: { terminalId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });

  useEffect(() => {
    const element = host.current;
    return element === null ? undefined : connect(element, terminalId, setStatus);
  }, [terminalId]);

  return (
    <section aria-label="terminal">
      {status.kind === "ended" ? (
        <p role="alert">{status.message}</p>
      ) : (
        <p>{status.kind === "driving" ? "Driving" : "Viewing — click to type"}</p>
      )}
      <div ref={host} style={{ height: "70vh" }} />
    </section>
  );
}

/**
 * Renders the terminal's stream into `element` and sends what the user types while this view
 * drives. A click, focus here, or the window gaining focus asks for the lease, so the first
 * keystroke after switching devices isn't lost; one made before the stream is attached is
 * replayed once it is (foundation-design §4.3). Returns the teardown.
 */
function connect(element: HTMLElement, terminalId: string, onStatus: (s: Status) => void) {
  const term = new Xterm({ cursorBlink: true });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(element);
  fit.fit();
  // For browser tests: the screen as text, whichever renderer draws it.
  Reflect.set(globalThis, "bazhenScreen", () => screenText(term));

  const ws = new WebSocket(
    `${location.origin.replace("http", "ws")}/v1/terminals/${terminalId}/stream`,
  );
  ws.binaryType = "arraybuffer";
  const encoder = new TextEncoder();
  let attached = false;
  let driving = false;
  let wantsToDrive = false;
  let ended = false;
  const send = (frame: StreamClientFrame) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  const end = (message: string) => {
    if (ended) return;
    ended = true;
    onStatus({ kind: "ended", message });
  };
  const engage = () => {
    if (attached) send({ type: "engage" });
    else wantsToDrive = true;
  };

  ws.addEventListener("open", () => {
    const { cols, rows } = term;
    send({ type: "hello", protocolVersion: PROTOCOL_VERSION, mode: "interactive", cols, rows });
    if (element.contains(document.activeElement)) wantsToDrive = true;
  });
  ws.addEventListener("message", (e: MessageEvent<ArrayBuffer | string>) => {
    if (typeof e.data !== "string") {
      term.write(new Uint8Array(e.data));
      return;
    }
    const frame = StreamServerFrame.safeParse(safeJson(e.data));
    if (!frame.success) return end("The daemon sent a frame this page can't read.");
    const f = frame.data;
    if (f.type === "attached") {
      attached = true;
      if (wantsToDrive) engage();
    } else if (f.type === "lease") {
      driving = f.driver;
      onStatus({ kind: driving ? "driving" : "viewing" });
    } else if (f.type === "error") end(`The daemon refused this view: ${f.message}`);
    else if (f.type === "exit") end("The agent's terminal has closed.");
  });
  ws.addEventListener("close", () => end("Disconnected from the daemon."));

  // A keystroke from a view that isn't driving asks for the lease and is itself dropped.
  const input = term.onData((data) => {
    if (driving) ws.send(encoder.encode(data));
    else engage();
  });
  const resize = term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
  const observer = new ResizeObserver(() => fit.fit());
  observer.observe(element);
  element.addEventListener("pointerdown", engage);
  element.addEventListener("focusin", engage);
  window.addEventListener("focus", engage);
  return () => {
    ended = true;
    element.removeEventListener("pointerdown", engage);
    element.removeEventListener("focusin", engage);
    window.removeEventListener("focus", engage);
    observer.disconnect();
    input.dispose();
    resize.dispose();
    ws.close();
    term.dispose();
    Reflect.deleteProperty(globalThis, "bazhenScreen");
  };
}

function screenText(term: Xterm): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

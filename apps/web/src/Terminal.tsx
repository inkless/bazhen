import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { PROTOCOL_VERSION, StreamServerFrame, type StreamClientFrame } from "@bazhen/protocol";

/** One agent's real TUI, interactive. */
export function Terminal({ terminalId }: { terminalId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [driving, setDriving] = useState(false);

  useEffect(() => {
    const element = host.current;
    return element === null ? undefined : connect(element, terminalId, setDriving);
  }, [terminalId]);

  return (
    <section aria-label="terminal">
      <p>{driving ? "Driving" : "Viewing — click to type"}</p>
      <div ref={host} style={{ height: "70vh" }} />
    </section>
  );
}

/**
 * Renders the terminal's stream into `element` and sends what the user types. A click, focus
 * here, or the window gaining focus takes the lease, so the first keystroke after switching
 * devices isn't lost (foundation-design §4.3). Returns the teardown.
 */
function connect(
  element: HTMLElement,
  terminalId: string,
  onLease: (driving: boolean) => void,
): () => void {
  const term = new Xterm({ cursorBlink: true });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(element);
  fit.fit();
  const ws = new WebSocket(
    `${location.origin.replace("http", "ws")}/v1/terminals/${terminalId}/stream`,
  );
  ws.binaryType = "arraybuffer";
  const open = () => ws.readyState === WebSocket.OPEN;
  const send = (frame: StreamClientFrame) => open() && ws.send(JSON.stringify(frame));
  const encoder = new TextEncoder();
  const engage = () => send({ type: "engage" });
  ws.addEventListener("open", () => {
    send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      mode: "interactive",
      cols: term.cols,
      rows: term.rows,
    });
    if (element.contains(document.activeElement)) engage();
  });
  ws.addEventListener("message", (e: MessageEvent<ArrayBuffer | string>) => {
    if (typeof e.data !== "string") {
      term.write(new Uint8Array(e.data));
      return;
    }
    const frame = StreamServerFrame.parse(JSON.parse(e.data));
    if (frame.type === "lease") onLease(frame.driver);
  });
  const input = term.onData((data) => open() && ws.send(encoder.encode(data)));
  const resize = term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
  const observer = new ResizeObserver(() => fit.fit());
  observer.observe(element);
  element.addEventListener("pointerdown", engage);
  element.addEventListener("focusin", engage);
  window.addEventListener("focus", engage);
  return () => {
    element.removeEventListener("pointerdown", engage);
    element.removeEventListener("focusin", engage);
    window.removeEventListener("focus", engage);
    observer.disconnect();
    input.dispose();
    resize.dispose();
    ws.close();
    term.dispose();
  };
}

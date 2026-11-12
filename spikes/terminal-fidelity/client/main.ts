import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";

const params = new URLSearchParams(location.search);
const name = params.get("name") ?? "shell";
const mode = params.get("mode") ?? "interactive";
const useWebgl = params.get("webgl") !== "0";

const term = new Terminal({
  allowProposedApi: true,
  scrollback: 5000,
  fontFamily: "Menlo, monospace",
  fontSize: Number(params.get("font") ?? 13),
  macOptionIsMeta: params.get("optmeta") !== "0",
  cursorBlink: false,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = "11";
term.open(document.getElementById("term")!);
let webgl = "off";
if (useWebgl) {
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => { webgl = "lost"; addon.dispose(); });
    term.loadAddon(addon);
    webgl = "on";
  } catch (e) {
    webgl = `failed: ${e}`;
  }
}
fit.fit();

const badge = document.getElementById("badge")!;
const sizeEl = document.getElementById("size")!;
const infoEl = document.getElementById("info")!;

// Exposed for Playwright.
const spike = {
  term,
  webgl,
  connected: false,
  driver: false,
  epoch: 0,
  snapshot: { started: 0, ended: 0, bytes: 0 },
  events: [] as unknown[],
  latency: [] as { ch: string; key: number; recv: number; parsed: number }[],
  pending: null as null | { ch: string; key: number; recv: number; typed: string },
  typed: "",
  oscs: [] as { id: number; data: string }[],
  sent: [] as { t: number; hex: string }[],
  exited: false,
  viewportText(): string[] {
    const b = term.buffer.active;
    const out: string[] = [];
    for (let i = b.viewportY; i < b.viewportY + term.rows; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
    return out;
  },
  allText(): string[] {
    const b = term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
    return out;
  },
  bufferType(): string { return term.buffer.active.type; },
};
(window as any).spike = spike;
for (const id of [8, 52, 133, 1337, 9]) {
  term.parser.registerOscHandler(id, (data) => { spike.oscs.push({ id, data }); return false; });
}

const enc = new TextEncoder();
const qs = mode === "observe" ? "" : `&cols=${term.cols}&rows=${term.rows}`;
const ws = new WebSocket(`ws://${location.host}/terminals/${name}/stream?mode=${mode}${qs}`);
ws.binaryType = "arraybuffer";
let inSnapshot = false;

function render(): void {
  badge.textContent = !spike.connected ? (spike.exited ? "exited" : "disconnected") : mode === "observe" ? "observe" : spike.driver ? "driver" : "viewing";
  badge.className = spike.driver ? "driver" : "viewing";
  sizeEl.textContent = `${term.cols}x${term.rows} epoch ${spike.epoch} webgl ${webgl}`;
}

ws.onopen = () => { spike.connected = true; render(); };
ws.onclose = () => { spike.connected = false; render(); };
ws.onmessage = (ev) => {
  if (typeof ev.data === "string") {
    const msg = JSON.parse(ev.data);
    spike.events.push({ at: performance.now(), ...msg });
    if (msg.type === "snapshot-start") { inSnapshot = true; spike.snapshot.started = performance.now(); }
    else if (msg.type === "snapshot-end") {
      inSnapshot = false;
      spike.snapshot.ended = performance.now();
      // A view that already has focus when it connects must claim the lease now: its focus event
      // fired before the socket existed, and FD §4.3 drops a non-driver's first keystroke.
      if (mode !== "observe" && document.activeElement === term.textarea) ws.send(JSON.stringify({ type: "focus" }));
    }
    else if (msg.type === "hello" && msg.replies === "daemon") {
      // The daemon answers terminal queries; a browser reply would be input, and from an observer
      // it would request the lease (FD §4.3).
      if (msg.cols !== term.cols || msg.rows !== term.rows) term.resize(msg.cols, msg.rows);
      const swallow = () => true;
      term.parser.registerCsiHandler({ final: "c" }, swallow);
      term.parser.registerCsiHandler({ prefix: ">", final: "c" }, swallow);
      term.parser.registerCsiHandler({ prefix: ">", final: "q" }, swallow);
      term.parser.registerCsiHandler({ final: "n" }, swallow);
      for (const id of [10, 11, 12]) term.parser.registerOscHandler(id, (d) => d.includes("?"));
    }
    else if (msg.type === "hello") { if (msg.cols !== term.cols || msg.rows !== term.rows) term.resize(msg.cols, msg.rows); }
    else if (msg.type === "lease") {
      const was = spike.driver;
      spike.driver = msg.driver;
      spike.epoch = msg.epoch;
      if (msg.driver) {
        fit.fit();
        if (!was) sendResize(true);
        if (msg.cols !== term.cols || msg.rows !== term.rows) sendResize(true);
      } else if (msg.cols !== term.cols || msg.rows !== term.rows) term.resize(msg.cols, msg.rows);
    } else if (msg.type === "exit") spike.exited = true;
    render();
    return;
  }
  const bytes = new Uint8Array(ev.data);
  if (inSnapshot) spike.snapshot.bytes += bytes.length;
  if (spike.pending && !spike.pending.recv) spike.pending.recv = performance.now();
  term.write(bytes);
};

term.onWriteParsed(() => {
  const p = spike.pending;
  if (!p) return;
  const tail = p.typed.slice(-6);
  if (spike.viewportText().some((l) => l.includes(tail))) {
    spike.latency.push({ ch: p.ch, key: p.key, recv: p.recv, parsed: performance.now() });
    spike.pending = null;
  }
});

function sendInput(data: string, binary = false): void {
  if (ws.readyState !== WebSocket.OPEN) return; // never buffer input across a disconnect
  const bytes = binary ? Uint8Array.from(data, (c) => c.charCodeAt(0)) : enc.encode(data);
  if (data.length === 1 && data >= " " && data <= "~" && !binary) {
    spike.typed += data;
    spike.pending = { ch: data, key: performance.now(), recv: 0, typed: spike.typed };
  }
  spike.sent.push({ t: performance.now(), hex: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") });
  ws.send(bytes);
}
term.onData((d) => sendInput(d));
term.onBinary((d) => sendInput(d, true));

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
function sendResize(now = false): void {
  clearTimeout(resizeTimer);
  const go = () => {
    if (mode === "observe") return;
    if (spike.driver || !spike.epoch) fit.fit();
    ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    render();
  };
  if (now) go();
  else resizeTimer = setTimeout(go, 150);
}
new ResizeObserver(() => {
  if (spike.driver || (!spike.epoch && mode !== "observe")) { fit.fit(); sendResize(); }
}).observe(document.getElementById("term")!);

const ta = term.textarea!;
ta.addEventListener("focus", () => {
  if (mode !== "observe" && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "focus" }));
});
term.focus();
infoEl.textContent = `${name} (${mode})`;
render();

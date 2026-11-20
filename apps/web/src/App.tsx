import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { HealthResponse } from "@bazhen/protocol";
import { PAGE_PROTOCOL, noticeUnpaired, onAnotherBuild, onUnpaired } from "./api.ts";
import { isAnotherBuild } from "./build.ts";
import { Dashboard } from "./Dashboard.tsx";
import { Pairing } from "./Pairing.tsx";
import { KeyBar } from "./terminal/KeyBar.tsx";
import { Button } from "./ui/Button.tsx";
import { ThemeSwitch } from "./ui/ThemeSwitch.tsx";
import { guardPan } from "./ui/pan-guard.ts";
import { followViewport } from "./ui/viewport.ts";

type Status =
  | { kind: "loading" }
  | { kind: "unpaired" }
  | { kind: "another-build" }
  | { kind: "ok"; health: HealthResponse }
  | { kind: "error"; message: string };

export function App() {
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  const probe = useCallback(() => {
    fetch("/v1/health")
      .then(noticeUnpaired)
      .then(async (res) => {
        if (res.status === 401) return;
        if (!res.ok) throw new Error(`daemon answered ${res.status}`);
        const reply: unknown = await res.json();
        if (isAnotherBuild(reply, PAGE_PROTOCOL)) {
          setStatus({ kind: "another-build" });
          return;
        }
        setStatus({ kind: "ok", health: HealthResponse.parse(reply) });
      })
      .catch((err: unknown) => setStatus({ kind: "error", message: String(err) }));
  }, []);

  // Any answer that says this browser must pair, from the probe or a later request, as after
  // `bazhen devices revoke`, swaps the dashboard for the pairing form.
  useEffect(() => onUnpaired(() => setStatus({ kind: "unpaired" })), []);
  // The dashboard goes with the page's build: it may misread what another build's daemon sends.
  useEffect(() => onAnotherBuild(() => setStatus({ kind: "another-build" })), []);
  useEffect(probe, [probe]);
  useAppViewport();
  const app = useRef<HTMLDivElement>(null);
  useEffect(() => (app.current === null ? undefined : guardPan(app.current)), []);

  return (
    <div ref={app} className="app">
      <main className="app-main">
        <header className="app-head">
          <h1>Bazhen</h1>
          {status.kind === "loading" && <p>Connecting to the daemon…</p>}
          {status.kind === "error" && <p role="alert">Daemon unavailable: {status.message}</p>}
          {status.kind === "another-build" && (
            <>
              <p role="alert">
                This page and the daemon are different builds of Bazhen. Reload the page; if this
                comes back, build and restart Bazhen: <code>moon run :build</code>, then{" "}
                <code>bazhen stop</code> and <code>bazhen start</code>.
              </p>
              {/* The dashboard it replaces may have held focus, which would be left nowhere. */}
              <Button variant="primary" autoFocus onPress={() => location.reload()}>
                Reload
              </Button>
            </>
          )}
          {status.kind === "ok" && (
            <dl>
              <dt>Daemon</dt>
              <dd>{status.health.appVersion}</dd>
              <dt>Protocol</dt>
              <dd>{status.health.protocolId.slice(0, 12)}</dd>
              {status.health.runtimes.map((r) => (
                <Fragment key={r.kind}>
                  <dt>{r.kind}</dt>
                  <dd>
                    {r.state}
                    {r.version ? ` (${r.version})` : ""}
                  </dd>
                </Fragment>
              ))}
            </dl>
          )}
          <ThemeSwitch />
        </header>
        {status.kind === "unpaired" && <Pairing onPaired={probe} />}
        {status.kind === "ok" && <Dashboard />}
      </main>
      {status.kind === "ok" && <KeyBar />}
    </div>
  );
}

/**
 * Sizes the app to the part of the window the user sees, as app.css reads it, so the soft keyboard
 * shortens the app rather than covering its bottom. Whether the keyboard is up, and up for a
 * terminal, are set with the size, in one change, so the layout changes once and every terminal
 * refits once, never to chrome that comes back before the height does.
 */
function useAppViewport(): void {
  useEffect(() => {
    const root = document.documentElement;
    const focus = {
      events: document,
      inTerminal: () =>
        document.activeElement?.matches(".terminal-host .xterm-helper-textarea") === true,
    };
    return followViewport(window, focus, (viewport) => {
      root.style.setProperty("--app-top", `${viewport.top}px`);
      root.style.setProperty("--app-height", `${viewport.height}px`);
      root.toggleAttribute("data-keyboard", viewport.keyboard);
      root.toggleAttribute("data-typing", viewport.typing);
    });
  }, []);
}

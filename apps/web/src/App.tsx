import { useCallback, useEffect, useState } from "react";
import { HealthResponse, isCompatible } from "@bazhen/protocol";
import { noticeUnpaired, onUnpaired } from "./api.ts";
import { Dashboard } from "./Dashboard.tsx";
import { Pairing } from "./Pairing.tsx";
import { ThemeSwitch } from "./ui/ThemeSwitch.tsx";

type Status =
  | { kind: "loading" }
  | { kind: "unpaired" }
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
        const health = HealthResponse.parse(await res.json());
        if (!isCompatible(health.protocolVersion)) {
          throw new Error(
            `daemon speaks protocol ${health.protocolVersion}; this client needs a newer build`,
          );
        }
        setStatus({ kind: "ok", health });
      })
      .catch((err: unknown) => setStatus({ kind: "error", message: String(err) }));
  }, []);

  // Any answer that says this browser must pair, from the probe or a later request, as after
  // `bazhen devices revoke`, swaps the dashboard for the pairing form.
  useEffect(() => onUnpaired(() => setStatus({ kind: "unpaired" })), []);
  useEffect(probe, [probe]);

  return (
    <main>
      <header className="app-head">
        <h1>Bazhen</h1>
        {status.kind === "loading" && <p>Connecting to the daemon…</p>}
        {status.kind === "error" && <p role="alert">Daemon unavailable: {status.message}</p>}
        {status.kind === "ok" && (
          <dl>
            <dt>Daemon</dt>
            <dd>{status.health.appVersion}</dd>
            <dt>Protocol</dt>
            <dd>{status.health.protocolVersion}</dd>
            <dt>tmux</dt>
            <dd>
              {status.health.runtime.state}
              {status.health.runtime.version ? ` (${status.health.runtime.version})` : ""}
            </dd>
          </dl>
        )}
        <ThemeSwitch />
      </header>
      {status.kind === "unpaired" && <Pairing onPaired={probe} />}
      {status.kind === "ok" && <Dashboard />}
    </main>
  );
}

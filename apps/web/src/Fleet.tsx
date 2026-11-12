import { useEffect, useState, type FormEvent } from "react";
import type { Agent } from "@bazhen/protocol";
import { fetchState, launchAgent } from "./api.ts";
import { Terminal } from "./Terminal.tsx";

/**
 * Every agent, a way to launch one, and the selected agent's terminal. A plain stand-in for the
 * dashboard; the state is re-read every few seconds until the event stream exists.
 */
export function Fleet() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () =>
      fetchState().then(
        (s) => setAgents(s.agents),
        (e: unknown) => setError(String(e)),
      );
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, []);

  const launch = (e: FormEvent) => {
    e.preventDefault();
    launchAgent("claude-code", cwd).then(
      (r) => setSelected(r.terminalId),
      (err: unknown) => setError(String(err)),
    );
  };

  return (
    <>
      <form onSubmit={launch}>
        <label>
          Directory{" "}
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/path/to/project"
          />
        </label>
        <button type="submit">Launch Claude Code</button>
      </form>
      {error !== null && <p role="alert">{error}</p>}
      <ul aria-label="agents">
        {agents.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => setSelected(a.terminalId)}
              disabled={a.terminalId === null}
            >
              {a.project} · {a.harness} · {a.state}
            </button>
          </li>
        ))}
      </ul>
      {selected !== null && <Terminal key={selected} terminalId={selected} />}
    </>
  );
}

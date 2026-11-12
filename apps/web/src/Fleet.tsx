import { useEffect, useState, type FormEvent } from "react";
import type { HarnessId, StateSnapshot } from "@bazhen/protocol";
import { answer, launchAgent, sendMessage, watchState } from "./api.ts";
import { Terminal } from "./Terminal.tsx";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Every agent, a way to launch one, what needs the human, and the selected agent's terminal and
 * mail. A plain stand-in for the dashboard and inbox, kept current by the event stream.
 */
export function Fleet() {
  const [state, setState] = useState<StateSnapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const failed = (e: unknown) => setError(messageOf(e));

  useEffect(
    () =>
      watchState(
        (s) => {
          setState(s);
          setError(null);
        },
        (e: unknown) => setError(messageOf(e)),
      ),
    [],
  );

  const agent = state?.agents.find((a) => a.id === selected);
  const open = state?.attention.filter((a) => a.state === "open") ?? [];

  const launch = (harness: HarnessId) =>
    void launchAgent(harness, cwd).then((r) => setSelected(r.agentId), failed);
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (agent === undefined) return;
    sendMessage(agent.id, message).then(() => setMessage(""), failed);
  };

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          launch("claude-code");
        }}
      >
        <label>
          Directory{" "}
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/path/to/project"
          />
        </label>
        <button type="submit">Launch Claude Code</button>{" "}
        <button type="button" onClick={() => launch("codex")}>
          Launch Codex
        </button>
      </form>
      {error !== null && <p role="alert">{error}</p>}
      <section aria-label="inbox">
        {open.map((item) => (
          <p key={item.id}>
            {item.summary}{" "}
            <button type="button" onClick={() => void answer(item.id, "allow").catch(failed)}>
              Allow
            </button>{" "}
            <button type="button" onClick={() => void answer(item.id, "deny").catch(failed)}>
              Deny
            </button>
          </p>
        ))}
      </section>
      <ul aria-label="agents">
        {state?.agents.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => setSelected(a.id)}
              disabled={a.terminalId === null}
            >
              {a.project} · {a.harness} · {a.state}
            </button>
          </li>
        ))}
      </ul>
      {agent?.terminalId != null && (
        <>
          <form onSubmit={send}>
            <label>
              Message <input value={message} onChange={(e) => setMessage(e.target.value)} />
            </label>
            <button type="submit">Send</button>
          </form>
          <Terminal key={agent.terminalId} terminalId={agent.terminalId} />
        </>
      )}
    </>
  );
}

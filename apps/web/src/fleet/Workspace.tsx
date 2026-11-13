import { useRef, useState, type SubmitEvent } from "react";
import type { Agent, AgentState } from "@bazhen/protocol";
import { closeAgent, respawnAgent, sendMessage } from "../api.ts";
import { TerminalView } from "../terminal/TerminalView.tsx";
import { AttachCommand } from "./AttachCommand.tsx";
import { agentActions, exitText, shortId } from "./model.ts";

/** Why an agent that can't be opened shows no terminal. */
const NO_TERMINAL: Partial<Record<AgentState, string>> = {
  starting: "Starting…",
  lost: "Its terminal is gone, as after a reboot. Remove it to take it off the fleet.",
  closing: "Closing. If it stays here, close it again to finish.",
  closed: "Closed.",
  failed: "It failed to start.",
};

/** One agent: what it is, what can be done to it, and its terminal while there is one. */
export function Workspace({ agent, failed }: { agent: Agent; failed: (e: unknown) => void }) {
  const { open, buttons } = agentActions(agent);
  const dialog = useRef<HTMLDialogElement>(null);
  // Where the agent was when a command went out. It stays busy until the snapshot shows it moved,
  // since a second click before then would name the generation the first one replaced.
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const removing = buttons.includes("remove");
  const closable = removing || buttons.includes("close");
  const position = `${agent.state}:${agent.generation}`;
  const busy = sentAt === position;

  const run = (command: (id: string, generation: number) => Promise<unknown>) => {
    if (agent.generation === null) return;
    setSentAt(position);
    command(agent.id, agent.generation).catch((e: unknown) => {
      setSentAt(null);
      failed(e);
    });
  };
  const send = (e: SubmitEvent) => {
    e.preventDefault();
    sendMessage(agent.id, message).then(() => setMessage(""), failed);
  };

  return (
    <article className="workspace" aria-label="agent">
      <header className="workspace-head">
        <h2>{agent.project}</h2>
        <span>{agent.harness}</span>
        <span className="id">{shortId(agent.id)}</span>
        <span className={`state state-${agent.state}`}>{agent.state}</span>
        {agent.exit !== null && <span>{exitText(agent.exit)}</span>}
        <span className="spacer" />
        {buttons.includes("respawn") && (
          <button type="button" disabled={busy} onClick={() => run(respawnAgent)}>
            Respawn
          </button>
        )}
        {closable && (
          <button type="button" disabled={busy} onClick={() => dialog.current?.showModal()}>
            {removing ? "Remove…" : "Close agent…"}
          </button>
        )}
      </header>
      <p className="cwd">{agent.cwd}</p>
      {open ? (
        <>
          <form onSubmit={send}>
            <label>
              Message <input value={message} onChange={(e) => setMessage(e.target.value)} />
            </label>
            <button type="submit">Send</button>
          </form>
          {agent.terminalId !== null && (
            <TerminalView
              key={`${agent.terminalId}:${agent.generation}`}
              terminalId={agent.terminalId}
              kind="agent"
            />
          )}
        </>
      ) : (
        <p>{NO_TERMINAL[agent.state] ?? "There is no terminal to show."}</p>
      )}
      {agent.attachCommand !== null && <AttachCommand command={agent.attachCommand} />}
      {/* Gone, or remounted, the moment close is no longer offered or changes name, so a confirm
          left open can't send it. */}
      {closable && (
        <dialog
          key={String(removing)}
          ref={dialog}
          aria-label={removing ? "Remove agent" : "Close agent"}
        >
          <p>
            {removing
              ? `Remove ${agent.project}? Its terminal is already gone; this takes it off the fleet.`
              : `Close ${agent.project}? Its ${agent.harness} process and terminal end, and mail still on its way is dropped.`}
          </p>
          <button type="button" onClick={() => dialog.current?.close()}>
            Cancel
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              dialog.current?.close();
              run(closeAgent);
            }}
          >
            {removing ? "Remove" : "Close agent"}
          </button>
        </dialog>
      )}
    </article>
  );
}

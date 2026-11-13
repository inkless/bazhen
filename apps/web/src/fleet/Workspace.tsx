import { useState, useSyncExternalStore, type SubmitEvent } from "react";
import type { Agent, AgentState, Shell } from "@bazhen/protocol";
import {
  closeAgent,
  forceCloseAgent,
  Refused,
  relaunchAgent,
  respawnAgent,
  sendMessage,
} from "../api.ts";
import { TerminalView } from "../terminal/TerminalView.tsx";
import { pageTheme } from "../ui/theme.ts";
import { Button } from "../ui/Button.tsx";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { AttachCommand } from "./AttachCommand.tsx";
import { Dock } from "../shells/Dock.tsx";
import { linkedShells, shellLabel } from "../shells/model.ts";
import { agentActions, exitText, shortId } from "./model.ts";

const NARROW = "(max-width: 600px)";

/** Whether `query` matches now, and again whenever that changes. */
function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (changed) => {
      const list = matchMedia(query);
      list.addEventListener("change", changed);
      return () => list.removeEventListener("change", changed);
    },
    () => matchMedia(query).matches,
  );
}

/** Why an agent that can't be opened shows no terminal. */
const NO_TERMINAL: Partial<Record<AgentState, string>> = {
  starting: "Starting…",
  lost:
    "Its terminal is gone, as after a reboot. Relaunch it in a new terminal, or remove it to " +
    "take it off the fleet.",
  closing: "Closing. If it stays here, close it again to finish.",
  closed: "Closed.",
  failed: "It failed to start.",
};

/** One agent: what it is, what can be done to it, and its terminal while there is one. */
export function Workspace({
  agent,
  shells,
  failed,
}: {
  agent: Agent;
  shells: readonly Shell[];
  failed: (e: unknown) => void;
}) {
  const mine = linkedShells(shells, agent.id).filter((s) => s.state !== "closing");
  // Shells the user ticked to keep running, standalone, when the agent closes.
  const [keep, setKeep] = useState<ReadonlySet<string>>(new Set());
  // Kept only while it still runs; one that was lost or closed since can't be kept.
  const kept = mine.filter((s) => keep.has(s.id) && s.state === "running");
  // What ran in each shell as the close dialog opened, which it shows: only those programs may
  // be ended. One started while it is open isn't shown, so the daemon refuses it, and says so.
  const [shownBusy, setShownBusy] = useState<ReadonlyMap<string, string>>(new Map());
  const confirmedBusy = [...shownBusy]
    .filter(([terminalId]) => !keep.has(terminalId))
    .map(([terminalId, program]) => ({ terminalId, program }));
  const opened = () => {
    setKeep(new Set());
    setShownBusy(
      new Map(mine.flatMap((s) => (s.foreground === null ? [] : [[s.id, s.foreground.command]]))),
    );
  };
  const sharing = mine.length > 0;
  // Too narrow for the TUI and a shell one above the other: the dock takes the TUI as a tab.
  const narrow = useMediaQuery(NARROW);
  const tui = (terminalId: string, height: string) => (
    <TerminalView
      key={`${terminalId}:${agent.generation}`}
      terminalId={terminalId}
      kind="agent"
      scheme={agent.theme}
      height={height}
    />
  );
  const { open, buttons } = agentActions(agent);
  // Where the agent was when a command went out. It stays busy until the snapshot shows it moved,
  // since a second click before then would name the generation the first one replaced.
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  // A close refused because the terminal's old server may still run it: only then is force offered.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const removing = buttons.includes("remove");
  const closable = removing || buttons.includes("close");
  const position = `${agent.state}:${agent.generation}`;
  const busy = sentAt === position;

  const run = (command: (id: string, generation: number) => Promise<unknown>) => {
    if (agent.generation === null || busy) return;
    setSentAt(position);
    command(agent.id, agent.generation).catch((e: unknown) => {
      setSentAt(null);
      if (e instanceof Refused && e.code === "server_unconfirmed") setUnconfirmed(true);
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
          <Button
            isDisabled={busy}
            onPress={() => run((id, gen) => respawnAgent(id, gen, pageTheme().scheme()))}
          >
            Respawn
          </Button>
        )}
        {buttons.includes("relaunch") && (
          <ConfirmDialog
            key={String(agent.resumable)}
            isDisabled={busy}
            trigger="Relaunch…"
            title="Relaunch agent"
            message={
              agent.resumable
                ? `Relaunch ${agent.project}? Its ${agent.harness} session starts again in a new terminal.`
                : `Relaunch ${agent.project} on a new ${agent.harness} session? Its last session ` +
                  "can't be resumed, so its conversation isn't carried over."
            }
            confirm={agent.resumable ? "Relaunch" : "Relaunch fresh"}
            onConfirm={() =>
              run((id, gen) => relaunchAgent(id, gen, pageTheme().scheme(), !agent.resumable))
            }
          />
        )}
        {/* Remounted the moment close changes name, and gone once it is no longer offered, so a
            confirm left open can't send it. */}
        {closable && (
          <ConfirmDialog
            key={String(removing)}
            isDisabled={busy}
            trigger={removing ? "Remove…" : "Close agent…"}
            title={removing ? "Remove agent" : "Close agent"}
            message={
              <CloseMessage
                agent={agent}
                removing={removing}
                shells={mine}
                busy={shownBusy}
                keep={keep}
                onKeep={setKeep}
              />
            }
            confirm={removing ? "Remove" : "Close agent"}
            onOpen={opened}
            onConfirm={() =>
              run((id, generation) =>
                closeAgent(id, generation, {
                  keepShells: kept.map((s) => s.id),
                  confirmedBusy,
                }),
              )
            }
          />
        )}
        {unconfirmed && closable && (
          <ConfirmDialog
            isDisabled={busy}
            trigger="Force close…"
            title="Force close agent"
            message={
              `Force close ${agent.project}? Bazhen can't show its old tmux server has ended; ` +
              "it is recorded closed, and that server may still be running it."
            }
            confirm="Force close"
            onConfirm={() => run(forceCloseAgent)}
          />
        )}
      </header>
      <p className="cwd">{agent.cwd}</p>
      {open ? (
        <>
          <form onSubmit={send}>
            <label>
              Message <input value={message} onChange={(e) => setMessage(e.target.value)} />
            </label>
            <Button type="submit">Send</Button>
          </form>
          {agent.terminalId !== null && (
            <div className="workspace-body">
              {narrow ? (
                <Dock
                  agent={agent}
                  shells={shells}
                  failed={failed}
                  agentView={tui(agent.terminalId, "70vh")}
                />
              ) : (
                <>
                  {tui(agent.terminalId, sharing ? "40vh" : "70vh")}
                  <Dock agent={agent} shells={shells} failed={failed} />
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <p>{NO_TERMINAL[agent.state] ?? "There is no terminal to show."}</p>
      )}
      {agent.attachCommand !== null && <AttachCommand command={agent.attachCommand} />}
    </article>
  );
}

/**
 * What closing the agent ends: its process and terminal, and its shells with it, each of which
 * can be kept running on its own instead. Shells running a program are named, so closing them is
 * a choice the user saw.
 */
function CloseMessage({
  agent,
  removing,
  shells,
  busy,
  keep,
  onKeep,
}: {
  agent: Agent;
  removing: boolean;
  shells: readonly Shell[];
  /** What ran in each shell as the dialog opened. */
  busy: ReadonlyMap<string, string>;
  keep: ReadonlySet<string>;
  onKeep: (keep: ReadonlySet<string>) => void;
}) {
  const toggle = (id: string, kept: boolean) => {
    const next = new Set(keep);
    if (kept) next.add(id);
    else next.delete(id);
    onKeep(next);
  };
  return (
    <>
      <p>
        {removing
          ? `Remove ${agent.project}? Its terminal is already gone; this takes it off the fleet.`
          : `Close ${agent.project}? Its ${agent.harness} process and terminal end, and mail still on its way is dropped.`}
      </p>
      {shells.length > 0 && (
        <fieldset className="close-shells">
          <legend>Its shells close too, unless kept</legend>
          {shells.map((shell) => (
            <label key={shell.id}>
              <input
                type="checkbox"
                checked={keep.has(shell.id)}
                disabled={shell.state !== "running"}
                onChange={(e) => toggle(shell.id, e.target.checked)}
              />{" "}
              Keep {shellLabel(shell)} running, standalone
              {busy.has(shell.id) && <strong> — {busy.get(shell.id)} is running</strong>}
            </label>
          ))}
        </fieldset>
      )}
    </>
  );
}

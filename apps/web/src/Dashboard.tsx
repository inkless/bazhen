import { useEffect, useState } from "react";
import type { HarnessId, StateSnapshot } from "@bazhen/protocol";
import { answer, launchAgent, watchState } from "./api.ts";
import { FleetList } from "./fleet/FleetList.tsx";
import { groupFleet } from "./fleet/model.ts";
import { Workspace } from "./fleet/Workspace.tsx";
import { Button } from "./ui/Button.tsx";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const AGENT_HASH = /^#\/agent\/(.+)$/;
const selectionOf = (hash: string) => AGENT_HASH.exec(hash)?.[1] ?? null;

/** The selected agent, kept in the URL so reload, back and a pasted link keep it. */
function useSelection(): string | null {
  const [selected, setSelected] = useState(() => selectionOf(location.hash));
  useEffect(() => {
    const changed = () => setSelected(selectionOf(location.hash));
    addEventListener("hashchange", changed);
    return () => removeEventListener("hashchange", changed);
  }, []);
  return selected;
}

function select(agentId: string | null): void {
  location.hash = agentId === null ? "" : `#/agent/${agentId}`;
}

/** The fleet in the rail and, in the centre, the selected agent's workspace or the whole fleet. */
export function Dashboard() {
  const [state, setState] = useState<StateSnapshot | null>(null);
  const selected = useSelection();
  const [showEnded, setShowEnded] = useState(false);
  const [cwd, setCwd] = useState("");
  // Kept apart: every state read clears a stream error, and a refusal must outlast them.
  const [streamError, setStreamError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const failed = (e: unknown) => setActionError(messageOf(e));

  useEffect(
    () =>
      watchState(
        (s) => {
          setState(s);
          setStreamError(null);
        },
        (e: unknown) => setStreamError(messageOf(e)),
      ),
    [],
  );

  const launch = (harness: HarnessId) => {
    setActionError(null);
    void launchAgent(harness, cwd).then((r) => select(r.agentId), failed);
  };
  const fleet = state === null ? null : groupFleet(state, showEnded);
  const agent = state?.agents.find((a) => a.id === selected);
  const open = state?.attention.filter((a) => a.state === "open") ?? [];
  const projectOf = (agentId: string) => state?.agents.find((a) => a.id === agentId)?.project;

  return (
    <>
      <form
        className="launch"
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
        <Button type="submit" variant="primary">
          Launch Claude Code
        </Button>
        <Button onPress={() => launch("codex")}>Launch Codex</Button>
      </form>
      {actionError !== null && (
        <p>
          <span role="alert">{actionError}</span>{" "}
          <Button variant="link" onPress={() => setActionError(null)}>
            Dismiss
          </Button>
        </p>
      )}
      {streamError !== null && <p role="status">{streamError}</p>}
      <div className="dashboard">
        <nav className="rail" aria-label="fleet">
          <Button variant="link" onPress={() => select(null)}>
            Fleet
          </Button>
          {open.length > 0 && (
            <section aria-label="inbox" className="inbox">
              <h2>Needs you</h2>
              {open.map((item) => (
                <p key={item.id}>
                  <Button variant="link" onPress={() => select(item.agentId)}>
                    {projectOf(item.agentId) ?? "An agent"}
                  </Button>{" "}
                  {item.summary}{" "}
                  <Button onPress={() => void answer(item.id, "allow").catch(failed)}>Allow</Button>{" "}
                  <Button onPress={() => void answer(item.id, "deny").catch(failed)}>Deny</Button>
                </p>
              ))}
            </section>
          )}
          {fleet !== null && (
            <FleetList fleet={fleet} label="agents" selected={selected} onSelect={select} compact />
          )}
          {fleet !== null && (showEnded || fleet.hidden > 0) && (
            <Button variant="link" onPress={() => setShowEnded(!showEnded)}>
              {showEnded ? "Hide ended agents" : `Show ended agents (${fleet.hidden})`}
            </Button>
          )}
        </nav>
        <section className="centre">
          {agent !== undefined ? (
            <Workspace key={agent.id} agent={agent} failed={failed} />
          ) : (
            fleet !== null && (
              <FleetList
                fleet={fleet}
                label="fleet overview"
                selected={null}
                onSelect={select}
                compact={false}
              />
            )
          )}
        </section>
      </div>
    </>
  );
}

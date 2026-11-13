import { useEffect, useState, useSyncExternalStore } from "react";
import type { HarnessId, StateSnapshot } from "@bazhen/protocol";
import { launchAgent, watchState } from "./api.ts";
import { AgentAttention, Inbox } from "./inbox/Inbox.tsx";
import { pageNotifier } from "./inbox/notify.ts";
import { FleetList } from "./fleet/FleetList.tsx";
import { groupFleet } from "./fleet/model.ts";
import { ThemeNotice } from "./fleet/ThemeNotice.tsx";
import { Workspace } from "./fleet/Workspace.tsx";
import { AgentTasks, TaskPage, TasksView } from "./tasks/Tasks.tsx";
import { pageTheme } from "./ui/theme.ts";
import { Button } from "./ui/Button.tsx";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const AGENT_HASH = /^#\/agent\/(.+)$/;
const INBOX_HASH = "#/inbox";
const TASKS_HASH = "#/tasks";
const TASK_HASH = /^#\/task\/(.+)$/;
const selectionOf = (hash: string) => AGENT_HASH.exec(hash)?.[1] ?? null;

const viewOf = () => ({
  selected: selectionOf(location.hash),
  inbox: location.hash === INBOX_HASH,
  tasks: location.hash === TASKS_HASH,
  task: TASK_HASH.exec(location.hash)?.[1] ?? null,
});

/**
 * The selected agent, the inbox, the tasks or one task, kept in the URL so reload, back and a
 * pasted link keep it.
 */
function useSelection(): ReturnType<typeof viewOf> {
  const [view, setView] = useState(viewOf);
  useEffect(() => {
    const changed = () => setView(viewOf());
    addEventListener("hashchange", changed);
    return () => removeEventListener("hashchange", changed);
  }, []);
  return view;
}

function openTask(taskId: string): void {
  location.hash = `#/task/${taskId}`;
}

function select(agentId: string | null): void {
  location.hash = agentId === null ? "" : `#/agent/${agentId}`;
}

/** The fleet in the rail and, in the centre, the selected agent's workspace or the whole fleet. */
export function Dashboard() {
  const [state, setState] = useState<StateSnapshot | null>(null);
  const { selected, inbox, tasks, task } = useSelection();
  const [showEnded, setShowEnded] = useState(false);
  const [cwd, setCwd] = useState("");
  // Kept apart: every state read clears a stream error, and a refusal must outlast them.
  const [streamError, setStreamError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const failed = (e: unknown) => setActionError(messageOf(e));
  const page = pageTheme();
  const scheme = useSyncExternalStore(page.subscribe, page.scheme);

  useEffect(() => {
    const notify = pageNotifier();
    return watchState(
      (s) => {
        setState(s);
        setStreamError(null);
        notify(s);
      },
      (e: unknown) => setStreamError(messageOf(e)),
    );
  }, []);

  const launch = (harness: HarnessId) => {
    setActionError(null);
    void launchAgent(harness, cwd, scheme).then((r) => select(r.agentId), failed);
  };
  const fleet = state === null ? null : groupFleet(state, showEnded);
  const agent = state?.agents.find((a) => a.id === selected);
  const open = state?.attention.filter((a) => a.state === "open").length ?? 0;
  const openTasks = state?.tasks.filter((t) => t.state === "open").length ?? 0;
  const opening = { onOpenTask: openTask, onOpenAgent: select, failed };

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
      {state !== null && <ThemeNotice agents={state.agents} scheme={scheme} failed={failed} />}
      <div className="dashboard">
        <nav className="rail" aria-label="fleet">
          <Button variant="link" onPress={() => select(null)}>
            Fleet
          </Button>
          <Button
            variant="link"
            {...(inbox && { "aria-current": "page" as const })}
            onPress={() => (location.hash = INBOX_HASH)}
          >
            {open > 0 ? `Inbox (${open})` : "Inbox"}
          </Button>
          <Button
            variant="link"
            {...((tasks || task !== null) && { "aria-current": "page" as const })}
            onPress={() => (location.hash = TASKS_HASH)}
          >
            {openTasks > 0 ? `Tasks (${openTasks})` : "Tasks"}
          </Button>
          <span className="visually-hidden" aria-live="polite">
            {open === 1 ? "1 item needs you" : `${open} items need you`}
          </span>
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
          {inbox && state !== null ? (
            <Inbox state={state} onOpen={select} failed={failed} />
          ) : tasks && state !== null ? (
            <TasksView state={state} {...opening} />
          ) : task !== null && state !== null ? (
            <TaskPage key={task} state={state} taskId={task} {...opening} />
          ) : agent !== undefined && state !== null ? (
            <>
              <AgentAttention state={state} agentId={agent.id} onOpen={select} failed={failed} />
              <AgentTasks state={state} agentId={agent.id} onOpenTask={openTask} />
              <Workspace key={agent.id} agent={agent} failed={failed} />
            </>
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

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AGENT_NAME_MAX,
  AgentName,
  type HarnessId,
  type StateSnapshot,
} from "@bazhen/protocol/web";
import { launchAgent, watchState } from "./api.ts";
import { AgentAttention, Inbox } from "./inbox/Inbox.tsx";
import { openNotices } from "./inbox/model.ts";
import { pageNotifier } from "./inbox/notify.ts";
import { FleetList } from "./fleet/FleetList.tsx";
import { defaultNamePreview, groupFleet } from "./fleet/model.ts";
import { ThemeNotice } from "./fleet/ThemeNotice.tsx";
import { Messages } from "./fleet/Messages.tsx";
import { Workspace } from "./fleet/Workspace.tsx";
import { AgentTasks, TaskPage, TasksView } from "./tasks/Tasks.tsx";
import { pageTheme } from "./ui/theme.ts";
import { Button } from "./ui/Button.tsx";
import { ShellPane } from "./shells/ShellPane.tsx";
import { ShellsRail } from "./shells/ShellsRail.tsx";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const AGENT_HASH = /^#\/agent\/(.+)$/;
const SHELL_HASH = /^#\/shell\/(.+)$/;
const INBOX_HASH = "#/inbox";
const TASKS_HASH = "#/tasks";
const TASK_HASH = /^#\/task\/(.+)$/;
const selectionOf = (hash: string) => AGENT_HASH.exec(hash)?.[1] ?? null;

const viewOf = () => ({
  selected: selectionOf(location.hash),
  shell: SHELL_HASH.exec(location.hash)?.[1] ?? null,
  inbox: location.hash === INBOX_HASH,
  tasks: location.hash === TASKS_HASH,
  task: TASK_HASH.exec(location.hash)?.[1] ?? null,
});

/**
 * The selected agent or shell, the inbox, the tasks or one task, kept in the URL so reload, back and a
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

const selectShell = (terminalId: string) => (location.hash = `#/shell/${terminalId}`);

/** The fleet in the rail and, in the centre, the selected agent's workspace or the whole fleet. */
export function Dashboard() {
  const [state, setState] = useState<StateSnapshot | null>(null);
  const { selected, shell: shellId, inbox, tasks, task } = useSelection();
  const [showEnded, setShowEnded] = useState(false);
  const [cwd, setCwd] = useState("");
  const [name, setName] = useState("");
  const [nameInvalid, setNameInvalid] = useState(false);
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
    const asked = name.trim();
    const parsed = asked === "" ? undefined : AgentName.safeParse(asked);
    if (parsed?.success === false) {
      setNameInvalid(true);
      setActionError(parsed.error.issues[0]?.message ?? "not a name");
      return;
    }
    void launchAgent(harness, cwd, scheme, parsed?.data).then((r) => {
      // The name is this agent's now; a second launch with it would be refused.
      setName("");
      select(r.agentId);
    }, failed);
  };
  const fleet = state === null ? null : groupFleet(state, showEnded);
  const agent = state?.agents.find((a) => a.id === selected);
  const shell = state?.shells.find((s) => s.id === shellId);
  const open =
    state === null
      ? 0
      : state.attention.filter((a) => a.state === "open").length + openNotices(state).length;
  const openTasks = state?.tasks.filter((t) => t.state === "open").length ?? 0;
  const opening = { onOpenTask: openTask, onOpenAgent: select, failed };
  // One thing shown rather than the fleet, which a phone gives the whole screen.
  const item = inbox || tasks || task !== null || shellId !== null || agent !== undefined;
  const centre = useRef<HTMLElement>(null);
  useFocusKept(centre, location.hash);

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
        <label className="launch-name">
          Name{" "}
          <input
            value={name}
            maxLength={AGENT_NAME_MAX}
            aria-invalid={nameInvalid}
            onChange={(e) => {
              setName(e.target.value);
              setNameInvalid(false);
            }}
            placeholder={defaultNamePreview(cwd)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <Button type="submit" variant="primary">
          Launch Claude Code
        </Button>
        <Button onPress={() => launch("codex")}>Launch Codex</Button>
      </form>
      <div className="notices">
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
      </div>
      <div className="dashboard" data-view={item ? "item" : "fleet"}>
        <nav className="rail" aria-label="fleet">
          <div className="rail-links">
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
          </div>
          <span className="visually-hidden" aria-live="polite">
            {open === 1 ? "1 item needs you" : `${open} items need you`}
          </span>
          <div className="rail-lists">
            {fleet !== null && (
              <FleetList
                fleet={fleet}
                label="agents"
                selected={selected}
                onSelect={select}
                compact
                shells={state?.shells ?? []}
              />
            )}
            {fleet !== null && (showEnded || fleet.hidden > 0) && (
              <Button variant="link" onPress={() => setShowEnded(!showEnded)}>
                {showEnded ? "Hide ended agents" : `Show ended agents (${fleet.hidden})`}
              </Button>
            )}
            {state !== null && (
              <ShellsRail
                shells={state.shells}
                selected={shellId}
                onSelect={selectShell}
                failed={failed}
              />
            )}
          </div>
        </nav>
        <section ref={centre} className="centre" tabIndex={-1}>
          {inbox && state !== null ? (
            <Inbox state={state} onOpen={select} failed={failed} />
          ) : tasks && state !== null ? (
            <TasksView state={state} {...opening} />
          ) : task !== null && state !== null ? (
            <TaskPage key={task} state={state} taskId={task} {...opening} />
          ) : agent !== undefined && state !== null ? (
            <Workspace
              key={agent.id}
              agent={agent}
              shells={state.shells}
              failed={failed}
              about={
                <>
                  <AgentAttention
                    state={state}
                    agentId={agent.id}
                    onOpen={select}
                    failed={failed}
                  />
                  <AgentTasks
                    state={state}
                    agentId={agent.id}
                    onOpenTask={openTask}
                    onOpenAgent={select}
                  />
                </>
              }
              messages={<Messages state={state} agentId={agent.id} />}
            />
          ) : shell !== undefined ? (
            <ShellPane key={shell.id} shell={shell} onRestarted={selectShell} failed={failed} />
          ) : shellId !== null && state !== null ? (
            <section aria-label="shell" className="gone">
              <p>This shell is no longer open.</p>
              <Button variant="link" onPress={() => select(null)}>
                Back to the fleet
              </Button>
            </section>
          ) : (
            fleet !== null && (
              <FleetList
                fleet={fleet}
                label="fleet overview"
                selected={null}
                onSelect={select}
                compact={false}
                shells={state?.shells ?? []}
              />
            )
          )}
        </section>
      </div>
    </>
  );
}

/**
 * Moves focus to `pane` when what is shown changes and leaves focus nowhere: on a page the user
 * left, or on a control no longer shown, as the fleet's list is once a phone opens one of its
 * agents. Focus left on the page body would put the next Tab back at the top.
 */
function useFocusKept(pane: { readonly current: HTMLElement | null }, shown: string): void {
  const before = useRef(shown);
  useEffect(() => {
    if (before.current === shown) return;
    before.current = shown;
    const active = document.activeElement;
    const lost = !(active instanceof HTMLElement) || active === document.body;
    if (lost || !active.checkVisibility()) pane.current?.focus({ preventScroll: true });
  }, [pane, shown]);
}

import { useState, type ReactNode } from "react";
import type { Agent, Shell } from "@bazhen/protocol";
import { closeShell, openShell } from "../api.ts";
import { pageTheme } from "../ui/theme.ts";
import { Button } from "../ui/Button.tsx";
import { Tabs } from "../ui/Tabs.tsx";
import { useAction } from "./action.ts";
import { isBusy, linkedShells, shellLabel } from "./model.ts";
import { ShellPane } from "./ShellPane.tsx";

/** The tab that holds the agent's own TUI where the screen is too narrow for both. */
const AGENT_TAB = "agent";

/**
 * An agent's linked shells, as tabs under its TUI: one shell's terminal at a time, so the dock
 * streams one terminal however many shells it holds. Given `agentView`, as on a narrow screen,
 * the agent's TUI is its first tab instead of sitting above it, so each gets the full height.
 */
export function Dock({
  agent,
  shells,
  agentView,
  failed,
}: {
  agent: Agent;
  shells: readonly Shell[];
  agentView?: ReactNode;
  failed: (e: unknown) => void;
}) {
  const { pending, act } = useAction(failed);
  const mine = linkedShells(shells, agent.id);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = mine.find((s) => s.id === picked);
  const shown = selected ?? (agentView === undefined ? mine[0] : undefined);
  const lost = mine.filter((s) => s.state === "lost" && s.commands.includes("close"));
  const tabs = [
    ...(agentView === undefined ? [] : [{ id: AGENT_TAB, label: agent.project }]),
    ...mine.map((shell) => ({ id: shell.id, label: <ShellTab shell={shell} /> })),
  ];
  const height = agentView === undefined ? "30vh" : "70vh";

  return (
    <section className="dock" aria-label="shells">
      <header className="dock-head">
        <h3>Shells</h3>
        {agent.canOpenShell && (
          <Button
            isDisabled={pending}
            onPress={() =>
              act(
                () => openShell({ linkedAgentId: agent.id }, pageTheme().scheme()),
                (r) => setPicked(r.terminalId),
              )
            }
          >
            + Shell here
          </Button>
        )}
        {lost.length > 1 && (
          <Button variant="quiet" isDisabled={pending} onPress={() => act(() => dismissAll(lost))}>
            Dismiss all lost
          </Button>
        )}
      </header>
      {tabs.length > 0 && (
        <Tabs
          label={`${agent.project} shells`}
          items={tabs}
          selected={shown?.id ?? AGENT_TAB}
          onSelect={setPicked}
        >
          {shown === undefined ? (
            agentView
          ) : (
            <ShellPane
              key={shown.id}
              shell={shown}
              height={height}
              onRestarted={setPicked}
              failed={failed}
            />
          )}
        </Tabs>
      )}
    </section>
  );
}

/** A shell's tab: a dot while something runs in it, its name, and whether it is lost. */
function ShellTab({ shell }: { shell: Shell }) {
  return (
    <>
      <span className={isBusy(shell) ? "busy-dot busy" : "busy-dot"} aria-hidden="true" />
      {isBusy(shell) && <span className="visually-hidden">running </span>}
      {shellLabel(shell)}
      {shell.state === "lost" && <span className="state state-lost">lost</span>}
    </>
  );
}

/** Dismisses each lost shell, one after another, so a refusal stops the rest. */
async function dismissAll(lost: readonly Shell[]): Promise<void> {
  for (const shell of lost) await closeShell(shell.id, shell.generation);
}

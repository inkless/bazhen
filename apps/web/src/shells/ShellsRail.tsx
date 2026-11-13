import { useEffect, useState } from "react";
import type { Shell } from "@bazhen/protocol";
import { openShell } from "../api.ts";
import { pageTheme } from "../ui/theme.ts";
import { Button } from "../ui/Button.tsx";
import { useAction } from "./action.ts";
import { age, isBusy, shellLabel, standaloneGroups } from "./model.ts";

/**
 * The rail's standalone shells, by directory: the home for work tied to no agent, such as a dev
 * server or a watcher, each with what runs in it and for how long. Its rows are native buttons,
 * as the fleet's are: a list that navigates, not a selection widget (docs/standards/ui.md).
 */
export function ShellsRail({
  shells,
  selected,
  onSelect,
  failed,
}: {
  shells: readonly Shell[];
  selected: string | null;
  onSelect: (terminalId: string) => void;
  failed: (e: unknown) => void;
}) {
  const [cwd, setCwd] = useState<string | null>(null);
  const { pending, act } = useAction(failed);
  const now = useClock(30_000);
  return (
    <section aria-label="standalone shells" className="shells-rail">
      <div className="shells-rail-head">
        <h2>Shells</h2>
        {cwd === null && (
          <Button variant="link" onPress={() => setCwd("")}>
            + New
          </Button>
        )}
      </div>
      {cwd !== null && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const where = cwd.trim() === "" ? "~" : cwd.trim();
            act(
              () => openShell({ cwd: where }, pageTheme().scheme()),
              (r) => {
                setCwd(null);
                onSelect(r.terminalId);
              },
            );
          }}
        >
          <label>
            Directory <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~" />
          </label>
          <Button type="submit" isDisabled={pending}>
            Open
          </Button>
          <Button variant="quiet" isDisabled={pending} onPress={() => setCwd(null)}>
            Cancel
          </Button>
        </form>
      )}
      {standaloneGroups(shells).map(({ dir, shells: group }) => (
        <div key={dir}>
          <h3 className="project">{dir}</h3>
          <ul>
            {group.map((shell) => (
              <li key={shell.id}>
                <button
                  type="button"
                  className="agent"
                  aria-current={shell.id === selected ? "true" : undefined}
                  onClick={() => onSelect(shell.id)}
                >
                  <span
                    className={isBusy(shell) ? "busy-dot busy" : "busy-dot"}
                    aria-hidden="true"
                  />
                  <span>{shell.name ?? shellLabel(shell)}</span>
                  {shell.foreground !== null && (
                    <span className="id">{age(shell.foreground.since, now)}</span>
                  )}
                  {shell.state !== "running" && (
                    <span className={`state state-${shell.state}`}>{shell.state}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** The time now, as of the last tick: ages in the rail move on every `everyMs`. */
function useClock(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

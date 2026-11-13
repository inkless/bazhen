import { useEffect, useRef, useState } from "react";
import type { Agent, TuiTheme } from "@bazhen/protocol";
import { respawnAgent, signalAgent } from "../api.ts";
import { inOtherTheme } from "../terminal/theme.ts";
import { Button } from "../ui/Button.tsx";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { shortId, themeRespawn } from "./model.ts";

/**
 * The open agents whose terminal is in the other theme than the page, each with a respawn in the
 * page's. A running one is stopped first and respawned once the snapshot shows it exited; if this
 * page goes away in between, it stays exited, with its own Respawn, and nothing is lost.
 */
/** How long a stopped agent has to exit before the respawn is given up, and the user told. */
const STOP_WAIT_MS = 15_000;

interface Stopping {
  readonly theme: TuiTheme;
  readonly generation: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function ThemeNotice({
  agents,
  scheme,
  failed,
}: {
  agents: readonly Agent[];
  scheme: TuiTheme;
  failed: (e: unknown) => void;
}) {
  // Agents stopped to be respawned, by id.
  const stopping = useRef(new Map<string, Stopping>());
  // The latest snapshot's agents, which a confirm checks again: the list may be older than it.
  const latest = useRef(agents);
  const [dismissed, setDismissed] = useState<TuiTheme | null>(null);

  useEffect(() => {
    latest.current = agents;
    for (const [id, { theme, generation, timer }] of stopping.current) {
      const agent = agents.find((a) => a.id === id);
      if (agent?.generation === generation && agent.state === "running") continue;
      clearTimeout(timer);
      stopping.current.delete(id);
      if (agent?.state === "exited") respawnAgent(id, generation, theme).catch(failed);
    }
  }, [agents, failed]);
  useEffect(() => {
    const pending = stopping.current;
    return () => {
      for (const { timer } of pending.values()) clearTimeout(timer);
    };
  }, []);

  const others = inOtherTheme(agents, scheme);
  if (others.length === 0 || dismissed === scheme) return null;
  const respawn = (listed: Agent) => {
    const a = latest.current.find((x) => x.id === listed.id) ?? listed;
    if (a.generation === null || stopping.current.has(a.id)) return;
    const blocked = themeRespawn(a);
    if (blocked !== null || a.generation !== listed.generation) {
      failed(new Error(`${a.project} wasn't respawned: ${blocked ?? "it changed meanwhile"}.`));
      return;
    }
    const generation = a.generation;
    if (a.state === "exited") {
      respawnAgent(a.id, generation, scheme).catch(failed);
      return;
    }
    const timer = setTimeout(() => {
      if (stopping.current.get(a.id)?.generation !== generation) return;
      stopping.current.delete(a.id);
      failed(new Error(`${a.project} didn't stop; close it or try again.`));
    }, STOP_WAIT_MS);
    stopping.current.set(a.id, { theme: scheme, generation, timer });
    signalAgent(a.id, generation, "SIGTERM").catch((e: unknown) => {
      clearTimeout(timer);
      stopping.current.delete(a.id);
      failed(e);
    });
  };

  return (
    <section role="status" aria-label="theme" className="notice">
      <p>
        These agents started in the other theme, and keep it until they are respawned:{" "}
        <Button variant="link" onPress={() => setDismissed(scheme)}>
          Dismiss
        </Button>
      </p>
      <ul>
        {others.map((a) => {
          const blocked = themeRespawn(a);
          return (
            <li key={a.id}>
              {a.project} <span className="id">{shortId(a.id)}</span> ({a.harness}, {a.theme}){" "}
              <ConfirmDialog
                trigger={blocked ?? `Respawn in ${scheme}`}
                title={`Respawn ${a.project} in ${scheme}?`}
                message={
                  (a.state === "running" ? "Its process is stopped, then started" : "It starts") +
                  ` again on its own session, drawn for a ${scheme} background.` +
                  " If this page goes away or the respawn is refused, it is left exited, with" +
                  " its Respawn button, and nothing is lost."
                }
                confirm={`Respawn in ${scheme}`}
                isDisabled={blocked !== null}
                onConfirm={() => respawn(a)}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

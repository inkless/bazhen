import { useState } from "react";
import { ShellName, type Shell } from "@bazhen/protocol";
import { closeShell, Refused, renameShell, restartShell, unlinkShell } from "../api.ts";
import { TerminalView } from "../terminal/TerminalView.tsx";
import { Button } from "../ui/Button.tsx";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { AttachCommand } from "../fleet/AttachCommand.tsx";
import { useAction } from "./action.ts";
import { shellLabel } from "./model.ts";

/** What a program in the shell was found to be, and what the snapshot said runs at the time. */
interface Refusal {
  readonly program: string;
  readonly seen: string | null;
}

/**
 * One shell: what can be done to it and, while it runs, its terminal. A close asks first while
 * a program runs in it, naming that program, and ends only that one: a program the user wasn't
 * shown, the daemon refuses, and the close asks again.
 */
export function ShellPane({
  shell,
  height,
  onRestarted,
  failed,
}: {
  shell: Shell;
  height: string;
  /** The new shell a restart opened, to show in place of the lost one. */
  onRestarted: (terminalId: string) => void;
  failed: (e: unknown) => void;
}) {
  const { pending, act } = useAction(failed);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const has = (command: Shell["commands"][number]) => shell.commands.includes(command);
  const seen = shell.foreground?.command ?? null;
  // A refusal stands until the snapshot shows something else running, or nothing.
  const running = refusal !== null && refusal.seen === seen ? refusal.program : seen;
  const close = (confirmed?: string) =>
    act(() =>
      closeShell(shell.id, shell.generation, confirmed).catch((e: unknown) => {
        const found = e instanceof Refused && e.code === "busy" ? e.busy[0] : undefined;
        if (found === undefined) throw e;
        setRefusal({ program: found.program, seen });
      }),
    );
  const rename = () => {
    const name = naming?.trim() ?? "";
    const parsed = ShellName.nullable().safeParse(name === "" ? null : name);
    if (!parsed.success) {
      setNameError("A name is at most 80 characters, with no control characters.");
      return;
    }
    act(
      () => renameShell(shell.id, parsed.data),
      () => setNaming(null),
    );
  };

  return (
    <article className="shell" aria-label={`shell ${shellLabel(shell)}`}>
      <header className="shell-head">
        <h3>{shellLabel(shell)}</h3>
        <span className="cwd">{shell.cwd}</span>
        <span className={`state state-${shell.state}`}>{shell.state}</span>
        <span className="spacer" />
        {has("rename") && naming === null && (
          <Button variant="quiet" onPress={() => setNaming(shell.name ?? "")}>
            Rename
          </Button>
        )}
        {has("unlink") && (
          <Button
            variant="quiet"
            isDisabled={pending}
            onPress={() => act(() => unlinkShell(shell.id, shell.generation))}
          >
            Make standalone
          </Button>
        )}
        {has("restart") && (
          <Button
            isDisabled={pending}
            onPress={() =>
              act(
                () => restartShell(shell.id, shell.generation),
                (r) => onRestarted(r.terminalId),
              )
            }
          >
            Restart
          </Button>
        )}
        {has("close") && shell.state === "lost" && (
          <Button isDisabled={pending} onPress={() => close()}>
            Dismiss
          </Button>
        )}
        {has("close") && shell.state !== "lost" && running === null && (
          <Button isDisabled={pending} onPress={() => close()}>
            Close
          </Button>
        )}
        {has("close") && shell.state !== "lost" && running !== null && (
          <ConfirmDialog
            key={running}
            isDisabled={pending}
            trigger="Close…"
            title="Close shell"
            message={`${running} is running in ${shellLabel(shell)}. Close it anyway? Everything in the shell ends.`}
            confirm="Close anyway"
            onConfirm={() => close(running)}
          />
        )}
      </header>
      {naming !== null && (
        <form
          className="shell-name"
          onSubmit={(e) => {
            e.preventDefault();
            rename();
          }}
        >
          <label>
            Name{" "}
            <input
              value={naming}
              maxLength={80}
              aria-invalid={nameError !== null}
              onChange={(e) => {
                setNaming(e.target.value);
                setNameError(null);
              }}
            />
          </label>
          <Button type="submit" isDisabled={pending}>
            Save
          </Button>
          <Button variant="quiet" onPress={() => setNaming(null)}>
            Cancel
          </Button>
          {nameError !== null && <span role="alert">{nameError}</span>}
        </form>
      )}
      {shell.state === "running" ? (
        <TerminalView
          key={`${shell.id}:${shell.generation}`}
          terminalId={shell.id}
          kind="shell"
          scheme={shell.theme}
          height={height}
        />
      ) : (
        <p>{NOT_RUNNING[shell.state] ?? "Starting…"}</p>
      )}
      {shell.attachCommand !== null && <AttachCommand command={shell.attachCommand} />}
    </article>
  );
}

/** Why a shell that isn't running shows no terminal. */
const NOT_RUNNING: Partial<Record<Shell["state"], string>> = {
  lost: "Its tmux server is gone, as after a reboot. Restart opens a new shell in the same directory.",
  closing: "Closing.",
};

import { useEffect, useId, useRef, useState, type SubmitEvent } from "react";
import { AGENT_NAME_MAX, AgentName, type Agent } from "@bazhen/protocol";
import { Refused, renameAgent } from "../api.ts";
import { Button } from "../ui/Button.tsx";
import { useAction } from "../shells/action.ts";

/**
 * Renames an agent, from its workspace. A name the daemon refuses as taken, or an agent that
 * ended meanwhile, is said beside the field, which stays open to try another.
 */
export function AgentRename({
  agent,
  onDone,
  failed,
}: {
  agent: Pick<Agent, "id" | "name" | "harness">;
  onDone: () => void;
  failed: (e: unknown) => void;
}) {
  const { pending, act } = useAction(failed);
  const [name, setName] = useState(agent.name);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const problemId = useId();
  useEffect(() => field.current?.focus(), []);
  const save = (e: SubmitEvent) => {
    e.preventDefault();
    const asked = name.trim();
    if (asked === agent.name) {
      onDone();
      return;
    }
    const parsed = AgentName.safeParse(asked);
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? "not a name");
      return;
    }
    act(
      () =>
        renameAgent(agent.id, parsed.data).then(
          () => true,
          (err: unknown) => {
            if (!(err instanceof Refused && err.code === "conflict")) throw err;
            setProblem(err.message);
            return false;
          },
        ),
      (renamed) => renamed && onDone(),
    );
  };
  return (
    <form className="agent-rename" aria-label="rename agent" onSubmit={save}>
      <label>
        Name{" "}
        <input
          ref={field}
          value={name}
          maxLength={AGENT_NAME_MAX}
          aria-invalid={problem !== null}
          aria-describedby={problem === null ? undefined : problemId}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => {
            setName(e.target.value);
            setProblem(null);
          }}
        />
      </label>
      <Button type="submit" isDisabled={pending}>
        Save
      </Button>
      <Button variant="quiet" onPress={onDone}>
        Cancel
      </Button>
      {problem !== null && (
        <span id={problemId} role="alert">
          {problem}
        </span>
      )}
      {agent.harness === "claude-code" && (
        <p className="note">Its Claude Code session keeps the old name until it next starts.</p>
      )}
    </form>
  );
}

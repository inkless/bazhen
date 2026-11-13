import type { Shell } from "@bazhen/protocol";
import { shellCount } from "../shells/model.ts";
import { exitText, shortId, type Fleet } from "./model.ts";

/**
 * The fleet by environment and project. Compact in the rail; in the centre it also shows where
 * each agent works and how an ended one ended.
 */
export function FleetList({
  fleet,
  label,
  selected,
  onSelect,
  compact,
  shells = [],
}: {
  fleet: Fleet;
  /** Every shell, so a row can count its agent's. */
  shells?: readonly Shell[];
  label: string;
  selected: string | null;
  onSelect: (agentId: string) => void;
  compact: boolean;
}) {
  return (
    <ul aria-label={label} className={compact ? "fleet compact" : "fleet"}>
      {fleet.groups.map(({ environment, projects }) => (
        <li key={environment.id}>
          <h2 className="environment">
            {environment.host === "" ? environment.kind : environment.host}
            <span className="kind">{environment.kind}</span>
          </h2>
          {projects.length === 0 && <p className="empty">No agents.</p>}
          <ul>
            {projects.map((project) => (
              <li key={project.name}>
                <h3 className="project">{project.name}</h3>
                <ul>
                  {project.rows.map(({ agent, needsYou }) => (
                    <li key={agent.id}>
                      <button
                        type="button"
                        className="agent"
                        aria-current={agent.id === selected ? "true" : undefined}
                        onClick={() => onSelect(agent.id)}
                      >
                        {needsYou && (
                          <>
                            <span className="needs-you" aria-hidden="true" />
                            <span className="visually-hidden">needs you</span>
                          </>
                        )}
                        <span>{agent.harness}</span>
                        <span className="id">{shortId(agent.id)}</span>
                        <span className={`state state-${agent.state}`}>{agent.state}</span>
                        <ShellChip count={shellCount(shells, agent.id)} />
                        {!compact && <span className="cwd">{agent.cwd}</span>}
                        {!compact && agent.exit !== null && <span>{exitText(agent.exit)}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** ▤ and how many shells an agent has, and how many run something; nothing without any. */
function ShellChip({ count }: { count: { total: number; busy: number } }) {
  if (count.total === 0) return null;
  const said = `${count.total} ${count.total === 1 ? "shell" : "shells"}`;
  return (
    <span className="shell-chip" title={said}>
      <span aria-hidden="true">
        ▤ {count.busy > 0 ? `${count.busy}/${count.total}` : count.total}
      </span>
      <span className="visually-hidden">
        {count.busy > 0 ? `${said}, ${count.busy} running` : said}
      </span>
    </span>
  );
}

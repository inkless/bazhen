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
}: {
  fleet: Fleet;
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

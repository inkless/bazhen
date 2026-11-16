import type { Role, RoleDefinition, RoleProblem } from "@bazhen/protocol";

/** What holding a role on a task lets an agent do, and how much of it one agent may hold. */
export interface RoleRules {
  readonly grants: readonly Role[];
  readonly singlePerTask: boolean;
  /** Null for no limit. */
  readonly maxActiveTasks: number | null;
}

/**
 * An assignment can outlive its role's file. A role no definition has any longer gives no
 * authority and no limit, so its holders keep their work and hand nothing on.
 */
const UNDEFINED_RULES: RoleRules = { grants: [], singlePerTask: false, maxActiveTasks: null };

/** The roles defined now, by key, in the order they were defined. */
export class RoleBook {
  readonly roles: readonly RoleDefinition[];
  private readonly byKey: ReadonlyMap<Role, RoleDefinition>;

  constructor(roles: readonly RoleDefinition[]) {
    this.roles = roles;
    this.byKey = new Map(roles.map((r) => [r.key, r]));
  }

  get(key: Role): RoleDefinition | undefined {
    return this.byKey.get(key);
  }

  rules(key: Role): RoleRules {
    return this.byKey.get(key) ?? UNDEFINED_RULES;
  }
}

/** A user's role file, read and parsed. */
export interface UserRole {
  readonly file: string;
  readonly role: RoleDefinition;
}

/**
 * The roles in force: the built-ins, each replaced whole by a user file of its key, and the user
 * files of new keys. A user role is skipped when it grants itself, since no agent promotes
 * another to its own standing, or grants a key nothing defines. Skipping one can leave another
 * granting it, so the check repeats until nothing changes. A skipped file's built-in, if any,
 * stands.
 */
export function resolveRoles(
  builtins: readonly RoleDefinition[],
  user: readonly UserRole[],
): { readonly book: RoleBook; readonly problems: readonly RoleProblem[] } {
  const problems: RoleProblem[] = [];
  let kept = [...user];
  for (;;) {
    const keys = new Set([...builtins.map((b) => b.key), ...kept.map((u) => u.role.key)]);
    const refused = kept.flatMap((u) => {
      const problem = grantProblem(u.role, keys);
      return problem === null ? [] : [{ file: u.file, problem }];
    });
    if (refused.length === 0) break;
    problems.push(...refused);
    const files = new Set(refused.map((r) => r.file));
    kept = kept.filter((u) => !files.has(u.file));
  }
  const replaced = new Map(kept.map((u) => [u.role.key, u.role]));
  const roles = [
    ...builtins.map((b) => replaced.get(b.key) ?? b),
    ...kept.map((u) => u.role).filter((r) => !builtins.some((b) => b.key === r.key)),
  ];
  return { book: new RoleBook(roles), problems };
}

function grantProblem(role: RoleDefinition, keys: ReadonlySet<Role>): string | null {
  if (role.grants.includes(role.key)) return `a ${role.key} can't grant its own role`;
  const unknown = role.grants.filter((g) => !keys.has(g));
  return unknown.length === 0 ? null : `grants ${unknown.join(", ")}, which no role defines`;
}

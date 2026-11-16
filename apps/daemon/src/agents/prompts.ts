import { createHash, randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoleBook } from "@bazhen/core";
import type { Role } from "@bazhen/protocol";
import { ensurePrivateDir } from "../config/private-dir.ts";
import { UnknownRole } from "../roles/roles.ts";

/** The system prompt one start of an agent gives it, and its hash, which the start records. */
export interface Composed {
  readonly text: string;
  readonly hash: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The system prompt each agent starts with: what every agent is told about the fleet, then its
 * launch role's prompt as the role's file says it now (foundation-design §11.4). Claude Code
 * reads it from a file in `dir`, which only this user can reach, so a user's prompt is never in
 * a process's arguments. Nothing here logs a prompt's text.
 */
export class Prompts {
  private readonly dir: string;
  private readonly fleet: string;
  private readonly roles: () => RoleBook;
  private readonly ensureDir: (dir: string) => void;

  /** `ensureDir` makes `dir` private to this user, refusing one it can't. */
  constructor(dir: string, fleet: string, roles: () => RoleBook, ensureDir: (dir: string) => void) {
    this.dir = dir;
    this.fleet = fleet;
    this.roles = roles;
    this.ensureDir = ensureDir;
  }

  /** The role definitions in force now. */
  book(): RoleBook {
    return this.roles();
  }

  /** Refuses a launch in a role no definition has, before anything is recorded. */
  check(role: Role | undefined): void {
    if (role !== undefined && this.roles().get(role) === undefined) throw new UnknownRole(role);
  }

  /**
   * The prompt an agent launched in `role` starts with now. A role whose file has since gone
   * gives the fleet's instructions alone.
   */
  compose(role: Role | null): Composed {
    const definition = role === null ? undefined : this.roles().get(role);
    const text =
      definition === undefined
        ? this.fleet
        : `${this.fleet}\n\n## Your role: ${definition.title}\n\n${definition.prompt}`;
    return { text, hash: sha256(text) };
  }

  /** Writes the agent's prompt for its harness to read, mode 0600, and returns where. */
  write(agentId: string, text: string): string {
    this.ensureDir(this.dir);
    const path = this.path(agentId);
    // Renamed into place, so a harness starting meanwhile never reads half a prompt.
    const partial = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(partial, text, { mode: 0o600, flag: "wx" });
    try {
      renameSync(partial, path);
    } catch (error) {
      rmSync(partial, { force: true });
      throw error;
    }
    return path;
  }

  remove(agentId: string): void {
    rmSync(this.path(agentId), { force: true });
  }

  private path(agentId: string): string {
    return join(this.dir, `${agentId}.md`);
  }
}

/** The daemon's prompts: in `<run>/prompts`, made private to `uid` before each write. */
export const daemonPrompts = (run: string, uid: number, fleet: string, roles: () => RoleBook) =>
  new Prompts(join(run, "prompts"), fleet, roles, (dir) => ensurePrivateDir(dir, uid));

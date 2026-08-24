/**
 * Custom skills — the slash commands The Hive gives the sessions it starts
 * (HIVE-96).
 *
 * ## Why no verb in this contract takes a path
 *
 * `fs-contract.ts` states the rule this file tightens. There, a request names a
 * `projectId` and a project-relative path, and main resolves the two against a
 * directory it validated itself. Here there is no path at all: a request names
 * a **skill**, and main already knows the one directory skills live in.
 *
 * A name is {@link SKILL_NAME_PATTERN}, which cannot express a separator, a dot
 * segment, or a drive letter. So traversal is not filtered out of these
 * requests — it is unrepresentable in them, which is a stronger claim and a
 * much shorter one to audit.
 *
 * The consequence worth stating for the next person: `remove` cannot be widened
 * into "delete this directory" by a change in the renderer. Widening it would
 * mean adding a field here first, and this file is where a reviewer looks.
 */

/**
 * What a skill may be called.
 *
 * The folder name is three things at once — the directory under
 * `~/.hive/skills`, the `name:` in the file's own frontmatter, and the slash
 * command the user types. So it is bounded by what Claude Code accepts and by
 * what is safe to `join` onto a root main owns: no separators, no dot segments,
 * and no case to normalise on a case-insensitive disk.
 *
 * It lives in `shared/` rather than beside the reader because the IPC guard and
 * the main-process reader have to agree *by construction*. Two copies of a
 * regular expression in two processes is a rule that holds until someone edits
 * one of them.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * The app owns `/done`; a user skill may not shadow it.
 *
 * Reserved here rather than only in the reader for the same reason the pattern
 * is: the renderer refuses the name in its editor, the guard refuses it at the
 * boundary, and main refuses it on disk. One constant, three refusals, and no
 * way for them to drift apart. What `/done` actually does is HIVE-93.
 */
export const RESERVED_SKILL_NAME = 'done';

/** A skill the app will inject, as the pane lists it. */
export interface SkillSummary {
  name: string;
  /** From the frontmatter. Empty when the file declares none, which is legal. */
  description: string;
  valid: true;
}

/**
 * A skill that will **not** be injected, and the sentence explaining why.
 *
 * Carried beside the good ones rather than through `ConfigSnapshot.errors`.
 * Skills are not config, and a problem belongs to the skill it describes — the
 * pane renders it on that row, next to the name that caused it, which an array
 * of loose strings somewhere else cannot do.
 *
 * The `valid` discriminant is what lets one list render both kinds without the
 * renderer inferring anything from which array a row arrived in.
 */
export interface SkillProblem {
  name: string;
  reason: string;
  valid: false;
}

export interface SkillsSnapshot {
  skills: SkillSummary[];
  invalid: SkillProblem[];
  /** Shown in the pane's footer, so the user can find the files themselves. */
  skillsRoot: string;
}

/** One file, for the editor. */
export interface SkillFile {
  name: string;
  body: string;
  path: string;
}

export interface SkillNameRequest {
  name: string;
}

export interface SkillWriteRequest {
  name: string;
  /**
   * The whole file.
   *
   * Neither length-capped nor swept for control characters, for the reason
   * `parseWriteFileRequest` gives about source files: a SKILL.md legitimately
   * contains tabs and newlines, and what makes this safe is *where* the bytes
   * land — a directory main chose, under a name main validated — not what the
   * bytes are.
   */
  body: string;
}

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

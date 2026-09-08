import { HIDDEN_ENTRIES } from './fs-contract';

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

/**
 * Move a skill's folder, because its frontmatter name changed (HIVE-99).
 *
 * ## Why this is a verb rather than a delete plus a write
 *
 * The folder name is mirrored from the frontmatter, so editing `name:` is a
 * *rename* — but the pane could only express it as "write the new one", which
 * left the old folder on disk, still internally consistent, still valid, and
 * still injected. One action, two commands.
 *
 * The renderer cannot fix that on its own without a window in which both
 * folders exist (write-then-delete) or neither does (delete-then-write). A
 * crash, a refused write, or a spawn landing in between turns a rename into a
 * duplicate or into a loss. `rename(2)` has no such window, and this request is
 * what lets main perform it.
 *
 * ## Why two names and still no path
 *
 * Both fields go through the same `assertSkillName` as every other verb here,
 * so the rule the docblock at the top of this file states is unchanged: a
 * request names **skills**, not places. Two names is still zero paths.
 *
 * `to` is refused when it already exists rather than replaced. `rename(2)`
 * would silently replace an empty target directory and fail `ENOTEMPTY` on a
 * full one — two outcomes for one mistake, neither of them a refusal — and the
 * pane's own collision check must not be the only thing standing between a
 * typo and someone else's skill.
 */
export interface SkillRenameRequest {
  from: string;
  to: string;
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

/**
 * What a skill folder may carry into a session.
 *
 * The numbers are here rather than in the walk because the pane phrases its
 * own copy from them — "over 5 MB" on a dimmed row has to be the same 5 MB
 * main enforced, and two constants two processes apart is a rule that holds
 * until someone edits one of them. `fs-contract.ts` holds `MAX_SEARCH_DEPTH`
 * for the same reason.
 */
export const MAX_BUNDLE_FILES = 200;
export const MAX_BUNDLE_FILE_BYTES = 5_000_000;
export const MAX_BUNDLE_DEPTH = 4;

/**
 * Names the walk lists once and never descends into.
 *
 * `HIDDEN_ENTRIES` plus `.DS_Store`, rather than a list of this module's own.
 * The explorer already had to decide what is noise in a directory a person
 * keeps source in, and a skill folder is a directory a person keeps source in.
 *
 * The cost is knowingly accepted: a bundle that genuinely ships an `out/` or a
 * `target/` has it skipped. That is why a skipped entry is *listed* rather
 * than hidden — the user can see the decision and rename around it.
 */
export const SKILL_SKIP_ENTRIES: readonly string[] = [
  ...HIDDEN_ENTRIES,
  '.DS_Store',
];

/**
 * One thing inside a skill folder, as both the mirror and the pane see it.
 *
 * Directories are entries in their own right rather than implied by their
 * children. Without that, a folder created through `skills:file:mkdir` and not
 * yet filled would vanish on the next read — which is exactly the "fictional
 * until a file lands in it" problem that verb exists to prevent.
 */
/** Why an entry will not be copied. The pane's chip renders from this. */
export type BundleExclusion = 'skipped' | 'too-large' | 'symlink';

export interface BundleEntry {
  /** POSIX-separated, relative to the skill folder. `scripts/build.py`. */
  path: string;
  kind: 'file' | 'directory';
  /** Bytes. `0` for a directory. Reported even when excluded: it is the reason. */
  size: number;
  /** The source's owner-execute bit. Always `false` for a directory. */
  executable: boolean;
  /**
   * Null when this is copied into the session; a code and a sentence when not.
   *
   * **Both**, and that is the point. `InvalidSkill.reason` is a bare sentence
   * because the pane only ever prints it. This one is printed *and* branched
   * on: the row shows a two-word chip and the panel shows the sentence. A pane
   * deriving the chip by matching the sentence's first word would break
   * silently the first time main reworded a reason, so the code is carried
   * rather than recovered.
   */
  excluded: { code: BundleExclusion; reason: string } | null;
}

export interface BundleManifest {
  entries: BundleEntry[];
  /**
   * Set once when the walk stopped at a bound, leaving the rest unlisted.
   *
   * Distinct from a per-entry `excluded`, and the distinction is the honest
   * part: enumerating everything past a 200-file limit in order to report that
   * it is past the limit is not a limit. `fs/search.ts` reports `capped` for
   * the same reason.
   *
   * Two bounds set it: the file count, and a folder at the depth limit that
   * still has something in it. The second is here rather than on that folder's
   * own row because `excluded` means "listed, and not copied" — and a folder at
   * depth 4 *is* copied. What is not copied is what is inside it, which by
   * definition has no row to carry a reason.
   */
  capped: string | null;
}

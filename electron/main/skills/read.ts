import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  RESERVED_SKILL_NAME,
  SKILL_NAME_PATTERN,
} from '@shared/skills-contract';

/**
 * Reading the user's own skills (HIVE-96).
 *
 * Pure over a root handed in, with no `app` import, so its tests run under
 * plain Node and never need an Electron runtime — the same arrangement
 * `hooks/settings.ts` uses for the settings it generates.
 */

export interface UserSkill {
  name: string;
  /**
   * From the frontmatter, for the pane's list. Empty when none is declared.
   *
   * Read here rather than in the renderer so the pane never needs a YAML
   * parser: the one process that already opens the file is the one that reports
   * what is in it, and the renderer gets a string it can print.
   */
  description: string;
  /**
   * The file, verbatim.
   *
   * Main never rewrites what the user typed — not to normalise the frontmatter,
   * not to add a trailing newline. The bytes that reach Claude Code are the
   * bytes in `~/.hive/skills`, which is what makes "edit it in a text editor"
   * and "edit it in Settings" the same feature.
   */
  body: string;
  path: string;
}

export interface InvalidSkill {
  name: string;
  path: string;
  /** A sentence the person editing the file can act on, not an error code. */
  reason: string;
}

export interface SkillsRead {
  skills: UserSkill[];
  invalid: InvalidSkill[];
}

/**
 * Pull the `---` fenced header out of a skill file as flat key/value pairs.
 *
 * A six-line reader rather than a YAML dependency, and deliberately so. The
 * only key that decides whether the file *loads* is `name`; `description` is
 * read because the pane shows it. Everything else in that header is Claude
 * Code's business, and a parser that understood the rest would be this app
 * holding a second opinion about a format it does not own — which is how a
 * skill the binary would happily run gets refused here.
 *
 * `null` means there is no closed header at all. That is worth distinguishing
 * from an empty one: a file that opens with `---` and never closes it is the
 * half-typed state, and Claude Code reads the whole thing as prose, so the
 * skill is silently lost rather than loudly broken.
 */
function frontmatter(body: string): Record<string, string> | null {
  if (!body.startsWith('---')) return null;
  const end = body.indexOf('\n---', 3);
  if (end === -1) return null;

  const keys: Record<string, string> = {};
  for (const line of body.slice(3, end).split('\n')) {
    const match = /^([a-z-]+):\s*(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) keys[match[1]] = (match[2] ?? '').trim();
  }
  return keys;
}

/**
 * Read every skill under `root`, sorted, keeping the rejects rather than
 * dropping them.
 *
 * ## Two properties worth knowing before changing this
 *
 * **A bad skill never costs a good one.** Every failure is per-entry and
 * continues the loop. The alternative — one malformed file failing the read —
 * would mean a typo in one skill silently removing every other skill from every
 * session, which is a spectacularly confusing way to lose a feature.
 *
 * **The rejects are returned, not logged.** They are what the Settings pane
 * renders on the offending row, so they travel with the data rather than into a
 * console nobody has open. That is the whole reason this returns a pair.
 *
 * A missing root is not a failure: it is a user who has not written a skill
 * yet, and the directory is created on the first save.
 */
export async function readUserSkills(root: string): Promise<SkillsRead> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { skills: [], invalid: [] };
  }

  const skills: UserSkill[] = [];
  const invalid: InvalidSkill[] = [];

  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    // A loose `README.md` beside the folders is a thing a person writes. It is
    // not a skill, and it is not a problem either.
    if (!entry.isDirectory()) continue;

    const name = entry.name;
    const path = join(root, name, 'SKILL.md');
    const reject = (reason: string): void => {
      invalid.push({ name, path, reason });
    };

    if (name === RESERVED_SKILL_NAME) {
      reject('"done" is reserved by The Hive — rename the folder.');
      continue;
    }
    if (!SKILL_NAME_PATTERN.test(name)) {
      reject('Folder name must be lowercase letters, digits and dashes.');
      continue;
    }

    let body: string;
    try {
      body = await readFile(path, 'utf8');
    } catch {
      reject('No SKILL.md in this folder.');
      continue;
    }

    const keys = frontmatter(body);
    if (keys === null) {
      reject('No frontmatter — the file must open and close with a --- fence.');
      continue;
    }

    const declared = keys.name;
    if (declared === undefined || declared === '') {
      reject('The frontmatter declares no name.');
      continue;
    }
    if (declared !== name) {
      reject(
        `Frontmatter name "${declared}" does not match the folder "${name}".`,
      );
      continue;
    }

    skills.push({ name, description: keys.description ?? '', body, path });
  }

  return { skills, invalid };
}

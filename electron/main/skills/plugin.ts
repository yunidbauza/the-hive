import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RESERVED_SKILL_NAME } from '@shared/skills-contract';

import { doneSkill } from './done-skill';
import type { SkillsRead } from './read';

/**
 * Generating the plugin directory `--plugin-dir` points at (HIVE-96).
 *
 * The directory is the app's, not the user's: regenerated from
 * `~/.hive/skills` at launch and again before every spawn, and safe to delete.
 * Nothing reads it but `claude`, and nothing writes it but this module.
 */

/**
 * The manifest that makes a directory a plugin.
 *
 * `skills: ['./skills/']` is declared rather than left to auto-discovery.
 * Auto-discovery may well work, but every real installed plugin on this machine
 * declares the field — matching what the binary is demonstrably given beats
 * relying on a default that is not ours to guarantee and would fail silently.
 */
const manifest = (version: string): string =>
  `${JSON.stringify(
    {
      name: 'hive',
      version,
      description: 'Skills The Hive injects into the sessions it starts.',
      skills: ['./skills/'],
    },
    null,
    2,
  )}\n`;

/**
 * Regenerate the plugin directory from `read`.
 *
 * Modelled on `writeHookSettings` (`hooks/settings.ts`): generated up front so
 * that the spawn path *picks a path* rather than negotiating with a live
 * directory.
 *
 * ## Why stale removal is a diff rather than a wipe
 *
 * Deleting `skills/` and rewriting it would be shorter, and wrong. This runs
 * before **every** spawn, so regenerations and spawns interleave — and a wipe
 * leaves a window in which a session that is starting right now reads an empty
 * plugin. The diff only touches entries that should not be there, so a session
 * starting concurrently sees either the old set or the new one, never nothing.
 *
 * The corollary is that this is idempotent, which the tests assert directly:
 * running it twice with the same input must leave the same directory.
 */
export async function writePluginDir(
  pluginRoot: string,
  version: string,
  read: SkillsRead,
  /**
   * Where `/done` reports to, or `null` when nothing is listening (HIVE-93).
   *
   * Passed per call rather than captured once, because this runs before every
   * spawn and the receiver's port is only known after it binds. A directory
   * written during a launch whose receiver never came up holds the inert
   * built-in, and the next regeneration replaces it with the live one — which
   * is why the write below is unconditional rather than skipped when the file
   * already exists.
   */
  doneUrl: string | null = null,
): Promise<void> {
  const skillsDir = join(pluginRoot, 'skills');

  await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true });
  await mkdir(skillsDir, { recursive: true });

  await writeFile(
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    manifest(version),
    'utf8',
  );

  const write = async (name: string, body: string): Promise<void> => {
    await mkdir(join(skillsDir, name), { recursive: true });
    await writeFile(join(skillsDir, name, 'SKILL.md'), body, 'utf8');
  };

  /*
    Unconditionally, and over whatever is already there. The app owns `/done`,
    and a copy edited inside userData surviving a launch would make the built-in
    mean something different on one machine than on every other.
  */
  await write(RESERVED_SKILL_NAME, doneSkill(doneUrl));

  // Only the valid ones. An invalid skill is reported to the pane and left out
  // of the plugin entirely — Claude Code never sees a file this app could not
  // explain.
  for (const skill of read.skills) await write(skill.name, skill.body);

  const expected = new Set([
    RESERVED_SKILL_NAME,
    ...read.skills.map((skill) => skill.name),
  ]);

  for (const entry of await readdir(skillsDir)) {
    if (!expected.has(entry)) {
      await rm(join(skillsDir, entry), { recursive: true, force: true });
    }
  }
}

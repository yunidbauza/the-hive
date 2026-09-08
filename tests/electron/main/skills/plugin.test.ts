// @vitest-environment node
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { writePluginDir } from '../../../../electron/main/skills/plugin';
import { readUserSkills } from '../../../../electron/main/skills/read';

let pluginRoot: string;
let source: string;

beforeEach(async () => {
  pluginRoot = join(await mkdtemp(join(tmpdir(), 'hive-plugin-')), 'plugin');
  source = await mkdtemp(join(tmpdir(), 'hive-skills-'));
});

/**
 * Write a minimal valid skill folder under `source`, so the fixtures the tests
 * below build come from `readUserSkills` reading real files — not a hand-built
 * `SkillsRead` whose `manifest` and `dir` were never exercised.
 */
async function writeSkill(name: string, body?: string): Promise<void> {
  await mkdir(join(source, name), { recursive: true });
  await writeFile(
    join(source, name, 'SKILL.md'),
    body ?? `---\nname: ${name}\ndescription: d\n---\nBody.\n`,
    'utf8',
  );
}

const skillsIn = (root: string): Promise<string[]> =>
  readdir(join(root, 'skills')).then((names) => names.sort());

describe('writePluginDir', () => {
  it('writes a manifest Claude Code can load', async () => {
    await writePluginDir(pluginRoot, '9.9.9', await readUserSkills(source));

    const manifest: unknown = JSON.parse(
      await readFile(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'),
    );

    expect(manifest).toMatchObject({
      name: 'hive',
      version: '9.9.9',
      skills: ['./skills/'],
    });
  });

  it('always writes the app-owned /done skill', async () => {
    await writePluginDir(pluginRoot, '1.0.0', await readUserSkills(source));

    const body = await readFile(
      join(pluginRoot, 'skills', 'done', 'SKILL.md'),
      'utf8',
    );

    expect(body).toMatch(/^---\n/);
    expect(body).toMatch(/name: done/);
  });

  it('copies each user skill verbatim', async () => {
    await writeSkill('standup');

    await writePluginDir(pluginRoot, '1.0.0', await readUserSkills(source));

    const body = await readFile(
      join(pluginRoot, 'skills', 'standup', 'SKILL.md'),
      'utf8',
    );

    expect(body).toBe('---\nname: standup\ndescription: d\n---\nBody.\n');
  });

  it('removes a skill the user deleted, so the command goes away', async () => {
    await writeSkill('standup');
    await writeSkill('triage');
    await writePluginDir(pluginRoot, '1.0.0', await readUserSkills(source));

    await rm(join(source, 'standup'), { recursive: true, force: true });
    await writePluginDir(pluginRoot, '1.0.0', await readUserSkills(source));

    expect(await skillsIn(pluginRoot)).toEqual(['done', 'triage']);
  });

  it('removes junk that is not a skill at all', async () => {
    await mkdir(join(pluginRoot, 'skills', 'stray'), { recursive: true });
    await writeFile(join(pluginRoot, 'skills', 'stray', 'note.txt'), 'x', 'utf8');

    await writePluginDir(pluginRoot, '1.0.0', await readUserSkills(source));

    expect(await skillsIn(pluginRoot)).toEqual(['done']);
  });

  it('rewrites /done every time, so an edited copy cannot persist', async () => {
    // The app owns this file. A copy edited in userData surviving a launch
    // would make the built-in mean something different per machine.
    await writePluginDir(pluginRoot, '1.0.0', await readUserSkills(source));
    await writeFile(
      join(pluginRoot, 'skills', 'done', 'SKILL.md'),
      'tampered',
      'utf8',
    );

    await writePluginDir(pluginRoot, '1.0.0', await readUserSkills(source));

    const body = await readFile(
      join(pluginRoot, 'skills', 'done', 'SKILL.md'),
      'utf8',
    );
    expect(body).not.toBe('tampered');
  });

  it('never writes an invalid skill', async () => {
    // A folder with no SKILL.md is invalid — readUserSkills rejects it and
    // reports it through `invalid`, not `skills`.
    await mkdir(join(source, 'bad'), { recursive: true });

    await writePluginDir(pluginRoot, '1.0.0', await readUserSkills(source));

    expect(await skillsIn(pluginRoot)).toEqual(['done']);
  });

  it('is idempotent, because it runs before every spawn', async () => {
    await writeSkill('standup');

    await writePluginDir(pluginRoot, '1.0.0', await readUserSkills(source));
    await writePluginDir(pluginRoot, '1.0.0', await readUserSkills(source));

    expect(await skillsIn(pluginRoot)).toEqual(['done', 'standup']);
  });

  it('copies every admitted entry into the plugin directory', async () => {
    await mkdir(join(source, 'graphify', 'scripts'), { recursive: true });
    await writeFile(
      join(source, 'graphify', 'SKILL.md'),
      '---\nname: graphify\n---\nrun scripts/build.py\n',
      'utf8',
    );
    await writeFile(join(source, 'graphify', 'scripts', 'build.py'), 'print(1)\n', 'utf8');

    await writePluginDir(pluginRoot, '1.0.0', await readUserSkills(source), null);

    const copied = join(pluginRoot, 'skills', 'graphify', 'scripts', 'build.py');
    expect(await readFile(copied, 'utf8')).toBe('print(1)\n');
  });

  it('preserves the executable bit so a script stays runnable', async () => {
    await mkdir(join(source, 'graphify', 'scripts'), { recursive: true });
    await writeFile(join(source, 'graphify', 'SKILL.md'), '---\nname: graphify\n---\n', 'utf8');
    await writeFile(join(source, 'graphify', 'scripts', 'run.sh'), '#!/bin/sh\n', 'utf8');
    await chmod(join(source, 'graphify', 'scripts', 'run.sh'), 0o755);

    await writePluginDir(pluginRoot, '1.0.0', await readUserSkills(source), null);

    const mode = (await stat(join(pluginRoot, 'skills', 'graphify', 'scripts', 'run.sh'))).mode;
    expect(mode & 0o100).not.toBe(0);
  });

  it('does not copy an excluded entry', async () => {
    await mkdir(join(source, 'graphify', 'node_modules'), { recursive: true });
    await writeFile(join(source, 'graphify', 'SKILL.md'), '---\nname: graphify\n---\n', 'utf8');
    await writeFile(join(source, 'graphify', 'node_modules', 'x.js'), 'x', 'utf8');

    await writePluginDir(pluginRoot, '1.0.0', await readUserSkills(source), null);

    await expect(
      stat(join(pluginRoot, 'skills', 'graphify', 'node_modules')),
    ).rejects.toThrow();
  });

  it('is idempotent: a second run with no source change rewrites nothing', async () => {
    await mkdir(join(source, 'graphify', 'scripts'), { recursive: true });
    await writeFile(join(source, 'graphify', 'SKILL.md'), '---\nname: graphify\n---\n', 'utf8');
    await writeFile(join(source, 'graphify', 'scripts', 'build.py'), 'print(1)\n', 'utf8');

    const read = await readUserSkills(source);
    await writePluginDir(pluginRoot, '1.0.0', read, null);

    const copied = join(pluginRoot, 'skills', 'graphify', 'scripts', 'build.py');
    const before = (await stat(copied)).mtimeMs;

    await writePluginDir(pluginRoot, '1.0.0', await readUserSkills(source), null);

    /*
      mtime, not a call count. A mirror that rewrote every file with identical
      bytes would satisfy a call count and still touch the disk before every
      spawn.
    */
    expect((await stat(copied)).mtimeMs).toBe(before);
  });

  it('prunes a file that is no longer in the source, inside a subfolder', async () => {
    await mkdir(join(source, 'graphify', 'scripts'), { recursive: true });
    await writeFile(join(source, 'graphify', 'SKILL.md'), '---\nname: graphify\n---\n', 'utf8');
    await writeFile(join(source, 'graphify', 'scripts', 'old.py'), 'x', 'utf8');
    await writePluginDir(pluginRoot, '1.0.0', await readUserSkills(source), null);

    await rm(join(source, 'graphify', 'scripts', 'old.py'));
    await writePluginDir(pluginRoot, '1.0.0', await readUserSkills(source), null);

    await expect(
      stat(join(pluginRoot, 'skills', 'graphify', 'scripts', 'old.py')),
    ).rejects.toThrow();
  });

  it('never empties a skill folder while regenerating it', async () => {
    await mkdir(join(source, 'graphify'), { recursive: true });
    await writeFile(join(source, 'graphify', 'SKILL.md'), '---\nname: graphify\n---\n', 'utf8');
    await writePluginDir(pluginRoot, '1.0.0', await readUserSkills(source), null);

    /*
      The property a wipe-and-rewrite would break, asserted the only way a
      single-threaded test can: SKILL.md is readable at every moment across a
      second regeneration, because the mirror only ever touches entries whose
      content differs and removes only what is unexpected.
    */
    const during = writePluginDir(pluginRoot, '1.0.0', await readUserSkills(source), null);
    await expect(
      readFile(join(pluginRoot, 'skills', 'graphify', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('name: graphify');
    await during;
  });
});

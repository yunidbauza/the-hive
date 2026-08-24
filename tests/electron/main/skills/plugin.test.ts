// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { writePluginDir } from '../../../../electron/main/skills/plugin';
import type { SkillsRead } from '../../../../electron/main/skills/read';

let pluginRoot: string;

beforeEach(async () => {
  pluginRoot = join(await mkdtemp(join(tmpdir(), 'hive-plugin-')), 'plugin');
});

const read = (...names: string[]): SkillsRead => ({
  skills: names.map((name) => ({
    name,
    description: 'd',
    body: `---\nname: ${name}\ndescription: d\n---\nBody.\n`,
    path: `/wherever/${name}/SKILL.md`,
  })),
  invalid: [],
});

const skillsIn = (root: string): Promise<string[]> =>
  readdir(join(root, 'skills')).then((names) => names.sort());

describe('writePluginDir', () => {
  it('writes a manifest Claude Code can load', async () => {
    await writePluginDir(pluginRoot, '9.9.9', read());

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
    await writePluginDir(pluginRoot, '1.0.0', read());

    const body = await readFile(
      join(pluginRoot, 'skills', 'done', 'SKILL.md'),
      'utf8',
    );

    expect(body).toMatch(/^---\n/);
    expect(body).toMatch(/name: done/);
  });

  it('copies each user skill verbatim', async () => {
    await writePluginDir(pluginRoot, '1.0.0', read('standup'));

    const body = await readFile(
      join(pluginRoot, 'skills', 'standup', 'SKILL.md'),
      'utf8',
    );

    expect(body).toBe('---\nname: standup\ndescription: d\n---\nBody.\n');
  });

  it('removes a skill the user deleted, so the command goes away', async () => {
    await writePluginDir(pluginRoot, '1.0.0', read('standup', 'triage'));
    await writePluginDir(pluginRoot, '1.0.0', read('triage'));

    expect(await skillsIn(pluginRoot)).toEqual(['done', 'triage']);
  });

  it('removes junk that is not a skill at all', async () => {
    await mkdir(join(pluginRoot, 'skills', 'stray'), { recursive: true });
    await writeFile(join(pluginRoot, 'skills', 'stray', 'note.txt'), 'x', 'utf8');

    await writePluginDir(pluginRoot, '1.0.0', read());

    expect(await skillsIn(pluginRoot)).toEqual(['done']);
  });

  it('rewrites /done every time, so an edited copy cannot persist', async () => {
    // The app owns this file. A copy edited in userData surviving a launch
    // would make the built-in mean something different per machine.
    await writePluginDir(pluginRoot, '1.0.0', read());
    await writeFile(
      join(pluginRoot, 'skills', 'done', 'SKILL.md'),
      'tampered',
      'utf8',
    );

    await writePluginDir(pluginRoot, '1.0.0', read());

    const body = await readFile(
      join(pluginRoot, 'skills', 'done', 'SKILL.md'),
      'utf8',
    );
    expect(body).not.toBe('tampered');
  });

  it('never writes an invalid skill', async () => {
    await writePluginDir(pluginRoot, '1.0.0', {
      skills: [],
      invalid: [{ name: 'bad', path: '/x', reason: 'no frontmatter' }],
    });

    expect(await skillsIn(pluginRoot)).toEqual(['done']);
  });

  it('is idempotent, because it runs before every spawn', async () => {
    await writePluginDir(pluginRoot, '1.0.0', read('standup'));
    await writePluginDir(pluginRoot, '1.0.0', read('standup'));

    expect(await skillsIn(pluginRoot)).toEqual(['done', 'standup']);
  });
});

// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readAvailableSkillNames } from '../../../../electron/main/skills/available';

/**
 * Every root is a temp directory, and that is the point rather than hygiene.
 *
 * Two of the three real roots live inside the developer's own `~/.claude`, so a
 * spec that read them would assert on whichever plugins happened to be
 * installed that week — green here, red on CI, and unable to cover the case
 * that matters most: the machine with nothing installed at all, which is where
 * the old behaviour refused every skill name a person could type.
 */
let root: string;

const at = (...parts: string[]) => join(root, ...parts);

/** A skill is a folder with a SKILL.md in it — the same rule `read.ts` uses. */
const skill = async (dir: string, name: string) => {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf8');
};

const registry = async (plugins: Record<string, string>) => {
  const file = at('claude', 'plugins', 'installed_plugins.json');

  await mkdir(join(root, 'claude', 'plugins'), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      version: 2,
      plugins: Object.fromEntries(
        Object.entries(plugins).map(([key, path]) => [
          key,
          [{ scope: 'user', installPath: path, version: '1.0.0' }],
        ]),
      ),
    }),
    'utf8',
  );

  return file;
};

const roots = () => ({
  hive: at('hive', 'skills'),
  user: at('claude', 'skills'),
  installedPlugins: at('claude', 'plugins', 'installed_plugins.json'),
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hive-skills-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('readAvailableSkillNames', () => {
  it('reads the hive folder', async () => {
    await skill(at('hive', 'skills'), 'release-notes');

    expect(await readAvailableSkillNames(roots())).toEqual(['release-notes']);
  });

  /*
    The widening this module exists for. An agent is a `claude -p` process on
    this machine and loads these whether or not the definition names them, so
    refusing them in the editor refused a skill the agent could reach anyway.
  */
  it('reads the user’s own ~/.claude/skills', async () => {
    await skill(at('claude', 'skills'), 'graphify');

    expect(await readAvailableSkillNames(roots())).toContain('graphify');
  });

  it('namespaces a plugin’s skills as plugin:skill', async () => {
    const install = at('cache', 'superpowers', '6.3.0');

    await skill(join(install, 'skills'), 'brainstorming');
    await registry({ 'superpowers@claude-plugins-official': install });

    expect(await readAvailableSkillNames(roots())).toContain(
      'superpowers:brainstorming',
    );
  });

  /*
    Several cached versions of one plugin sit on disk at once — this machine has
    three of `workstream` — and only the registry says which is installed. A
    glob over the cache would offer skills from a version that is not running.
  */
  it('takes the installed version’s path, not whatever else is cached', async () => {
    const current = at('cache', 'workstream', '1.17.0');
    const stale = at('cache', 'workstream', '1.15.0');

    await skill(join(current, 'skills'), 'goal-on');
    await skill(join(stale, 'skills'), 'retired-verb');
    await registry({ 'workstream@claude-kit': current });

    const names = await readAvailableSkillNames(roots());

    expect(names).toContain('workstream:goal-on');
    expect(names).not.toContain('workstream:retired-verb');
  });

  /*
    Every root is optional in practice, and the empty case is the default one:
    `~/.hive/skills` does not exist on a fresh install. Failing closed here
    would refuse every skill name on exactly the machines where the user has
    the fewest ways to work out why.
  */
  it('is empty, not an error, when nothing exists', async () => {
    await expect(readAvailableSkillNames(roots())).resolves.toEqual([]);
  });

  it('survives a registry that is not JSON', async () => {
    await mkdir(join(root, 'claude', 'plugins'), { recursive: true });
    await writeFile(
      at('claude', 'plugins', 'installed_plugins.json'),
      '{ half a file',
      'utf8',
    );
    await skill(at('hive', 'skills'), 'release-notes');

    expect(await readAvailableSkillNames(roots())).toEqual(['release-notes']);
  });

  /*
    The file belongs to Claude Code, so a layout change must cost the plugin
    names and nothing else. Losing the ability to save an agent because another
    application reshaped its own registry would be the wrong failure entirely.
  */
  it('skips a registry entry whose shape it does not recognise', async () => {
    await mkdir(join(root, 'claude', 'plugins'), { recursive: true });
    await writeFile(
      at('claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'odd@mp': 'not-an-array', 'other@mp': [{}] } }),
      'utf8',
    );
    await skill(at('claude', 'skills'), 'graphify');

    expect(await readAvailableSkillNames(roots())).toEqual(['graphify']);
  });

  it('ignores a folder with no SKILL.md', async () => {
    await mkdir(at('hive', 'skills', 'notes'), { recursive: true });
    await skill(at('hive', 'skills'), 'release-notes');

    expect(await readAvailableSkillNames(roots())).toEqual(['release-notes']);
  });

  it('deduplicates and sorts, so the set has one representation', async () => {
    await skill(at('hive', 'skills'), 'shared');
    await skill(at('claude', 'skills'), 'shared');
    await skill(at('claude', 'skills'), 'alpha');

    expect(await readAvailableSkillNames(roots())).toEqual(['alpha', 'shared']);
  });
});

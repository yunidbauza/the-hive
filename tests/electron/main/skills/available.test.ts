// @vitest-environment node
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
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

    expect((await readAvailableSkillNames(roots())).all).toEqual(['release-notes']);
  });

  /*
    The widening this module exists for. An agent is a `claude -p` process on
    this machine and loads these whether or not the definition names them, so
    refusing them in the editor refused a skill the agent could reach anyway.
  */
  it('reads the user’s own ~/.claude/skills', async () => {
    await skill(at('claude', 'skills'), 'graphify');

    expect((await readAvailableSkillNames(roots())).all).toContain('graphify');
  });

  it('namespaces a plugin’s skills as plugin:skill', async () => {
    const install = at('cache', 'superpowers', '6.3.0');

    await skill(join(install, 'skills'), 'brainstorming');
    await registry({ 'superpowers@claude-plugins-official': install });

    expect((await readAvailableSkillNames(roots())).all).toContain(
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

    const { all } = await readAvailableSkillNames(roots());

    expect(all).toContain('workstream:goal-on');
    expect(all).not.toContain('workstream:retired-verb');
  });

  /*
    Every root is optional in practice, and the empty case is the default one:
    `~/.hive/skills` does not exist on a fresh install. Failing closed here
    would refuse every skill name on exactly the machines where the user has
    the fewest ways to work out why.
  */
  it('is empty, not an error, when nothing exists', async () => {
    await expect(readAvailableSkillNames(roots())).resolves.toEqual({
      all: [],
      hive: [],
    });
  });

  it('survives a registry that is not JSON', async () => {
    await mkdir(join(root, 'claude', 'plugins'), { recursive: true });
    await writeFile(
      at('claude', 'plugins', 'installed_plugins.json'),
      '{ half a file',
      'utf8',
    );
    await skill(at('hive', 'skills'), 'release-notes');

    expect((await readAvailableSkillNames(roots())).all).toEqual(['release-notes']);
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

    expect((await readAvailableSkillNames(roots())).all).toEqual(['graphify']);
  });

  it('ignores a folder with no SKILL.md', async () => {
    await mkdir(at('hive', 'skills', 'notes'), { recursive: true });
    await skill(at('hive', 'skills'), 'release-notes');

    expect((await readAvailableSkillNames(roots())).all).toEqual(['release-notes']);
  });

  /*
    `readdir` reports `lstat` semantics, so a symlinked folder answers `false`
    to `isDirectory()`. Three of the five entries under this machine's own
    `~/.claude/skills` are links into a dotfile repo — which is where personal
    skills usually live — so dropping them would refuse exactly the skills this
    module was widened to admit. `read.ts` already fixed this once for
    `~/.hive/skills`; sharing `isSkillFolder` is what stops it being fixed twice
    and broken a third time.
  */
  it('follows a symlinked skill folder', async () => {
    const real = at('elsewhere', 'pretty-mermaid');

    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'SKILL.md'), '---\nname: pretty-mermaid\n---\n');
    await mkdir(at('claude', 'skills'), { recursive: true });
    await symlink(real, at('claude', 'skills', 'pretty-mermaid'));

    expect((await readAvailableSkillNames(roots())).all).toContain(
      'pretty-mermaid',
    );
  });

  it('leaves a symlink to a file out', async () => {
    await writeFile(at('loose.md'), 'not a skill');
    await mkdir(at('claude', 'skills'), { recursive: true });
    await symlink(at('loose.md'), at('claude', 'skills', 'loose'));

    expect((await readAvailableSkillNames(roots())).all).toEqual([]);
  });

  /*
    The install array is not ordered by relevance. `plugin-dev` on this machine
    lists a project-scoped install belonging to an unrelated repository first,
    and the user-scoped root is the one an agent's process would load.
  */
  it('prefers the user-scoped install over a project-scoped one', async () => {
    const project = at('cache', 'plugin-dev', 'project');
    const user = at('cache', 'plugin-dev', 'user');

    await skill(join(project, 'skills'), 'other-project-skill');
    await skill(join(user, 'skills'), 'agent-development');
    await mkdir(join(root, 'claude', 'plugins'), { recursive: true });
    await writeFile(
      at('claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'plugin-dev@mp': [
            { scope: 'project', installPath: project },
            { scope: 'user', installPath: user },
          ],
        },
      }),
      'utf8',
    );

    const { all } = await readAvailableSkillNames(roots());

    expect(all).toContain('plugin-dev:agent-development');
    expect(all).not.toContain('plugin-dev:other-project-skill');
  });

  it('still takes a plugin that is only project-scoped', async () => {
    const only = at('cache', 'telegram', '0.0.7');

    await skill(join(only, 'skills'), 'telegram');
    await mkdir(join(root, 'claude', 'plugins'), { recursive: true });
    await writeFile(
      at('claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: { 'telegram@mp': [{ scope: 'project', installPath: only }] },
      }),
      'utf8',
    );

    expect((await readAvailableSkillNames(roots())).all).toContain(
      'telegram:telegram',
    );
  });

  /*
    Two sets, because `parseAgent` asks two different questions. Widening the
    one the *name* clash consults reserved every name in the user's personal
    skills folder: with a personal `graphify`, no agent could be called
    `graphify` — refused on account of a folder The Hive does not manage.
  */
  it('reports the hive-owned subset separately', async () => {
    await skill(at('hive', 'skills'), 'release-notes');
    await skill(at('claude', 'skills'), 'graphify');

    const { all, hive } = await readAvailableSkillNames(roots());

    expect(all).toEqual(['graphify', 'release-notes']);
    expect(hive).toEqual(['release-notes']);
  });

  it('deduplicates and sorts, so the set has one representation', async () => {
    await skill(at('hive', 'skills'), 'shared');
    await skill(at('claude', 'skills'), 'shared');
    await skill(at('claude', 'skills'), 'alpha');

    expect((await readAvailableSkillNames(roots())).all).toEqual([
      'alpha',
      'shared',
    ]);
  });
});

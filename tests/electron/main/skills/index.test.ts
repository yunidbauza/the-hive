// @vitest-environment node
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSkillsRuntime } from '../../../../electron/main/skills';

let userDataPath: string;
let hiveDir: string;

const runtime = () =>
  createSkillsRuntime({ userDataPath, version: '1.0.0' });

const pluginSkills = (): Promise<string[]> =>
  readdir(join(userDataPath, 'hive', 'plugin', 'skills')).then((names) =>
    names.sort(),
  );

const writeSkill = async (name: string, body: string): Promise<void> => {
  await mkdir(join(hiveDir, 'skills', name), { recursive: true });
  await writeFile(join(hiveDir, 'skills', name, 'SKILL.md'), body, 'utf8');
};

const skill = (name: string): string =>
  `---\nname: ${name}\ndescription: does ${name}\n---\nBody.\n`;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'hive-runtime-'));
  userDataPath = join(base, 'userData');
  hiveDir = join(base, 'hive-home');
  await mkdir(hiveDir, { recursive: true });
  /*
    `skillsRoot()` is `dirname(configPath())/skills`, and `configPath()` reads
    this variable on every call — which is exactly the property that lets a test
    relocate the skills tree instead of writing into the developer's own.
  */
  process.env.HIVE_CONFIG_PATH = join(hiveDir, 'config.json');
});

afterEach(() => {
  delete process.env.HIVE_CONFIG_PATH;
  vi.restoreAllMocks();
});

describe('createSkillsRuntime', () => {
  it('has no path to offer before the first sync', () => {
    // `bootstrap.ts` omits the flag for null, so a session starts without extra
    // skills rather than pointed at a directory that is not there.
    expect(runtime().pluginDirPath()).toBeNull();
  });

  it('offers the generated dir once it has written it', async () => {
    const skills = runtime();

    await skills.sync();

    expect(skills.pluginDirPath()).toBe(join(userDataPath, 'hive', 'plugin'));
  });

  it('picks up a skill added after the first sync', async () => {
    // The whole reason sync runs per spawn: a skill saved from Settings thirty
    // seconds ago has to be on the next command line, with nothing to notify.
    const skills = runtime();
    await skills.sync();

    await writeSkill('standup', skill('standup'));
    const read = await skills.sync();

    expect(read.skills.map((s) => s.name)).toEqual(['standup']);
    expect(await pluginSkills()).toEqual(['done', 'standup']);
  });

  it('drops a skill the user deleted on the next sync', async () => {
    const skills = runtime();
    await writeSkill('standup', skill('standup'));
    await skills.sync();

    await skills.remove('standup');

    expect(await pluginSkills()).toEqual(['done']);
  });

  it('starts a session anyway when the plugin cannot be written', async () => {
    /*
      A *file* where the plugin root needs to be a directory, so `mkdir` throws
      ENOTDIR. A session that starts without its custom skills works; one that
      does not start because a directory could not be written does not, and the
      user has no way to connect the two.
    */
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await mkdir(join(userDataPath, 'hive'), { recursive: true });
    await writeFile(join(userDataPath, 'hive', 'plugin'), 'not a dir', 'utf8');
    const skills = runtime();

    await expect(skills.sync()).resolves.toEqual({ skills: [], invalid: [] });
    expect(skills.pluginDirPath()).toBeNull();
  });

  it('stops offering a path once a regeneration fails', async () => {
    /*
      `written` used to latch true on the first success, so a directory removed
      or broken later still produced `--plugin-dir <missing path>` — the
      opposite of what `pluginDirPath`'s contract promises.
    */
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const skills = runtime();
    await skills.sync();
    expect(skills.pluginDirPath()).not.toBeNull();

    // A file where the plugin root needs to be a directory.
    await rm(join(userDataPath, 'hive', 'plugin'), { recursive: true, force: true });
    await writeFile(join(userDataPath, 'hive', 'plugin'), 'not a dir', 'utf8');
    await skills.sync();

    expect(skills.pluginDirPath()).toBeNull();
  });

  it('serialises concurrent syncs, so a prune cannot eat a fresh write', async () => {
    /*
      `writePluginDir` ends by diffing the directory against the set it wrote.
      Two runs in flight make that diff lie: A snapshots {}, B writes standup,
      A's prune then finds standup absent from *its* expected set and removes
      it — losing a skill that exists on disk.
    */
    const skills = runtime();
    const first = skills.sync();
    await writeSkill('standup', skill('standup'));
    const second = skills.sync();

    await Promise.all([first, second]);

    expect(await pluginSkills()).toEqual(['done', 'standup']);
  });

  it('lists what the pane renders, invalid skills included', async () => {
    await writeSkill('standup', skill('standup'));
    await writeSkill('Bad Name', skill('Bad Name'));

    const snapshot = await runtime().list();

    expect(snapshot.skills).toEqual([
      { name: 'standup', description: 'does standup', valid: true },
    ]);
    expect(snapshot.invalid[0]?.name).toBe('Bad Name');
    expect(snapshot.invalid[0]?.valid).toBe(false);
    expect(snapshot.skillsRoot).toBe(join(hiveDir, 'skills'));
  });

  it('never lists the built-in, which the pane must not offer to edit', async () => {
    const snapshot = await runtime().list();

    expect(snapshot.skills.map((s) => s.name)).not.toContain('done');
  });

  it('reads one file back for the editor', async () => {
    await writeSkill('standup', skill('standup'));

    const file = await runtime().readOne('standup');

    expect(file).toEqual({
      name: 'standup',
      body: skill('standup'),
      path: join(hiveDir, 'skills', 'standup', 'SKILL.md'),
    });
  });

  it('writes a new skill and answers with the fresh snapshot', async () => {
    const snapshot = await runtime().write('standup', skill('standup'));

    expect(snapshot.skills).toEqual([
      { name: 'standup', description: 'does standup', valid: true },
    ]);
    expect(await pluginSkills()).toEqual(['done', 'standup']);
  });

  it('creates the skills tree on the first save', async () => {
    // The directory does not exist until there is something to put in it.
    await runtime().write('standup', skill('standup'));

    expect(await readdir(join(hiveDir, 'skills'))).toEqual(['standup']);
  });

  it('removes a skill, and the plugin dir loses it too', async () => {
    const skills = runtime();
    await skills.write('standup', skill('standup'));

    const snapshot = await skills.remove('standup');

    expect(snapshot.skills).toEqual([]);
    expect(await pluginSkills()).toEqual(['done']);
  });
});

// @vitest-environment node
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { seedShipped, type SeedReport } from '../../../../electron/main/seed/seed';
import { readUserSkills } from '../../../../electron/main/skills/read';

/**
 * The seed's one rule, tested from every side: the user's edits win
 * (HIVE-162). Every case below runs against real files in a temp tree and a
 * real manifest, and the last one reads the seeded skills back through
 * `readUserSkills` — the same reader the plugin generator uses — so a shipped
 * folder that the reader would refuse fails here rather than on a machine.
 */

let base: string;
let source: string;
let target: string;
let manifestFile: string;

const seed = (): Promise<SeedReport> => seedShipped({ source, target, manifestFile });

const ship = async (rel: string, body: string): Promise<void> => {
  const path = join(source, rel);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body, 'utf8');
};

const onDisk = (rel: string): Promise<string> => readFile(join(target, rel), 'utf8');

const skill = (name: string, tag = 'v1'): string =>
  `---\nname: ${name}\ndescription: does ${name} (${tag})\n---\nBody ${tag}.\n`;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'hive-seed-'));
  source = join(base, 'resources');
  target = join(base, 'hive');
  manifestFile = join(target, '.seed.json');
  await mkdir(source, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('seedShipped', () => {
  it('copies every shipped file into an empty ~/.hive and records what it wrote', async () => {
    await ship('skills/worktree/SKILL.md', skill('worktree'));
    await ship('skills/worktree/scripts/add.sh', '#!/bin/sh\n');
    await ship('agents/shipper/AGENT.md', '---\nname: shipper\n---\nbody\n');

    const report = await seed();

    expect([...report.created].sort()).toEqual([
      'agents/shipper/AGENT.md',
      'skills/worktree/SKILL.md',
      'skills/worktree/scripts/add.sh',
    ]);
    expect(report.upgraded).toEqual([]);
    expect(await onDisk('skills/worktree/scripts/add.sh')).toBe('#!/bin/sh\n');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {
      files: Record<string, string>;
    };
    expect(Object.keys(manifest.files).sort()).toEqual([...report.created].sort());
  });

  it('is idempotent: a second run with nothing changed writes nothing', async () => {
    await ship('skills/worktree/SKILL.md', skill('worktree'));
    await seed();

    const report = await seed();

    expect(report.created).toEqual([]);
    expect(report.upgraded).toEqual([]);
    expect(report.kept).toEqual(['skills/worktree/SKILL.md']);
  });

  it('upgrades a file the user left exactly as the last seed wrote it', async () => {
    await ship('skills/worktree/SKILL.md', skill('worktree', 'v1'));
    await seed();
    await ship('skills/worktree/SKILL.md', skill('worktree', 'v2'));

    const report = await seed();

    expect(report.upgraded).toEqual(['skills/worktree/SKILL.md']);
    expect(await onDisk('skills/worktree/SKILL.md')).toBe(skill('worktree', 'v2'));
  });

  it('leaves a file the user edited alone, even when the shipped copy moved on', async () => {
    await ship('skills/worktree/SKILL.md', skill('worktree', 'v1'));
    await seed();
    const edited = `${skill('worktree', 'v1')}\nMy own paragraph.\n`;
    await writeFile(join(target, 'skills/worktree/SKILL.md'), edited, 'utf8');
    await ship('skills/worktree/SKILL.md', skill('worktree', 'v2'));

    const report = await seed();

    expect(report.upgraded).toEqual([]);
    expect(report.kept).toEqual(['skills/worktree/SKILL.md']);
    expect(await onDisk('skills/worktree/SKILL.md')).toBe(edited);
  });

  it('treats a file that existed before the first seed as the user\'s', async () => {
    await mkdir(join(target, 'skills/worktree'), { recursive: true });
    await writeFile(join(target, 'skills/worktree/SKILL.md'), 'theirs\n', 'utf8');
    await ship('skills/worktree/SKILL.md', skill('worktree'));

    const report = await seed();

    expect(report.kept).toEqual(['skills/worktree/SKILL.md']);
    expect(await onDisk('skills/worktree/SKILL.md')).toBe('theirs\n');
  });

  it('never deletes a file the app used to ship', async () => {
    await ship('skills/old/SKILL.md', skill('old'));
    await seed();
    await rm(join(source, 'skills/old'), { recursive: true });
    await ship('skills/new/SKILL.md', skill('new'));

    await seed();

    expect(await onDisk('skills/old/SKILL.md')).toBe(skill('old'));
  });

  it('keeps the mode of a shipped script, so it stays executable', async () => {
    await ship('skills/worktree/SKILL.md', skill('worktree'));
    await ship('skills/worktree/scripts/add.sh', '#!/bin/sh\n');
    await chmod(join(source, 'skills/worktree/scripts/add.sh'), 0o755);

    await seed();

    const seeded = await stat(join(target, 'skills/worktree/scripts/add.sh'));
    expect(seeded.mode & 0o777).toBe(0o755);
  });

  it('leaves a shipped file the user deleted absent, instead of bringing it back', async () => {
    await ship('skills/worktree/SKILL.md', skill('worktree'));
    await seed();
    await rm(join(target, 'skills/worktree'), { recursive: true });

    const report = await seed();

    expect(report.created).toEqual([]);
    expect(report.kept).toEqual(['skills/worktree/SKILL.md']);
    await expect(onDisk('skills/worktree/SKILL.md')).rejects.toThrow();
  });

  it('skips a destination folder that is a symlink rather than writing through it', async () => {
    const elsewhere = join(base, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, 'SKILL.md'), 'linked\n', 'utf8');
    await mkdir(join(target, 'skills'), { recursive: true });
    await symlink(elsewhere, join(target, 'skills/worktree'));
    await ship('skills/worktree/SKILL.md', skill('worktree'));

    const report = await seed();

    expect(report.skipped).toEqual(['skills/worktree']);
    expect(await readFile(join(elsewhere, 'SKILL.md'), 'utf8')).toBe('linked\n');
  });

  it('never writes through a linked skills root', async () => {
    const elsewhere = join(base, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await mkdir(target, { recursive: true });
    await symlink(elsewhere, join(target, 'skills'));
    await ship('skills/worktree/SKILL.md', skill('worktree'));

    const report = await seed();

    expect(report.skipped).toEqual(['skills/worktree']);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('never writes through a linked folder inside a skill', async () => {
    const elsewhere = join(base, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await mkdir(join(target, 'skills/worktree'), { recursive: true });
    await symlink(elsewhere, join(target, 'skills/worktree/scripts'));
    await ship('skills/worktree/SKILL.md', skill('worktree'));
    await ship('skills/worktree/scripts/run.sh', '#!/bin/sh\n');

    const report = await seed();

    expect(report.created).toEqual(['skills/worktree/SKILL.md']);
    expect(report.kept).toEqual(['skills/worktree/scripts/run.sh']);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('never seeds the reserved done skill, which is generated', async () => {
    await ship('skills/done/SKILL.md', skill('done'));

    const report = await seed();

    expect(report.created).toEqual([]);
  });

  it('ships only AGENT.md out of an agent folder', async () => {
    await ship('agents/shipper/AGENT.md', '---\nname: shipper\n---\n');
    await ship('agents/shipper/notes.md', 'stray\n');

    const report = await seed();

    expect(report.created).toEqual(['agents/shipper/AGENT.md']);
  });

  it('survives a manifest that is not JSON by reading every file as the user\'s', async () => {
    await mkdir(target, { recursive: true });
    await writeFile(manifestFile, 'not json', 'utf8');
    await mkdir(join(target, 'skills/worktree'), { recursive: true });
    await writeFile(join(target, 'skills/worktree/SKILL.md'), 'theirs\n', 'utf8');
    await ship('skills/worktree/SKILL.md', skill('worktree'));

    const report = await seed();

    expect(report.kept).toEqual(['skills/worktree/SKILL.md']);
    expect(await onDisk('skills/worktree/SKILL.md')).toBe('theirs\n');
  });

  it('seeds the repository\'s own resources/skills into a tree the reader accepts whole', async () => {
    const repoResources = new URL('../../../../resources', import.meta.url).pathname;

    const report = await seedShipped({ source: repoResources, target, manifestFile });

    expect(report.created.length).toBeGreaterThan(0);
    const read = await readUserSkills(join(target, 'skills'));
    expect(read.invalid).toEqual([]);
    expect(read.skills.map((entry) => entry.name)).toContain('worktree');
  });
});

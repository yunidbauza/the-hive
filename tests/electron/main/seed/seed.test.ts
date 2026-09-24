// @vitest-environment node
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { baseOf } from '../../../../electron/main/seed/merge';
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
const historyFile = (): string => join(base, 'shipped-history.json');
const seedWithHistory = (): Promise<SeedReport> =>
  seedShipped({ source, target, manifestFile, history: historyFile() });

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A shipped-history index holding these past versions of each file. */
const writeHistory = (versions: Record<string, string[]>): Promise<void> =>
  writeFile(
    historyFile(),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(versions).map(([rel, texts]) => [
          rel,
          texts.map((text) => ({ file: sha(text), ...baseOf(text) })),
        ]),
      ),
    ),
    'utf8',
  );

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

  it('merges a shipped file into an edited one: new frontmatter lands, the edited body is held', async () => {
    await ship('skills/worktree/SKILL.md', skill('worktree', 'v1'));
    await seed();
    const edited = `${skill('worktree', 'v1')}\nMy own paragraph.\n`;
    await writeFile(join(target, 'skills/worktree/SKILL.md'), edited, 'utf8');
    await ship('skills/worktree/SKILL.md', skill('worktree', 'v2'));

    const report = await seed();

    expect(report.merged).toEqual(['skills/worktree/SKILL.md']);
    expect(await onDisk('skills/worktree/SKILL.md')).toBe(
      '---\nname: worktree\ndescription: does worktree (v2)\n---\nBody v1.\n\nMy own paragraph.\n',
    );
    // Still held on the next launch, not silently accepted.
    await seed();
    expect(await onDisk('skills/worktree/SKILL.md')).toContain('My own paragraph.');
  });

  it('keeps an edited agent key through an upgrade, and brings the new prompt and a new key', async () => {
    const v1 = '---\nname: builder\nmodel: opus\nlimits:\n  parallel: 2\n---\nPrompt v1.\n';
    const v2 = '---\nname: builder\nmodel: opus\nlane: thread\nlimits:\n  parallel: 2\n---\nPrompt v2.\n';
    await ship('agents/builder/AGENT.md', v1);
    await seed();
    await writeFile(join(target, 'agents/builder/AGENT.md'), v1.replace('parallel: 2', 'parallel: 5'), 'utf8');
    await ship('agents/builder/AGENT.md', v2);

    await seed();

    expect(await onDisk('agents/builder/AGENT.md')).toBe(v2.replace('parallel: 2', 'parallel: 5'));
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {
      files: Record<string, string>;
      parts: Record<string, { keys: Record<string, string> }>;
    };
    expect(manifest.parts['agents/builder/AGENT.md']?.keys.lane).toBeDefined();
  });

  it('never leaves an older app a whole-file hash that would overwrite a merged file', async () => {
    const v1 = '---\nname: builder\nmodel: opus\n---\nPrompt v1.\n';
    await ship('agents/builder/AGENT.md', v1);
    await seed();
    const before = (JSON.parse(await readFile(manifestFile, 'utf8')) as { files: Record<string, string> }).files;
    await writeFile(join(target, 'agents/builder/AGENT.md'), v1.replace('opus', 'haiku'), 'utf8');
    await ship('agents/builder/AGENT.md', v1.replace('v1', 'v2'));

    await seed();

    const after = (JSON.parse(await readFile(manifestFile, 'utf8')) as { files: Record<string, string> }).files;
    expect(after['agents/builder/AGENT.md']).toBe(before['agents/builder/AGENT.md']);
  });

  it('merges a file a whole-file manifest recorded, through the shipped history', async () => {
    const v1 = '---\nname: shipper\nmodel: opus\nlimits:\n  daily_usd: 40\n---\nPrompt v1.\n';
    const v2 = '---\nname: shipper\nmodel: opus\nlimits:\n  daily_usd: 40\n---\nPrompt v2.\n';
    await writeHistory({ 'agents/shipper/AGENT.md': [v1] });
    await mkdir(join(target, 'agents/shipper'), { recursive: true });
    // Edited: `daily_usd` deleted. The manifest is the old whole-file shape.
    await writeFile(join(target, 'agents/shipper/AGENT.md'), '---\nname: shipper\nmodel: opus\n---\nPrompt v1.\n', 'utf8');
    await writeFile(manifestFile, JSON.stringify({ files: { 'agents/shipper/AGENT.md': sha(v1) } }), 'utf8');
    await ship('agents/shipper/AGENT.md', v2);

    await seedWithHistory();

    expect(await onDisk('agents/shipper/AGENT.md')).toBe('---\nname: shipper\nmodel: opus\n---\nPrompt v2.\n');
  });

  it('merges a file no manifest ever recorded, through the shipped history', async () => {
    const v1 = '---\nname: fixer\nmodel: opus\n---\nPrompt v1.\n';
    await writeHistory({ 'agents/fixer/AGENT.md': [v1] });
    await mkdir(join(target, 'agents/fixer'), { recursive: true });
    await writeFile(join(target, 'agents/fixer/AGENT.md'), v1.replace('opus', 'sonnet'), 'utf8');
    await ship('agents/fixer/AGENT.md', '---\nname: fixer\nmodel: opus\nlane: thread\n---\nPrompt v2.\n');

    await seedWithHistory();

    expect(await onDisk('agents/fixer/AGENT.md')).toBe('---\nname: fixer\nmodel: sonnet\nlane: thread\n---\nPrompt v2.\n');
  });

  it('keeps a merged file deleted once the user deletes it', async () => {
    const v1 = '---\nname: fixer\nmodel: opus\n---\nPrompt v1.\n';
    await writeHistory({ 'agents/fixer/AGENT.md': [v1] });
    await mkdir(join(target, 'agents/fixer'), { recursive: true });
    await writeFile(join(target, 'agents/fixer/AGENT.md'), v1.replace('opus', 'sonnet'), 'utf8');
    await ship('agents/fixer/AGENT.md', v1.replace('v1', 'v2'));
    await seedWithHistory();

    await rm(join(target, 'agents/fixer'), { recursive: true });
    await seedWithHistory();

    await expect(readFile(join(target, 'agents/fixer/AGENT.md'), 'utf8')).rejects.toThrow();
  });

  it('leaves a pre-existing file alone when the history has no base for it', async () => {
    const theirs = '---\nname: fixer\nmodel: sonnet\n---\nTheirs.\n';
    await mkdir(join(target, 'agents/fixer'), { recursive: true });
    await writeFile(join(target, 'agents/fixer/AGENT.md'), theirs, 'utf8');
    await ship('agents/fixer/AGENT.md', '---\nname: fixer\nmodel: opus\nlane: thread\n---\nShipped.\n');

    const report = await seedWithHistory();

    expect(report.kept).toEqual(['agents/fixer/AGENT.md']);
    expect(await onDisk('agents/fixer/AGENT.md')).toBe(theirs);
  });

  it('survives a history entry that is not a version', async () => {
    const v1 = '---\nname: fixer\nmodel: opus\n---\nPrompt v1.\n';
    await writeFile(historyFile(), JSON.stringify({ 'agents/fixer/AGENT.md': [null, { file: 'x' }] }), 'utf8');
    await mkdir(join(target, 'agents/fixer'), { recursive: true });
    await writeFile(join(target, 'agents/fixer/AGENT.md'), v1, 'utf8');
    await ship('agents/fixer/AGENT.md', v1.replace('v1', 'v2'));
    await ship('skills/worktree/SKILL.md', skill('worktree'));

    const report = await seedWithHistory();

    expect(report.created).toEqual(['skills/worktree/SKILL.md']);
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
    expect(report.created).toEqual(
      expect.arrayContaining([
        'agents/shipper/AGENT.md',
        'agents/acr/AGENT.md',
        'agents/fixer/AGENT.md',
        'agents/builder/AGENT.md',
      ]),
    );
    const read = await readUserSkills(join(target, 'skills'));
    expect(read.invalid).toEqual([]);
    expect(read.skills.map((entry) => entry.name)).toEqual([
      'brainstorm',
      'debug',
      'execute',
      'goal-on',
      'merge-pr',
      'plan',
      'pr-review',
      'review-pr-findings',
      'ship',
      'spec-deviation',
      'tdd',
      'verify',
      'work-on',
      'worktree',
    ]);
  });
});

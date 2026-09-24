// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  keepMine,
  resetShipped,
  shippedStatus,
  takeShippedPrompt,
} from '../../../../electron/main/seed/actions';
import { seedShipped } from '../../../../electron/main/seed/seed';

/**
 * What Settings reads about a shipped agent or skill the user changed, and
 * the three things it can do about it.
 */

let base: string;
let source: string;
let target: string;
let manifestFile: string;

const opts = () => ({ source, target, manifestFile });

const ship = async (rel: string, body: string): Promise<void> => {
  await mkdir(join(source, rel, '..'), { recursive: true });
  await writeFile(join(source, rel), body, 'utf8');
};
const edit = (rel: string, body: string): Promise<void> => writeFile(join(target, rel), body, 'utf8');
const onDisk = (rel: string): Promise<string> => readFile(join(target, rel), 'utf8');

const AGENT = 'agents/builder/AGENT.md';
const v1 = '---\nname: builder\nmodel: opus\nlimits:\n  parallel: 2\n---\nPrompt v1.\n';
const v2 = '---\nname: builder\nmodel: opus\nlimits:\n  parallel: 2\n---\nPrompt v2.\n';
const statusOf = async (name = 'builder') =>
  (await shippedStatus(opts())).find((status) => status.name === name);

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'hive-shipped-'));
  source = join(base, 'resources');
  target = join(base, 'hive');
  manifestFile = join(target, '.seed.json');
  await ship(AGENT, v1);
  await seedShipped(opts());
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('shippedStatus', () => {
  it('reports an untouched agent as clean, with the shipped body for Compare', async () => {
    expect(await statusOf()).toEqual({
      kind: 'agents',
      name: 'builder',
      customised: [],
      moved: [],
      files: [],
      bodyEdited: false,
      held: false,
      shippedBody: 'Prompt v1.\n',
    });
  });

  it('names each key the user changed, with both values', async () => {
    await edit(AGENT, v1.replace('parallel: 2', 'parallel: 5'));

    expect((await statusOf())?.customised).toEqual([
      { path: 'limits.parallel', yours: '5', shipped: '2' },
    ]);
  });

  it('reports a held prompt once the shipped one moves under an edited one', async () => {
    await edit(AGENT, v1.replace('Prompt v1.', 'Mine.'));
    await ship(AGENT, v2);
    await seedShipped(opts());

    const status = await statusOf();

    expect(status?.held).toBe(true);
    expect(status?.shippedBody).toBe('Prompt v2.\n');
  });

  it('lists a skill file the user edited beside its SKILL.md', async () => {
    await ship('skills/tdd/SKILL.md', '---\nname: tdd\n---\nBody.\n');
    await ship('skills/tdd/prompts/x.md', 'shipped\n');
    await seedShipped(opts());
    await edit('skills/tdd/prompts/x.md', 'mine\n');

    expect((await statusOf('tdd'))?.files).toEqual(['prompts/x.md']);
  });

  it('leaves out a definition file that is itself a symlink, and never writes through it', async () => {
    const elsewhere = join(base, 'elsewhere.md');
    await writeFile(elsewhere, v1.replace('Prompt v1.', 'Mine.'), 'utf8');
    await rm(join(target, AGENT));
    await symlink(elsewhere, join(target, AGENT));
    await ship(AGENT, v2);

    expect(await shippedStatus(opts())).toEqual([]);
    await takeShippedPrompt(opts(), { kind: 'agents', name: 'builder' });
    expect(await readFile(elsewhere, 'utf8')).toContain('Mine.');
  });

  it('raises no flag for a file with no base, as the seed does not', async () => {
    await rm(manifestFile);
    await edit(AGENT, v1.replace('Prompt v1.', 'Mine.').replace('model: opus', 'model: haiku'));

    const status = await statusOf();

    expect(status?.held).toBe(false);
    expect(status?.moved).toEqual([]);
    expect(status?.bodyEdited).toBe(true);
  });

  it('runs two actions one after the other, so neither loses the other\'s manifest write', async () => {
    await ship('agents/fixer/AGENT.md', v1.replace('builder', 'fixer'));
    await seedShipped(opts());
    await edit(AGENT, v1.replace('Prompt v1.', 'Mine.'));
    await edit('agents/fixer/AGENT.md', v1.replace('builder', 'fixer').replace('Prompt v1.', 'Mine.'));
    await ship(AGENT, v2);
    await ship('agents/fixer/AGENT.md', v2.replace('builder', 'fixer'));
    await seedShipped(opts());

    await Promise.all([
      keepMine(opts(), { kind: 'agents', name: 'builder' }),
      keepMine(opts(), { kind: 'agents', name: 'fixer' }),
    ]);

    expect((await shippedStatus(opts())).filter((status) => status.held)).toEqual([]);
  });

  it('leaves out an agent the user deleted, and one behind a symlink', async () => {
    await rm(join(target, 'agents/builder'), { recursive: true });
    await ship('agents/linked/AGENT.md', '---\nname: linked\n---\nx\n');
    await mkdir(join(base, 'elsewhere'), { recursive: true });
    await symlink(join(base, 'elsewhere'), join(target, 'agents/linked'));

    expect(await shippedStatus(opts())).toEqual([]);
  });
});

describe('the actions', () => {
  it('resetShipped restores the shipped file, and the status is clean after', async () => {
    await edit(AGENT, v1.replace('parallel: 2', 'parallel: 5').replace('Prompt v1.', 'Mine.'));

    const after = await resetShipped(opts(), { kind: 'agents', name: 'builder' });

    expect(await onDisk(AGENT)).toBe(v1);
    expect(after.find((status) => status.name === 'builder')?.customised).toEqual([]);
  });

  it('resetShipped restores every shipped file of a skill', async () => {
    await ship('skills/tdd/SKILL.md', '---\nname: tdd\n---\nBody.\n');
    await ship('skills/tdd/prompts/x.md', 'shipped\n');
    await seedShipped(opts());
    await edit('skills/tdd/prompts/x.md', 'mine\n');

    await resetShipped(opts(), { kind: 'skills', name: 'tdd' });

    expect(await onDisk('skills/tdd/prompts/x.md')).toBe('shipped\n');
  });

  it('takeShippedPrompt swaps the body and keeps the user\'s keys', async () => {
    await edit(AGENT, v1.replace('parallel: 2', 'parallel: 5').replace('Prompt v1.', 'Mine.'));
    await ship(AGENT, v2);
    await seedShipped(opts());

    const after = await takeShippedPrompt(opts(), { kind: 'agents', name: 'builder' });

    expect(await onDisk(AGENT)).toBe(v2.replace('parallel: 2', 'parallel: 5'));
    expect(after.find((status) => status.name === 'builder')?.held).toBe(false);
  });

  it('keepMine clears the flags until the shipped prompt moves again', async () => {
    await edit(AGENT, v1.replace('Prompt v1.', 'Mine.').replace('model: opus', 'model: haiku'));
    await ship(AGENT, v2.replace('model: opus', 'model: sonnet'));
    await seedShipped(opts());
    expect((await statusOf())?.moved).toEqual(['model']);

    const after = await keepMine(opts(), { kind: 'agents', name: 'builder' });
    const kept = after.find((status) => status.name === 'builder');

    expect(kept?.held).toBe(false);
    expect(kept?.moved).toEqual([]);
    expect(kept?.bodyEdited).toBe(true);
    expect(await onDisk(AGENT)).toContain('Mine.');

    // The next shipped prompt raises it again.
    await ship(AGENT, v2.replace('model: opus', 'model: sonnet').replace('Prompt v2.', 'Prompt v3.'));
    await seedShipped(opts());
    expect((await statusOf())?.held).toBe(true);
  });

  it('keepMine clears a moved key whose block the merge collapsed', async () => {
    // The user wrote `limits` as one inline value; the shipped file writes it as a block.
    const inline = v1.replace('limits:\n  parallel: 2', 'limits: { parallel: 5 }');

    await edit(AGENT, inline);
    await ship(AGENT, v2.replace('parallel: 2', 'parallel: 3'));
    await seedShipped(opts());
    expect((await statusOf())?.moved).toEqual(['limits']);

    const kept = (await keepMine(opts(), { kind: 'agents', name: 'builder' })).find(
      (status) => status.name === 'builder',
    );

    expect(kept?.moved).toEqual([]);
  });

  it('refuses an agent the app does not ship, and one behind a symlink', async () => {
    await expect(resetShipped(opts(), { kind: 'agents', name: 'mine' })).rejects.toThrow(/does not ship/);

    await rm(join(target, 'agents/builder'), { recursive: true });
    await mkdir(join(base, 'elsewhere'), { recursive: true });
    await symlink(join(base, 'elsewhere'), join(target, 'agents/builder'));

    await expect(resetShipped(opts(), { kind: 'agents', name: 'builder' })).rejects.toThrow(/symlink/);
  });
});

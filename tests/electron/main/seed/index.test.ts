// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The composition around `seedShipped` (HIVE-162): where it reads from, where
 * it writes to, and that it never throws into `registerIpcHandlers`.
 */

const appMock = { isPackaged: false };
vi.mock('electron', () => ({ app: appMock }));

const { seedShippedIntoHive } = await import('../../../../electron/main/seed');

/** Where `out/main/` sits in the real tree, so `../../resources` is the repo's. */
const outMain = new URL('../../../../out/main', import.meta.url).pathname;

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'hive-seed-index-'));
  process.env['HIVE_CONFIG_PATH'] = join(base, 'hive', 'config.json');
  appMock.isPackaged = false;
});

afterEach(async () => {
  delete process.env['HIVE_CONFIG_PATH'];
  await rm(base, { recursive: true, force: true });
});

describe('seedShippedIntoHive', () => {
  it('seeds the repository resources beside the config file and writes the manifest there', async () => {
    const report = await seedShippedIntoHive(outMain);

    expect(report).not.toBeNull();
    expect(report?.created).toContain('skills/worktree/SKILL.md');
    const manifest = await readFile(join(base, 'hive', '.seed.json'), 'utf8');
    expect(manifest).toContain('skills/worktree/SKILL.md');
  });

  it('answers null rather than throwing when ~/.hive cannot be written', async () => {
    // A file where the folder should be: every mkdir under it fails.
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'hive'), 'not a folder', 'utf8');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const report = await seedShippedIntoHive(outMain);

    expect(report).toBeNull();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('could not be seeded'));
    info.mockRestore();
  });
});

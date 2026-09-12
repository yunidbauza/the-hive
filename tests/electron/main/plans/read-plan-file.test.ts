import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { PLAN_FILE_MAX_BYTES, readPlanFile } from '../../../../electron/main/plans/read-plan-file';

/**
 * The plan file's path comes from a hook payload, so the read is confined to
 * the session's own cwd (HIVE-180). Real temp dirs, no mocks: the realpath
 * and symlink behaviour is the thing under test.
 */
describe('readPlanFile', () => {
  let root: string;
  let plans: string;

  beforeEach(() => {
    // Deliberately not realpath'd: on macOS tmpdir() is itself a symlink.
    root = mkdtempSync(join(tmpdir(), 'hive-read-plan-'));
    plans = join(root, '.hive', 'plans');
    mkdirSync(plans, { recursive: true });
  });

  it('returns the text and the realpath for a plan under the cwd', async () => {
    const file = join(plans, 'a.md');
    writeFileSync(file, '## Task 1: A');

    await expect(readPlanFile(file, root)).resolves.toEqual({
      file: realpathSync(file),
      text: '## Task 1: A',
    });
  });

  it('refuses without a cwd', async () => {
    const file = join(plans, 'a.md');
    writeFileSync(file, 'x');

    await expect(readPlanFile(file, undefined)).resolves.toBeUndefined();
  });

  it('refuses a file outside the cwd', async () => {
    const other = mkdtempSync(join(tmpdir(), 'hive-read-plan-other-'));
    mkdirSync(join(other, '.hive', 'plans'), { recursive: true });
    const file = join(other, '.hive', 'plans', 'a.md');
    writeFileSync(file, 'x');

    await expect(readPlanFile(file, root)).resolves.toBeUndefined();
  });

  it('refuses a symlink inside the cwd that points outside it', async () => {
    const other = mkdtempSync(join(tmpdir(), 'hive-read-plan-secret-'));
    const secret = join(other, 'secret.md');
    writeFileSync(secret, 'not yours');
    const link = join(plans, 'link.md');
    symlinkSync(secret, link);

    await expect(readPlanFile(link, root)).resolves.toBeUndefined();
  });

  it('refuses a cwd that is only a prefix of the path, not its parent', async () => {
    const sibling = `${root}-sibling`;
    mkdirSync(join(sibling, '.hive', 'plans'), { recursive: true });
    const file = join(sibling, '.hive', 'plans', 'a.md');
    writeFileSync(file, 'x');

    await expect(readPlanFile(file, root)).resolves.toBeUndefined();
  });

  it('refuses a file over 1 MiB', async () => {
    const file = join(plans, 'big.md');
    writeFileSync(file, 'x'.repeat(PLAN_FILE_MAX_BYTES + 1));

    await expect(readPlanFile(file, root)).resolves.toBeUndefined();
  });

  it('refuses a file that does not exist, and a directory', async () => {
    const directory = join(plans, 'dir.md');
    mkdirSync(directory);

    await expect(readPlanFile(join(plans, 'missing.md'), root)).resolves.toBeUndefined();
    await expect(readPlanFile(directory, root)).resolves.toBeUndefined();
  });
});

// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  onConfigChange,
  reloadConfig,
  setProjectAutoMerge,
} from '../../../../electron/main/config';
import { CONFIG_PATH_ENV, type ConfigSnapshot } from '../../../../electron/shared/config-contract';

/**
 * The config's one change listener (retro C, Task 5).
 *
 * A config change is invisible to an agent that only wakes for the ledger:
 * the person turned auto-merge on while a PR sat at `approval`, and the
 * shipper's next wake saw nothing addressed to it. The composition hears every
 * installed snapshot here and turns an `autoMerge` flip into a post.
 */

let dir: string;
let path: string;
const originalConfigPath = process.env[CONFIG_PATH_ENV];

const document = (autoMerge: boolean): string =>
  `${JSON.stringify({ version: 2, projects: [{ id: 'hive', key: 'hi', path: dir, autoMerge }] }, null, 2)}\n`;

const autoMergeOf = (snapshot: ConfigSnapshot | null): boolean | undefined =>
  snapshot?.projects.find((project) => project.id === 'hive')?.autoMerge;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-config-change-'));
  path = join(dir, 'config.json');
  process.env[CONFIG_PATH_ENV] = path;
  writeFileSync(path, document(false));
  reloadConfig();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalConfigPath === undefined) delete process.env[CONFIG_PATH_ENV];
  else process.env[CONFIG_PATH_ENV] = originalConfigPath;
});

describe('onConfigChange (retro C)', () => {
  it('hears the snapshot before and after a setProjectAutoMerge write', () => {
    const heard = vi.fn();
    const off = onConfigChange(heard);

    setProjectAutoMerge({ id: 'hive', autoMerge: true });

    expect(heard).toHaveBeenCalledTimes(1);
    const [before, after] = heard.mock.calls[0] as [ConfigSnapshot | null, ConfigSnapshot];
    expect(autoMergeOf(before)).toBe(false);
    expect(autoMergeOf(after)).toBe(true);
    off();
  });

  it('hears reloadConfig pick up a hand edit', () => {
    const heard = vi.fn();
    const off = onConfigChange(heard);

    writeFileSync(path, document(true));
    reloadConfig();

    expect(heard).toHaveBeenCalledTimes(1);
    const [before, after] = heard.mock.calls[0] as [ConfigSnapshot | null, ConfigSnapshot];
    expect(autoMergeOf(before)).toBe(false);
    expect(autoMergeOf(after)).toBe(true);
    off();
  });

  it('hears nothing for a refused write, and nothing after unsubscribing', () => {
    const heard = vi.fn();
    const off = onConfigChange(heard);

    setProjectAutoMerge({ id: 'no-such-project', autoMerge: true });
    expect(heard).not.toHaveBeenCalled();

    off();
    setProjectAutoMerge({ id: 'hive', autoMerge: true });
    expect(heard).not.toHaveBeenCalled();
  });
});

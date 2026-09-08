// @vitest-environment node
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { copyInto } from '../../../../electron/main/skills/import';

let hiveDir: string;
let skillsDir: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'hive-import-'));
  hiveDir = join(base, 'hive-home');
  outside = join(base, 'outside');
  await mkdir(hiveDir, { recursive: true });
  await mkdir(outside, { recursive: true });

  /*
    `skillsRoot()` is `dirname(configPath())/skills`, and `configPath()` reads
    this variable on every call — the property that lets a test relocate the
    skills tree instead of writing into the developer's own.
  */
  process.env.HIVE_CONFIG_PATH = join(hiveDir, 'config.json');
  skillsDir = join(hiveDir, 'skills');

  // `resolveInSkill` calls `realpath` on the skill folder, which throws if it
  // is not there — so the bundle has to exist on disk before `copyInto` runs.
  await mkdir(join(skillsDir, 'graphify'), { recursive: true });
});

afterEach(() => {
  delete process.env.HIVE_CONFIG_PATH;
});

describe('copyInto', () => {
  it('copies a chosen file into the target directory, keeping its mode', async () => {
    const source = join(outside, 'run.sh');
    await writeFile(source, '#!/bin/sh\n', 'utf8');
    await chmod(source, 0o755);

    await copyInto('graphify', 'scripts', [source]);

    const mode = (await stat(join(skillsDir, 'graphify', 'scripts', 'run.sh'))).mode;
    // An imported file keeps the mode it had. The shebang rule is for files the
    // pane writes, not for files that arrived with a mode of their own.
    expect(mode & 0o777).toBe(0o755);
  });

  it('brings a dropped folder in whole, under the same walk', async () => {
    await mkdir(join(outside, 'references'), { recursive: true });
    await writeFile(join(outside, 'references', 'schema.json'), '{}', 'utf8');

    await copyInto('graphify', '', [join(outside, 'references')]);

    expect(
      await readFile(join(skillsDir, 'graphify', 'references', 'schema.json'), 'utf8'),
    ).toBe('{}');
  });

  it('refuses a skipped name at the door rather than copying then dimming it', async () => {
    await mkdir(join(outside, 'node_modules'), { recursive: true });
    await writeFile(join(outside, 'node_modules', 'x.js'), 'x', 'utf8');

    await expect(
      copyInto('graphify', '', [join(outside, 'node_modules')]),
    ).rejects.toThrow();

    await expect(stat(join(skillsDir, 'graphify', 'node_modules'))).rejects.toThrow();
  });

  it('writes nothing at all when one source is over a cap', async () => {
    await writeFile(join(outside, 'ok.txt'), 'fine', 'utf8');
    await writeFile(join(outside, 'big.bin'), Buffer.alloc(5_000_001));

    await expect(
      copyInto('graphify', '', [
        join(outside, 'ok.txt'),
        join(outside, 'big.bin'),
      ]),
    ).rejects.toThrow();

    /*
      The caps are applied before anything is written, so a refused batch leaves
      no half-copy behind. A user retrying after removing the big file should not
      find the small one already there under a folder they did not create.
    */
    await expect(stat(join(skillsDir, 'graphify', 'ok.txt'))).rejects.toThrow();
  });
});

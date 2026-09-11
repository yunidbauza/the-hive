// @vitest-environment node
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { strToU8, zipSync, type Zippable } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_BUNDLE_FILES, MAX_BUNDLE_FILE_BYTES } from '@shared/skills-contract';

import {
  importSkill,
  isSkillPackage,
} from '../../../../electron/main/skills/import-skill';

/**
 * Importing a whole skill — a zip, or a folder with SKILL.md at its root.
 *
 * Every refusal is asserted on the disk as well as the message: nothing in
 * `skills/`, and no `.skill-import-*` staging folder left beside it. "Total"
 * is the property, and a message alone cannot show it.
 */

let base: string;
let hiveDir: string;
let skillsDir: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'hive-import-skill-'));
  hiveDir = join(base, 'hive-home');
  await mkdir(hiveDir, { recursive: true });
  // `skillsRoot()` is `dirname(configPath())/skills`; see `import.test.ts`.
  process.env.HIVE_CONFIG_PATH = join(hiveDir, 'config.json');
  skillsDir = join(hiveDir, 'skills');
});

afterEach(() => {
  delete process.env.HIVE_CONFIG_PATH;
});

const manifest = (name: string): string =>
  `---\nname: ${name}\ndescription: reviews a PR\n---\nReview it.\n`;

const zipAt = async (file: string, entries: Zippable): Promise<string> => {
  const path = join(base, file);
  await writeFile(path, zipSync(entries));
  return path;
};

/**
 * Rewrite one central-directory field of a zip, the way a hostile archive
 * would: `fflate` only ever writes honest ones. Offsets are the zip format's
 * own (APPNOTE 4.3.12): method at +10, uncompressed size at +24, name length
 * at +28, name at +46.
 */
const forge = (
  zip: Uint8Array,
  name: string,
  field: 'method' | 'uncompressed',
  value: number,
): Uint8Array => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let at = 0; at + 46 <= zip.length; at += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) continue;
    const length = view.getUint16(at + 28, true);
    if (Buffer.from(zip.subarray(at + 46, at + 46 + length)).toString('utf8') !== name) {
      continue;
    }
    if (field === 'method') view.setUint16(at + 10, value, true);
    else view.setUint32(at + 24, value, true);
    return zip;
  }
  throw new Error(`no central directory entry for ${name}`);
};

const skillsOnDisk = (): Promise<string[]> =>
  readdir(skillsDir).then((names) => names.sort(), () => []);

const leftovers = async (): Promise<string[]> =>
  (await readdir(hiveDir)).filter((name) => name.startsWith('.skill-import-'));

const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

const refuses = async (source: string, message: RegExp): Promise<void> => {
  await expect(importSkill(source)).rejects.toThrow(message);
  expect(await skillsOnDisk()).toEqual([]);
  expect(await leftovers()).toEqual([]);
};

describe('importSkill — a folder', () => {
  it('becomes a skill named by its frontmatter, structure and modes intact', async () => {
    const source = join(base, 'downloaded');
    await mkdir(join(source, 'scripts'), { recursive: true });
    await mkdir(join(source, 'assets'), { recursive: true });
    await writeFile(join(source, 'SKILL.md'), manifest('pr-review'));
    await writeFile(join(source, 'scripts', 'run.sh'), 'echo hi\n');
    await chmod(join(source, 'scripts', 'run.sh'), 0o755);
    await writeFile(join(source, '.DS_Store'), 'finder');

    expect(await importSkill(source)).toBe('pr-review');

    const skill = join(skillsDir, 'pr-review');
    expect(await readFile(join(skill, 'SKILL.md'), 'utf8')).toBe(manifest('pr-review'));
    expect(await readFile(join(skill, 'scripts', 'run.sh'), 'utf8')).toBe('echo hi\n');
    expect(await mode(join(skill, 'scripts', 'run.sh'))).toBe(0o755);
    // The empty folder is structure the user shipped; the Finder file is not.
    expect((await readdir(skill)).sort()).toEqual(['SKILL.md', 'assets', 'scripts']);
    expect(await leftovers()).toEqual([]);
  });

  it('refuses a folder with no SKILL.md at its root', async () => {
    const source = join(base, 'plain');
    await mkdir(join(source, 'nested'), { recursive: true });
    await writeFile(join(source, 'nested', 'SKILL.md'), manifest('nested'));

    await refuses(source, /no SKILL\.md at its root/);
  });

  it('refuses a folder holding a file over the size cap', async () => {
    const source = join(base, 'big');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'SKILL.md'), manifest('big'));
    await writeFile(join(source, 'blob.bin'), Buffer.alloc(MAX_BUNDLE_FILE_BYTES + 1));

    await refuses(source, /blob\.bin/);
  });

  it('refuses a top-level symlink rather than following it', async () => {
    const real = join(base, 'real');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'SKILL.md'), manifest('real'));
    const link = join(base, 'link');
    await symlink(real, link);

    await refuses(link, /symlink/);
  });
});

describe('importSkill — a zip', () => {
  it('imports SKILL.md at the zip root, with shebang files executable', async () => {
    const source = await zipAt('pr-review.zip', {
      'SKILL.md': strToU8(manifest('pr-review')),
      'assets/': new Uint8Array(),
      scripts: {
        'run.sh': strToU8('#!/bin/sh\necho hi\n'),
        'notes.txt': strToU8('plain'),
      },
    });

    expect(await importSkill(source)).toBe('pr-review');

    const skill = join(skillsDir, 'pr-review');
    expect((await readdir(skill)).sort()).toEqual(['SKILL.md', 'assets', 'scripts']);
    expect(await readFile(join(skill, 'scripts', 'run.sh'), 'utf8')).toBe(
      '#!/bin/sh\necho hi\n',
    );
    expect(await mode(join(skill, 'scripts', 'run.sh'))).toBe(0o755);
    expect(await mode(join(skill, 'scripts', 'notes.txt'))).toBe(0o644);
    expect(await leftovers()).toEqual([]);
  });

  it('imports the one folder a macOS "Compress" wraps it in, skipping its __MACOSX shadow', async () => {
    const source = await zipAt('Archive.zip', {
      'pr-review': {
        'SKILL.md': strToU8(manifest('pr-review')),
        references: { 'guide.md': strToU8('# Guide') },
        '.DS_Store': strToU8('finder'),
      },
      // Beside the one folder, not a second top-level entry that counts.
      '.DS_Store': strToU8('finder'),
      __MACOSX: { 'pr-review': { '._SKILL.md': strToU8('resource fork') } },
    });

    expect(await importSkill(source)).toBe('pr-review');

    const skill = join(skillsDir, 'pr-review');
    expect((await readdir(skill)).sort()).toEqual(['SKILL.md', 'references']);
    expect(await readFile(join(skill, 'references', 'guide.md'), 'utf8')).toBe('# Guide');
  });

  it('refuses a zip with no SKILL.md at its root or under its one folder', async () => {
    const source = await zipAt('deep.zip', {
      outer: { inner: { 'SKILL.md': strToU8(manifest('deep')) } },
    });

    await refuses(source, /no SKILL\.md at its root/);
  });

  it('refuses a zip whose SKILL.md sits beside a second top-level folder', async () => {
    const source = await zipAt('two.zip', {
      one: { 'SKILL.md': strToU8(manifest('one')) },
      two: { 'x.md': strToU8('x') },
    });

    await refuses(source, /no SKILL\.md at its root/);
  });

  it('refuses an entry that climbs out with ..', async () => {
    const source = await zipAt('slip.zip', {
      'SKILL.md': strToU8(manifest('slip')),
      '../escape.txt': strToU8('outside'),
    });

    await refuses(source, /not a path inside the zip/);
    await expect(stat(join(hiveDir, 'escape.txt'))).rejects.toThrow();
  });

  it('refuses an absolute entry', async () => {
    const source = await zipAt('abs.zip', {
      'SKILL.md': strToU8(manifest('abs')),
      '/tmp/abs.txt': strToU8('outside'),
    });

    await refuses(source, /not a path inside the zip/);
  });

  it('refuses an entry deeper than a skill may hold', async () => {
    const source = await zipAt('deep.zip', {
      'SKILL.md': strToU8(manifest('deep')),
      a: { b: { c: { d: { 'e.txt': strToU8('too deep') } } } },
    });

    await refuses(source, /too deep/);
  });

  it('refuses more files than a skill may hold', async () => {
    const entries: Zippable = { 'SKILL.md': strToU8(manifest('many')) };
    for (let index = 0; index < MAX_BUNDLE_FILES; index += 1) {
      entries[`f${String(index)}.txt`] = strToU8('x');
    }
    const source = await zipAt('many.zip', entries);

    await refuses(source, /more than 200 files/);
  });

  it('refuses a file over the size cap on its declared size', async () => {
    const source = await zipAt('big.zip', {
      'SKILL.md': strToU8(manifest('big')),
      'blob.bin': new Uint8Array(MAX_BUNDLE_FILE_BYTES + 1),
    });

    await refuses(source, /blob\.bin" is larger than/);
  });

  it('refuses a stored entry that declares less than it holds, before inflating anything', async () => {
    const zip = zipSync(
      {
        'SKILL.md': strToU8(manifest('bomb')),
        'blob.bin': new Uint8Array(MAX_BUNDLE_FILE_BYTES + 1),
      },
      { level: 0 },
    );
    const source = join(base, 'bomb.zip');
    // Stored (level 0) entries are sliced by their compressed size, so the
    // one-byte claim is what a size cap alone would have believed.
    await writeFile(source, forge(zip, 'blob.bin', 'uncompressed', 1));

    await refuses(source, /blob\.bin" is not the size it declares/);
  });

  it('refuses a compression method it cannot read', async () => {
    const zip = zipSync({
      'SKILL.md': strToU8(manifest('odd')),
      'x.txt': strToU8('x'),
    });
    const source = join(base, 'odd.zip');
    await writeFile(source, forge(zip, 'x.txt', 'method', 99));

    await refuses(source, /compression this cannot read/);
  });

  it('refuses two entries that are one file on a case-blind disk', async () => {
    const source = await zipAt('case.zip', {
      'SKILL.md': strToU8(manifest('case')),
      'skill.md': strToU8(manifest('other')),
    });

    await refuses(source, /would be the same file on disk/);
  });

  it('refuses a file and a folder that differ only in case', async () => {
    const source = await zipAt('case-dir.zip', {
      'SKILL.md': strToU8(manifest('case-dir')),
      a: strToU8('a file'),
      'A/b.txt': strToU8('under A'),
    });

    await refuses(source, /both a file and a folder/);
  });

  it('refuses a path that is both a file and a folder', async () => {
    const source = await zipAt('clash.zip', {
      'SKILL.md': strToU8(manifest('clash')),
      a: strToU8('a file'),
      'a/b.txt': strToU8('under a'),
    });

    await refuses(source, /both a file and a folder/);
  });

  it('refuses something that is not a zip', async () => {
    const source = join(base, 'bad.zip');
    await writeFile(source, 'this is not a zip');

    await refuses(source, /not a readable zip/);
  });

  it('refuses a plain file that is not a zip at all', async () => {
    const source = join(base, 'notes.txt');
    await writeFile(source, 'hello');

    await refuses(source, /not a zip or a folder/);
  });
});

describe('importSkill — the name', () => {
  const named = (body: string) => zipAt('named.zip', { 'SKILL.md': strToU8(body) });

  it('refuses a name already taken', async () => {
    await mkdir(join(skillsDir, 'pr-review'), { recursive: true });
    await writeFile(join(skillsDir, 'pr-review', 'SKILL.md'), 'mine');

    await expect(importSkill(await named(manifest('pr-review')))).rejects.toThrow(
      /already exists/,
    );
    // The skill that was there is untouched.
    expect(await readFile(join(skillsDir, 'pr-review', 'SKILL.md'), 'utf8')).toBe('mine');
    expect(await leftovers()).toEqual([]);
  });

  it('refuses a name off the pattern', async () => {
    await refuses(await named(manifest('Bad Name')), /not a skill name/);
  });

  it('refuses the reserved name', async () => {
    await refuses(await named(manifest('done')), /reserved/);
  });

  it('refuses a SKILL.md with no frontmatter', async () => {
    await refuses(await named('Just prose.\n'), /no frontmatter/);
  });

  it('refuses a SKILL.md that declares no name', async () => {
    await refuses(await named('---\ndescription: x\n---\nBody.\n'), /declares no name/);
  });
});

it('leaves no staging folder when the last step fails', async () => {
  // `skills` is a file, so creating the tree under it fails after staging.
  await writeFile(skillsDir, 'not a folder');
  const source = await zipAt('pr-review.zip', {
    'SKILL.md': strToU8(manifest('pr-review')),
  });

  await expect(importSkill(source)).rejects.toThrow();
  expect(await leftovers()).toEqual([]);
});

describe('isSkillPackage', () => {
  it('answers yes for a zip holding a skill and for a folder with SKILL.md, no otherwise', async () => {
    const asset = await zipAt('template.zip', { 'x.txt': strToU8('x') });
    const rooted = await zipAt('rooted.zip', { 'SKILL.md': strToU8(manifest('rooted')) });
    const wrapped = await zipAt('wrapped.zip', {
      wrapped: { 'SKILL.md': strToU8(manifest('wrapped')) },
    });
    const broken = join(base, 'broken.zip');
    await writeFile(broken, 'not a zip');
    const skill = join(base, 'skill');
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), manifest('skill'));
    const plain = join(base, 'plain');
    await mkdir(plain, { recursive: true });
    const file = join(base, 'notes.txt');
    await writeFile(file, 'x');
    const link = join(base, 'link');
    await symlink(skill, link);

    expect(await isSkillPackage(rooted)).toBe(true);
    expect(await isSkillPackage(wrapped)).toBe(true);
    // A zip without a skill in it is an asset, as it always was.
    expect(await isSkillPackage(asset)).toBe(false);
    expect(await isSkillPackage(broken)).toBe(false);
    expect(await isSkillPackage(skill)).toBe(true);
    expect(await isSkillPackage(plain)).toBe(false);
    expect(await isSkillPackage(file)).toBe(false);
    expect(await isSkillPackage(link)).toBe(false);
    expect(await isSkillPackage(join(base, 'missing'))).toBe(false);
  });
});

import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { unzipSync } from 'fflate';

import {
  MAX_BUNDLE_DEPTH,
  MAX_BUNDLE_FILES,
  MAX_BUNDLE_FILE_BYTES,
  RESERVED_SKILL_NAME,
  SKILL_NAME_PATTERN,
  SKILL_SKIP_ENTRIES,
} from '@shared/skills-contract';

import { readBundle } from './bundle';
import { skillsRoot } from './paths';
import { frontmatter } from './read';

/**
 * Importing a whole skill from outside: a zip, or a folder with `SKILL.md` at
 * its root.
 *
 * `copyInto` (`import.ts`) adds files *to* a skill. This makes one. The name
 * comes from the imported `SKILL.md`'s frontmatter, because the folder is
 * named from it everywhere else in this module and a skill whose folder and
 * frontmatter disagree is one `readUserSkills` refuses.
 *
 * ## Total, like `copyInto`
 *
 * Every entry is checked before a byte is written, and the bytes are written
 * to a staging folder beside `skills/` — beside where it really resolves, so
 * the last step is one same-volume `rename` even when `~/.hive/skills` is a
 * dotfiles symlink — never into `skills/` itself. A refusal at any point
 * leaves nothing behind: not a half-copied skill, and not a staging folder,
 * which is removed on every path out. Staging sits outside `skills/` because
 * `readUserSkills` lists every folder there, and a sync landing mid-import
 * would show the half-written one as an invalid row.
 *
 * ## A zip is read in memory, and its declared sizes are the bound
 *
 * Two passes over the central directory. The first inflates nothing and only
 * reads names, methods and sizes, which is where every cap is enforced — so a
 * zip bomb is refused on what it *claims*, before any inflation. The second
 * inflates only the admitted entries, and every result is then held to the
 * size it declared.
 *
 * The two methods are bounded differently, and only one of them by `fflate`.
 * A deflated entry is inflated into a buffer of exactly its declared size, so
 * one that lies about its size comes back truncated, never larger. A
 * **stored** entry is sliced by its *compressed* size instead — so a stored
 * entry declaring one byte can return six megabytes, and a hundred entries
 * pointing at the same payload multiply it. So a stored entry whose two sizes
 * disagree is refused in pass one, any method other than stored or deflate is
 * refused before `fflate` would throw on it, and pass two's output is
 * measured anyway.
 *
 * ## Names that collide on the disk they land on
 *
 * The default macOS volume ignores case and Unicode normalisation, so
 * `SKILL.md` and `skill.md` are one file there. Every collision check keys on
 * the NFC-normalised, lower-cased path: two entries that would land on one
 * file are refused, rather than the second silently replacing the first —
 * which, for `SKILL.md`, would replace the very file whose name was checked.
 */

/**
 * The largest zip read, and the most its entries may declare in total.
 *
 * ponytail: one ceiling for both, generous for a skill (text and a few
 * scripts); split it if skills start shipping large assets.
 */
export const MAX_SKILL_ZIP_BYTES = 100_000_000;

const STORED = 0;
const DEFLATE = 8;

interface Staged {
  /** Skill-relative, `/`-separated. */
  path: string;
  /** A zip entry's bytes, or `null` for a folder's file copied from `from`. */
  bytes: Uint8Array | null;
  from: string | null;
  mode: number;
}

interface Contents {
  files: Staged[];
  dirs: string[];
}

interface Listed {
  name: string;
  /** Compressed. */
  size: number;
  originalSize: number;
  compression: number;
}

/**
 * Is `source` a whole skill — a zip holding a skill, or a folder with
 * `SKILL.md` at its root?
 *
 * A zip counts only when its listing has a `SKILL.md` where `importSkill`
 * would look for one. A `template.zip` dropped into `assets/` is an asset,
 * and `copyInto` has always added it as one; reading the central directory
 * costs no inflation.
 */
export async function isSkillPackage(source: string): Promise<boolean> {
  const info = await lstat(source).catch(() => null);
  if (info === null || info.isSymbolicLink()) return false;
  if (info.isDirectory()) {
    const manifest = await lstat(join(source, 'SKILL.md')).catch(() => null);
    return manifest?.isFile() ?? false;
  }
  if (!info.isFile() || !isZipName(source) || info.size > MAX_SKILL_ZIP_BYTES) {
    return false;
  }
  try {
    const names = listZip(new Uint8Array(await readFile(source))).map((entry) => entry.name);
    return manifestDepth(names) !== null;
  } catch {
    return false;
  }
}

/** Import one skill package as a new skill, and answer with its name. */
export async function importSkill(source: string): Promise<string> {
  const label = basename(source);
  const info = await lstat(source).catch(() => {
    throw new Error(`"${label}" could not be found — nothing was imported.`);
  });
  if (info.isSymbolicLink()) {
    throw new Error(`"${label}" is a symlink — nothing was imported.`);
  }

  const contents = info.isDirectory()
    ? await fromFolder(source, label)
    : await fromZip(source, label, info.size);

  const manifest = contents.files.find((file) => file.path === 'SKILL.md');
  if (manifest === undefined) {
    throw new Error(`"${label}" has no SKILL.md at its root — nothing was imported.`);
  }
  const body = Buffer.from(
    manifest.bytes ?? (await readFile(manifest.from ?? '')),
  ).toString('utf8');
  const name = declaredName(body);

  const target = join(skillsRoot(), name);
  const taken = `A skill called "${name}" already exists — nothing was imported.`;
  if (await exists(target)) throw new Error(taken);

  const root = await realpath(skillsRoot()).catch(() => skillsRoot());
  const staging = join(dirname(root), `.skill-import-${randomUUID()}`);
  try {
    await mkdir(staging, { recursive: true });
    for (const dir of contents.dirs) {
      await mkdir(join(staging, dir), { recursive: true });
    }
    for (const file of contents.files) {
      const to = join(staging, file.path);
      await mkdir(dirname(to), { recursive: true });
      if (file.bytes === null) await copyFile(file.from ?? '', to);
      else await writeFile(to, file.bytes);
      await chmod(to, file.mode);
    }

    await mkdir(skillsRoot(), { recursive: true });
    // Again, right before the move: `rename(2)` replaces an empty directory
    // silently, which is the collision `rename` in `index.ts` refuses too.
    if (await exists(target)) throw new Error(taken);
    await rename(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  return name;
}

/** The frontmatter's `name`, or a sentence saying why it cannot be one. */
function declaredName(body: string): string {
  const keys = frontmatter(body);
  if (keys === null) {
    throw new Error(
      'Its SKILL.md has no frontmatter — it must open and close with a --- fence. Nothing was imported.',
    );
  }
  const name = keys.name ?? '';
  if (name === '') {
    throw new Error('Its SKILL.md declares no name — nothing was imported.');
  }
  if (name === RESERVED_SKILL_NAME) {
    throw new Error(`"${name}" is reserved by The Hive — nothing was imported.`);
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      `"${name}" is not a skill name — lowercase letters, digits and dashes only. Nothing was imported.`,
    );
  }
  return name;
}

/**
 * A folder's contents, through the same walk the skills tree uses.
 *
 * So the caps are `readBundle`'s own: a capped walk or an oversized file
 * refuses, and what the walk skips by name or refuses to follow (a symlink)
 * is left behind, exactly as `copyInto` treats a dropped folder.
 */
async function fromFolder(source: string, label: string): Promise<Contents> {
  const manifest = await readBundle(source);
  if (manifest.capped !== null) {
    throw new Error(`"${label}": ${manifest.capped} Nothing was imported.`);
  }

  const contents: Contents = { files: [], dirs: [] };
  for (const entry of manifest.entries) {
    if (entry.excluded !== null) {
      if (entry.excluded.code === 'skipped' || entry.excluded.code === 'symlink') {
        continue;
      }
      throw new Error(`${entry.path}: ${entry.excluded.reason} Nothing was imported.`);
    }
    if (entry.kind === 'directory') {
      contents.dirs.push(entry.path);
      continue;
    }
    const from = join(source, entry.path);
    contents.files.push({
      path: entry.path,
      bytes: null,
      from,
      mode: (await stat(from)).mode & 0o777,
    });
  }
  return contents;
}

/** A zip's contents, every entry checked before any is inflated. */
async function fromZip(source: string, label: string, size: number): Promise<Contents> {
  if (!isZipName(source)) {
    throw new Error(`"${label}" is not a zip or a folder — nothing was imported.`);
  }
  if (size > MAX_SKILL_ZIP_BYTES) {
    throw new Error(
      `"${label}" is larger than ${String(MAX_SKILL_ZIP_BYTES / 1_000_000)} MB — nothing was imported.`,
    );
  }

  const data = new Uint8Array(await readFile(source));

  // Pass one: names, methods and sizes only. Nothing is inflated.
  let listed: Listed[];
  try {
    listed = listZip(data);
  } catch {
    throw new Error(`"${label}" is not a readable zip — nothing was imported.`);
  }

  const kept: { raw: string; segments: string[]; dir: boolean; size: number }[] = [];
  for (const entry of listed) {
    const { name } = entry;
    if (!visible(name)) continue;
    if (name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
      throw new Error(`"${name}" is not a path inside the zip — nothing was imported.`);
    }
    const dir = name.endsWith('/');
    const segments = (dir ? name.slice(0, -1) : name).split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`"${name}" is not a path inside the zip — nothing was imported.`);
    }
    if (!dir && entry.compression !== STORED && entry.compression !== DEFLATE) {
      throw new Error(`"${name}" uses a compression this cannot read — nothing was imported.`);
    }
    if (!dir && entry.compression === STORED && entry.size !== entry.originalSize) {
      throw new Error(`"${name}" is not the size it declares — nothing was imported.`);
    }
    kept.push({ raw: name, segments, dir, size: entry.originalSize });
  }

  const strip = manifestDepth(kept.map((entry) => entry.raw));
  if (strip === null) {
    throw new Error(`"${label}" has no SKILL.md at its root — nothing was imported.`);
  }

  const contents: Contents = { files: [], dirs: [] };
  const admit = new Map<string, { path: string; size: number }>();
  /** Keyed as the disk compares names: case- and normalisation-blind. */
  const fileKeys = new Map<string, string>();
  const dirKeys = new Set<string>();
  const keyOf = (path: string): string => path.normalize('NFC').toLowerCase();
  let total = 0;

  for (const entry of kept) {
    const path = entry.segments.slice(strip).join('/');
    if (path === '') continue; // The wrapping folder itself.
    if (path.split('/').length > MAX_BUNDLE_DEPTH) {
      throw new Error(`"${path}" is too deep for a skill — nothing was imported.`);
    }
    const key = keyOf(path);
    if (entry.dir) {
      if (fileKeys.has(key)) {
        throw new Error(`"${path}" is both a file and a folder in the zip — nothing was imported.`);
      }
      dirKeys.add(key);
      contents.dirs.push(path);
      continue;
    }
    const other = fileKeys.get(key);
    if (other !== undefined) {
      throw new Error(
        `"${other}" and "${path}" would be the same file on disk — nothing was imported.`,
      );
    }
    if (dirKeys.has(key)) {
      throw new Error(`"${path}" is both a file and a folder in the zip — nothing was imported.`);
    }
    if (entry.size > MAX_BUNDLE_FILE_BYTES) {
      throw new Error(
        `"${path}" is larger than ${String(MAX_BUNDLE_FILE_BYTES / 1_000_000)} MB — nothing was imported.`,
      );
    }
    fileKeys.set(key, path);
    total += entry.size;
    admit.set(entry.raw, { path, size: entry.size });
  }

  if (admit.size > MAX_BUNDLE_FILES) {
    throw new Error(
      `"${label}" holds more than ${String(MAX_BUNDLE_FILES)} files — nothing was imported.`,
    );
  }
  if (total > MAX_SKILL_ZIP_BYTES) {
    throw new Error(
      `"${label}" unpacks to more than ${String(MAX_SKILL_ZIP_BYTES / 1_000_000)} MB — nothing was imported.`,
    );
  }

  // A file where another entry needs a folder would surface as a raw ENOTDIR
  // naming the staging path; refused here, with a sentence, instead.
  for (const path of [...fileKeys.values(), ...contents.dirs]) {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const ancestor = parts.slice(0, depth).join('/');
      if (fileKeys.has(keyOf(ancestor))) {
        throw new Error(`"${ancestor}" is both a file and a folder in the zip — nothing was imported.`);
      }
    }
  }

  // Pass two: inflate only what was admitted, and hold each to its size.
  const inflated = unzipSync(data, { filter: (file) => admit.has(file.name) });
  for (const [raw, { path, size: declared }] of admit) {
    const bytes = inflated[raw] ?? new Uint8Array();
    if (bytes.length !== declared) {
      throw new Error(`"${path}" is not the size it declares — nothing was imported.`);
    }
    contents.files.push({
      path,
      bytes,
      from: null,
      // A zip carries no mode this reads, so the content decides — the rule
      // `writeFile` in `index.ts` applies to every file the pane writes.
      mode: bytes[0] === 0x23 && bytes[1] === 0x21 ? 0o755 : 0o644,
    });
  }
  return contents;
}

/** The central directory's names, methods and sizes. Inflates nothing. */
function listZip(data: Uint8Array): Listed[] {
  const listed: Listed[] = [];
  unzipSync(data, {
    filter: (file) => {
      listed.push({
        name: file.name,
        size: file.size,
        originalSize: file.originalSize,
        compression: file.compression,
      });
      return false;
    },
  });
  return listed;
}

/** Not Finder's resource-fork shadow, and not under a name the walk skips. */
function visible(name: string): boolean {
  if (name.startsWith('__MACOSX/')) return false;
  return !name.split('/').some((segment) => SKILL_SKIP_ENTRIES.includes(segment));
}

/**
 * How many folders deep the manifest sits: `0` at the zip's root, `1` under
 * its one top-level folder — the shape macOS "Compress" makes of a folder —
 * or `null` for neither.
 */
function manifestDepth(names: readonly string[]): 0 | 1 | null {
  const shown = names.filter(visible);
  const files = shown.filter((name) => !name.endsWith('/'));
  if (files.includes('SKILL.md')) return 0;
  const tops = new Set(shown.map((name) => name.split('/')[0]));
  const [top] = tops;
  return tops.size === 1 && files.includes(`${top ?? ''}/SKILL.md`) ? 1 : null;
}

function isZipName(path: string): boolean {
  return path.toLowerCase().endsWith('.zip');
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
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
 * to a staging folder beside `skills/` — same volume, so the last step is one
 * `rename` — never into `skills/` itself. A refusal at any point leaves
 * nothing behind: not a half-copied skill, and not a staging folder, which is
 * removed on every path out. Staging sits outside `skills/` because
 * `readUserSkills` lists every folder there, and a sync landing mid-import
 * would show the half-written one as an invalid row.
 *
 * ## A zip is read in memory, and its declared sizes are the bound
 *
 * Two passes over the central directory. The first inflates nothing and only
 * reads names and declared sizes, which is where every cap is enforced — so a
 * zip bomb is refused on what it *claims*, before any inflation. The second
 * inflates only the admitted entries, and `fflate` inflates each into a buffer
 * of exactly the declared size, so an entry that lies about its size cannot
 * grow past what the first pass admitted.
 */

/**
 * The largest zip read, and the most its entries may declare in total.
 *
 * ponytail: one ceiling for both, generous for a skill (text and a few
 * scripts); split it if skills start shipping large assets.
 */
export const MAX_SKILL_ZIP_BYTES = 100_000_000;

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

/** Is `source` a whole skill — a `.zip`, or a folder with `SKILL.md` at its root? */
export async function isSkillPackage(source: string): Promise<boolean> {
  const info = await lstat(source).catch(() => null);
  if (info === null || info.isSymbolicLink()) return false;
  if (info.isFile()) return source.toLowerCase().endsWith('.zip');
  if (!info.isDirectory()) return false;
  const manifest = await lstat(join(source, 'SKILL.md')).catch(() => null);
  return manifest?.isFile() ?? false;
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

  const staging = join(dirname(skillsRoot()), `.skill-import-${randomUUID()}`);
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
  if (!source.toLowerCase().endsWith('.zip')) {
    throw new Error(`"${label}" is not a zip or a folder — nothing was imported.`);
  }
  if (size > MAX_SKILL_ZIP_BYTES) {
    throw new Error(
      `"${label}" is larger than ${String(MAX_SKILL_ZIP_BYTES / 1_000_000)} MB — nothing was imported.`,
    );
  }

  const data = new Uint8Array(await readFile(source));

  // Pass one: names and declared sizes only. Nothing is inflated.
  const listed: { name: string; size: number }[] = [];
  try {
    unzipSync(data, {
      filter: (file) => {
        listed.push({ name: file.name, size: file.originalSize });
        return false;
      },
    });
  } catch {
    throw new Error(`"${label}" is not a readable zip — nothing was imported.`);
  }

  const kept: { raw: string; segments: string[]; dir: boolean; size: number }[] = [];
  for (const { name, size: declared } of listed) {
    if (name.startsWith('__MACOSX/')) continue;
    if (name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
      throw new Error(`"${name}" is not a path inside the zip — nothing was imported.`);
    }
    const dir = name.endsWith('/');
    const segments = (dir ? name.slice(0, -1) : name).split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`"${name}" is not a path inside the zip — nothing was imported.`);
    }
    // Skipped by name, and everything under it, as the tree walk skips it.
    if (segments.some((segment) => SKILL_SKIP_ENTRIES.includes(segment))) continue;
    kept.push({ raw: name, segments, dir, size: declared });
  }

  /*
    `SKILL.md` at the zip's root, or at the root of its one top-level folder —
    the second is what macOS "Compress" makes of a folder.
  */
  const isManifest = (segments: string[], depth: number): boolean =>
    segments.length === depth + 1 && segments[depth] === 'SKILL.md';
  const tops = new Set(kept.map((entry) => entry.segments[0]));
  let strip = 0;
  if (!kept.some((entry) => !entry.dir && isManifest(entry.segments, 0))) {
    const wrapped =
      tops.size === 1 && kept.some((entry) => !entry.dir && isManifest(entry.segments, 1));
    if (!wrapped) {
      throw new Error(`"${label}" has no SKILL.md at its root — nothing was imported.`);
    }
    strip = 1;
  }

  const contents: Contents = { files: [], dirs: [] };
  const admit = new Map<string, string>();
  let total = 0;

  for (const entry of kept) {
    const path = entry.segments.slice(strip).join('/');
    if (path === '') continue; // The wrapping folder itself.
    if (path.split('/').length > MAX_BUNDLE_DEPTH) {
      throw new Error(`"${path}" is too deep for a skill — nothing was imported.`);
    }
    if (entry.dir) {
      contents.dirs.push(path);
      continue;
    }
    if (entry.size > MAX_BUNDLE_FILE_BYTES) {
      throw new Error(
        `"${path}" is larger than ${String(MAX_BUNDLE_FILE_BYTES / 1_000_000)} MB — nothing was imported.`,
      );
    }
    total += entry.size;
    admit.set(entry.raw, path);
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
  const filePaths = new Set(admit.values());
  for (const path of [...filePaths, ...contents.dirs]) {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const ancestor = parts.slice(0, depth).join('/');
      if (filePaths.has(ancestor)) {
        throw new Error(`"${ancestor}" is both a file and a folder in the zip — nothing was imported.`);
      }
    }
  }

  // Pass two: inflate only what was admitted.
  const inflated = unzipSync(data, { filter: (file) => admit.has(file.name) });
  for (const [raw, path] of admit) {
    const bytes = inflated[raw] ?? new Uint8Array();
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

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

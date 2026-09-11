import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { AGENT_FILE, AGENTS_DIR } from '@shared/agent-contract';
import { RESERVED_SKILL_NAME } from '@shared/skills-contract';

/**
 * Seeding the skills and agents the app ships into `~/.hive` (HIVE-162).
 *
 * `~/.hive/skills` and `~/.hive/agents` are the **user's** folders: Settings
 * writes them, a text editor writes them, dotfiles back them up. The app
 * ships skills and agent definitions of its own (`resources/skills`,
 * `resources/agents`; the workflow lands there story by story), and they have
 * to land in those same folders — a session gets its skills from the generated plugin
 * that mirrors `~/.hive/skills`, and an agent is a file the registry watches
 * there. So the app writes into a folder it does not own, and the whole of
 * this module is the rule that makes that safe: **the user's edits win.**
 *
 * ## The four outcomes per file
 *
 * | The file on disk | The manifest | The seed does |
 * | --- | --- | --- |
 * | absent | no entry | copies it |
 * | absent | has an entry | leaves it absent: the user deleted it |
 * | byte-identical to what the last seed wrote | | overwrites it with the new shipped content |
 * | anything else | | leaves it alone |
 *
 * "What the last seed wrote" is a hash per file in `~/.hive/.seed.json`. It
 * is what tells an untouched copy from an edited one, and a deleted copy from
 * a never-seeded one: without it the rows are indistinguishable, and the
 * choice would be between clobbering edits on every update and never updating
 * at all. A deletion is an edit. Settings offers the button, and a folder that
 * came back on the next launch would make it a lie.
 *
 * A file the app used to ship and no longer does is **left alone**. Deleting
 * from a folder the user hand-edits, on the strength of a manifest, is a
 * class of mistake with no undo; a stale skill costs a slash command that
 * still works.
 *
 * ## What it refuses to write through
 *
 * Nothing under `<target>` is written through a symlink. The skills tree is
 * symlink-friendly by design (`read.ts` admits linked skill folders because
 * dotfile managers link them in), and a seed that followed a link would write
 * into whatever it points at, anywhere on disk. So every path component
 * between `<target>` and the file is `lstat`ed: a linked `skills/`, a linked
 * skill folder, or a linked folder inside one all stop the write. `<target>`
 * itself may be a link; relocating `~/.hive` whole is the user's business.
 *
 * A file's mode travels with it. `writeFile` creates at 0644, and a shipped
 * script that lands non-executable fails the first session that runs it, the
 * same failure `import-skill.ts` and `plugin.ts` each already guard against.
 *
 * `done` is never seeded: it is generated into the plugin directly and is
 * reserved in `~/.hive/skills` (`RESERVED_SKILL_NAME`).
 */

export interface SeedReport {
  /** Files written because nothing was there. */
  created: string[];
  /** Files overwritten because the user's copy matched the last seed. */
  upgraded: string[];
  /** Files left as they were: edited by the user, or already current. */
  kept: string[];
  /** Folders skipped whole because the destination was a symlink. */
  skipped: string[];
}

interface Manifest {
  files: Record<string, string>;
}

export interface SeedOptions {
  /** The shipped tree: `<source>/skills/<name>/…` and `<source>/agents/<name>/AGENT.md`. */
  source: string;
  /** `~/.hive`, the folder that holds `skills/` and `agents/`. */
  target: string;
  /** The manifest path, normally `<target>/.seed.json`. */
  manifestFile: string;
}

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

async function readManifest(file: string): Promise<Manifest> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Manifest).files === 'object' &&
      (parsed as Manifest).files !== null
    ) {
      const files: Record<string, string> = {};
      for (const [key, value] of Object.entries((parsed as Manifest).files)) {
        if (typeof value === 'string') files[key] = value;
      }
      return { files };
    }
  } catch {
    // Missing or malformed: the first seed on this machine, or a hand-edit.
    // Either way every existing file reads as the user's, which is the safe
    // reading.
  }
  return { files: {} };
}

/** Every file under `dir`, as paths relative to it, in name order. */
async function walk(dir: string, rel = ''): Promise<string[]> {
  let listing;
  try {
    listing = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of [...listing].sort((a, b) => a.name.localeCompare(b.name))) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await walk(join(dir, entry.name), path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
    // Symlinks in the shipped tree are not shipped. The tree is the app's own
    // and holds none; the rule is here so that a stray one can never become
    // a write through a link on the user's side.
  }
  return files;
}

const isSymlink = async (path: string): Promise<boolean> => {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Whether any component of `rel`, taken from `root` downwards, is a symlink.
 *
 * `lstat` answers for the last component only and follows every parent, so
 * a check on the leaf alone writes through a linked `skills/` or a linked
 * folder inside a skill. Walking the components is what makes "never through
 * a link" true rather than one level deep.
 */
async function throughLink(root: string, rel: string): Promise<boolean> {
  let path = root;
  for (const segment of rel.split('/')) {
    path = join(path, segment);
    if (await isSymlink(path)) return true;
  }
  return false;
}

/**
 * The folders the seed would write, each as `<kind>/<name>`.
 *
 * Agents are one file each and skills are a folder each, but the seed treats
 * both as a folder: it is the folder that may be a symlink, and it is the
 * folder that a person recognises as "the thing I edited".
 */
async function shippedFolders(source: string): Promise<string[]> {
  const folders: string[] = [];
  for (const kind of ['skills', AGENTS_DIR]) {
    let names: string[];
    try {
      names = (await readdir(join(source, kind), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      continue;
    }
    for (const name of names) {
      if (kind === 'skills' && name === RESERVED_SKILL_NAME) continue;
      folders.push(`${kind}/${name}`);
    }
  }
  return folders;
}

export async function seedShipped(options: SeedOptions): Promise<SeedReport> {
  const report: SeedReport = { created: [], upgraded: [], kept: [], skipped: [] };
  const manifest = await readManifest(options.manifestFile);
  const next: Record<string, string> = { ...manifest.files };

  for (const folder of await shippedFolders(options.source)) {
    const destinationDir = join(options.target, folder);
    if (await throughLink(options.target, folder)) {
      report.skipped.push(folder);
      continue;
    }

    const files = await walk(join(options.source, folder));
    // An agent folder ships exactly its definition; anything else beside it in
    // `resources/` is a mistake in the repository, not something to copy.
    const shipped = folder.startsWith(`${AGENTS_DIR}/`)
      ? files.filter((file) => file === AGENT_FILE)
      : files;

    for (const file of shipped) {
      const rel = `${folder}/${file}`;
      const from = join(options.source, folder, file);
      const to = join(destinationDir, file);
      const bytes = await readFile(from);
      const shippedHash = sha256(bytes);
      const mode = (await stat(from)).mode & 0o777;

      // The file's own parents inside the skill, plus the file itself. The
      // folder's own components were checked once above.
      if (await throughLink(destinationDir, file)) {
        report.kept.push(rel);
        continue;
      }

      let existing: Uint8Array | null;
      try {
        existing = await readFile(to);
      } catch {
        existing = null;
      }

      if (existing === null) {
        if (rel in manifest.files) {
          // Seeded once, gone now. The user deleted it, and that is theirs.
          report.kept.push(rel);
          continue;
        }
        await mkdir(dirname(to), { recursive: true });
        await writeFile(to, bytes);
        await chmod(to, mode);
        next[rel] = shippedHash;
        report.created.push(rel);
        continue;
      }

      const existingHash = sha256(existing);
      if (existingHash === shippedHash) {
        next[rel] = shippedHash;
        report.kept.push(rel);
        continue;
      }

      if (manifest.files[rel] === existingHash) {
        await writeFile(to, bytes);
        await chmod(to, mode);
        next[rel] = shippedHash;
        report.upgraded.push(rel);
        continue;
      }

      // Edited by the user since the last seed, or present before the first
      // one. Theirs. The manifest keeps whatever it held, so a later revert
      // to the seeded bytes reads as untouched again.
      report.kept.push(rel);
    }
  }

  await mkdir(dirname(options.manifestFile), { recursive: true });
  await writeFile(
    options.manifestFile,
    `${JSON.stringify({ files: next }, null, 2)}\n`,
    'utf8',
  );

  return report;
}

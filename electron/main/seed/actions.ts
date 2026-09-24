import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { AGENT_FILE, AGENTS_DIR } from '@shared/agent-contract';
import type {
  ShippedRequest,
  ShippedStatus,
} from '@shared/shipped-contract';

import { legacyBase, readHistory } from './history';
import {
  alignShapes,
  baseOf,
  hashPart,
  mergeParts,
  parseParts,
  type MergeResult,
  type PartBase,
} from './merge';
import {
  readManifest,
  shippedFolders,
  throughLink,
  walk,
  writeManifest,
  type Manifest,
  type SeedOptions,
} from './seed';

/**
 * What Settings reads about a shipped agent or skill the user changed, and
 * what it can do about it.
 *
 * The status is the seed's own merge run dry against the file as it is now,
 * with the base the manifest holds, so a flag the seed raised (a held prompt,
 * a key whose shipped value moved) reads the same here until it is resolved.
 * Each action writes the file and the manifest, and answers with the fresh
 * status list. Nothing here writes through a symlink, for `seed.ts`'s reason.
 */

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const definitionOf = (folder: string): string =>
  folder.startsWith(`${AGENTS_DIR}/`) ? AGENT_FILE : 'SKILL.md';

const readText = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
};

interface Located {
  rel: string;
  shipped: string;
  current: string;
  base: PartBase | null;
  merge: MergeResult;
}

/** The definition file of one shipped folder, merged dry, or `null` when there is nothing to report. */
async function locate(
  options: SeedOptions,
  folder: string,
  manifest: Manifest,
  history: () => Promise<Parameters<typeof legacyBase>[3]>,
): Promise<Located | null> {
  if (await throughLink(options.target, folder)) return null;
  // A linked definition file is one the seed keeps and never merges.
  if (await throughLink(join(options.target, folder), definitionOf(folder))) return null;

  const rel = `${folder}/${definitionOf(folder)}`;
  const shipped = await readText(join(options.source, rel));
  const current = await readText(join(options.target, rel));

  if (shipped === null || current === null) return null;
  if (parseParts(shipped) === null || parseParts(current) === null) return null;

  const base = manifest.parts[rel] ?? legacyBase(rel, current, manifest.files[rel], await history());
  const merge = mergeParts(current, shipped, base);

  /*
    With no base the seed leaves the file alone as the user's and raises no
    flag, so neither does the status: nothing is known to have moved.
  */
  return {
    rel,
    shipped,
    current,
    base,
    merge: base === null ? { ...merge, moved: [], held: false } : merge,
  };
}

const historyLoader = (options: SeedOptions) => {
  let loaded: Promise<Parameters<typeof legacyBase>[3]> | null = null;

  return () => (loaded ??= options.history === undefined ? Promise.resolve({}) : readHistory(options.history));
};

/** Every shipped folder's other files that differ from the shipped copy. */
async function editedFiles(options: SeedOptions, folder: string): Promise<string[]> {
  if (folder.startsWith(`${AGENTS_DIR}/`)) return [];

  const edited: string[] = [];

  for (const file of await walk(join(options.source, folder))) {
    if (file === 'SKILL.md') continue;

    const current = await readText(join(options.target, folder, file));
    const shipped = await readText(join(options.source, folder, file));

    if (current !== null && current !== shipped) edited.push(file);
  }

  return edited;
}

export async function shippedStatus(options: SeedOptions): Promise<ShippedStatus[]> {
  const manifest = await readManifest(options.manifestFile);
  const history = historyLoader(options);
  const statuses: ShippedStatus[] = [];

  for (const folder of await shippedFolders(options.source)) {
    const located = await locate(options, folder, manifest, history);

    if (located === null) continue;

    const [kind, name] = folder.split('/') as [ShippedStatus['kind'], string];
    const { merge } = located;

    statuses.push({
      kind,
      name,
      customised: merge.customised,
      moved: merge.moved,
      files: await editedFiles(options, folder),
      bodyEdited: merge.bodyEdited,
      held: merge.held,
      shippedBody: parseParts(located.shipped)?.body ?? '',
    });
  }

  return statuses;
}

/**
 * One write at a time. Every action reads `.seed.json`, changes one entry and
 * writes it back, so two at once (this window and a paired device) would
 * each write a manifest missing the other's change.
 */
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);

  queue = next.catch(() => undefined);

  return next;
}

/** The folder a request names, refused unless the app ships it and it is not a link. */
async function shippedFolder(options: SeedOptions, request: ShippedRequest): Promise<string> {
  const folder = `${request.kind}/${request.name}`;

  if (!(await shippedFolders(options.source)).includes(folder)) {
    throw new Error(`The Hive does not ship ${folder}.`);
  }
  if (await throughLink(options.target, folder)) {
    throw new Error(`${folder} is a symlink in ~/.hive; The Hive does not write through it.`);
  }

  return folder;
}

async function writeKeepingMode(from: string, to: string, text: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, text, 'utf8');
  await chmod(to, (await stat(from)).mode & 0o777);
}

/** Replace the folder's shipped files with the shipped copies; extra files stay. */
async function resetShippedNow(
  options: SeedOptions,
  request: ShippedRequest,
): Promise<ShippedStatus[]> {
  const folder = await shippedFolder(options, request);
  const manifest = await readManifest(options.manifestFile);
  const definition = definitionOf(folder);
  const files = folder.startsWith(`${AGENTS_DIR}/`)
    ? [definition]
    : await walk(join(options.source, folder));

  for (const file of files) {
    const rel = `${folder}/${file}`;

    if (await throughLink(join(options.target, folder), file)) continue;

    const from = join(options.source, rel);
    const text = await readFile(from, 'utf8');

    await writeKeepingMode(from, join(options.target, rel), text);
    manifest.files[rel] = sha256(text);
    if (file === definition) manifest.parts[rel] = baseOf(text);
  }

  await writeManifest(options.manifestFile, manifest);

  return shippedStatus(options);
}

/** Put the shipped body under the user's frontmatter. */
async function takeShippedPromptNow(
  options: SeedOptions,
  request: ShippedRequest,
): Promise<ShippedStatus[]> {
  const folder = await shippedFolder(options, request);
  const manifest = await readManifest(options.manifestFile);
  const located = await locate(options, folder, manifest, historyLoader(options));

  if (located === null) return shippedStatus(options);

  const lines = located.current.split('\n');
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  const text = `${lines.slice(0, close + 1).join('\n')}\n${parseParts(located.shipped)?.body ?? ''}`;

  await writeKeepingMode(join(options.source, located.rel), join(options.target, located.rel), text);
  manifest.parts[located.rel] = mergeParts(text, located.shipped, located.base).base;
  await writeManifest(options.manifestFile, manifest);

  return shippedStatus(options);
}

/**
 * Keep the user's version and stop flagging it: every moved key's base and a
 * held body's base become the shipped value, so nothing is flagged until the
 * shipped value moves again. The file itself is not touched.
 */
async function keepMineNow(
  options: SeedOptions,
  request: ShippedRequest,
): Promise<ShippedStatus[]> {
  const folder = await shippedFolder(options, request);
  const manifest = await readManifest(options.manifestFile);
  const located = await locate(options, folder, manifest, historyLoader(options));

  if (located === null) return shippedStatus(options);

  const shipped = alignShapes(located.current, located.shipped).ship;
  const next: PartBase = {
    keys: { ...located.merge.base.keys },
    body: located.merge.base.body,
  };

  for (const path of located.merge.moved) {
    const part = shipped.parts.get(path);

    if (part === undefined) delete next.keys[path];
    else next.keys[path] = hashPart(part);
  }
  if (located.merge.held) next.body = hashPart(shipped.body);

  manifest.parts[located.rel] = next;
  await writeManifest(options.manifestFile, manifest);

  return shippedStatus(options);
}

export const resetShipped = (options: SeedOptions, request: ShippedRequest): Promise<ShippedStatus[]> =>
  serial(() => resetShippedNow(options, request));

export const takeShippedPrompt = (options: SeedOptions, request: ShippedRequest): Promise<ShippedStatus[]> =>
  serial(() => takeShippedPromptNow(options, request));

export const keepMine = (options: SeedOptions, request: ShippedRequest): Promise<ShippedStatus[]> =>
  serial(() => keepMineNow(options, request));

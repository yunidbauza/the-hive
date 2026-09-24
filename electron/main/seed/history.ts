import { readFile } from 'node:fs/promises';

import { hashPart, ownKey, parseParts, type PartBase } from './merge';

/**
 * Every version the app has shipped of each AGENT.md and SKILL.md, as part
 * hashes: `resources/shipped-history.json`, written by `pnpm seed:history`.
 *
 * It exists for one case: a `~/.hive` seeded before the manifest recorded
 * parts. Such a file has a whole-file hash at best, and the agents that
 * predate the manifest have nothing, so the seed cannot tell an edit from an
 * old shipped value. The history can.
 */
export type History = Record<
  string,
  { file: string; keys: Record<string, string>; body: string }[]
>;

type Version = History[string][number];

const isVersion = (value: unknown): value is Version =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Version).file === 'string' &&
  typeof (value as Version).body === 'string' &&
  typeof (value as Version).keys === 'object' &&
  (value as Version).keys !== null;

/** The index, or `{}` when it is missing or unreadable: no legacy bases. A malformed version is dropped. */
export async function readHistory(path: string): Promise<History> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).map(([rel, versions]) => [
        rel,
        Array.isArray(versions) ? versions.filter(isVersion) : [],
      ]),
    );
  } catch {
    return {};
  }
}

/**
 * A base for a file the manifest has no parts for.
 *
 * The version the v1 manifest's whole-file hash names, when there is one;
 * otherwise the version agreeing with the file on the most parts, the latest
 * on a tie. Its keys are what makes a missing key read as *deleted* rather
 * than *new*. Then any part whose value matches some shipped version of that
 * part counts as untouched, since an old shipped value is not an edit.
 */
export function legacyBase(
  rel: string,
  current: string,
  v1Hash: string | undefined,
  history: History,
): PartBase | null {
  const versions = history[rel];
  const parsed = parseParts(current);

  if (versions === undefined || versions.length === 0 || parsed === null) return null;

  const hashes = new Map([...parsed.parts].map(([path, part]) => [path, hashPart(part)]));
  const body = hashPart(parsed.body);
  const score = (version: (typeof versions)[number]): number =>
    [...hashes].filter(([path, hash]) => ownKey(version.keys, path) === hash).length +
    (version.body === body ? 1 : 0);

  const named = versions.find((version) => version.file === v1Hash);
  const picked =
    named ??
    versions.reduce((best, version) => (score(version) >= score(best) ? version : best));

  const base: PartBase = { keys: { ...picked.keys }, body: picked.body };

  for (const [path, hash] of hashes) {
    if (versions.some((version) => ownKey(version.keys, path) === hash)) base.keys[path] = hash;
  }
  if (versions.some((version) => version.body === body)) base.body = body;

  return base;
}

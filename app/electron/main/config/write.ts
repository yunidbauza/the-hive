import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  CONFIG_VERSION,
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_SHELL,
  emptySnapshot,
  type ConfigSnapshot,
} from '@shared/config-contract';

import { parseConfig } from './parse';
import { configPath, describe } from './paths';
import { resolveProjects } from './resolve';

/**
 * The single write path for the workspace config (story 101).
 *
 * Every mutation goes through here; there is no per-field patch. The ordering
 * is the whole design:
 *
 * 1. **Re-read from disk**, never the cached snapshot — the user may have
 *    edited the file in an editor since the app loaded, and writing the cache
 *    back would silently discard that.
 * 2. **Apply the mutation in memory.**
 * 3. **Validate the whole result with the read path's own parser.** Two
 *    validators is one validator and one bug. A write that would produce a
 *    file the reader rejects is refused *before* anything touches disk.
 * 4. **Write atomically** — a temp file in the same directory, then `rename`.
 *    A half-written config is the one failure that would make the app
 *    unlaunchable, and `rename` is the only cheap way to make it impossible.
 *    Same directory because `rename` is only atomic within a filesystem.
 * 5. **Return the fresh snapshot**, so the renderer never follows a write with
 *    a reload and can never render a stale list.
 *
 * Nothing here throws at the user's data. On any failure the old file is still
 * on disk, still valid, and the reason comes back in `errors` — consistent
 * with story 090's rule for the read path.
 */

const LABEL = 'config';

/**
 * The config document as JSON parsed it — comments and unknown keys included.
 *
 * Deliberately not `ConfigFile`-with-known-fields: the point of mutating the
 * *parsed document* rather than rebuilding it from the snapshot is that keys
 * this build has never heard of survive the round trip.
 */
export type ConfigDocument = Record<string, unknown>;

export type Mutation = (draft: ConfigDocument) => ConfigDocument;

function failed(path: string, message: string): ConfigSnapshot {
  const snapshot = emptySnapshot(path);
  snapshot.errors.push(message);
  return snapshot;
}

export function writeConfig(mutate: Mutation): ConfigSnapshot {
  const path = configPath();

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    // Includes ENOENT. A file that is not there cannot be safely rewritten from
    // a mutation whose base was never seen; the caller reloads and retries.
    return failed(
      path,
      `${LABEL}: could not read ${path} (${describe(cause)}) — nothing was written`,
    );
  }

  const current = parseConfig(text, LABEL);
  if (current.fatal) {
    // The file on disk is one this build does not understand. Rewriting it
    // would destroy content we could not read. Note this tests `fatal`, not
    // `errors.length`: an unknown top-level key is advisory, and a config
    // carrying one is exactly the config this story promises to preserve.
    return failed(
      path,
      `${LABEL}: ${path} could not be read (${current.errors[0] ?? 'unknown reason'}) — nothing was written`,
    );
  }

  let document: ConfigDocument;
  try {
    document = JSON.parse(text) as ConfigDocument;
  } catch (cause) {
    return failed(
      path,
      `${LABEL}: could not parse ${path} (${describe(cause)}) — nothing was written`,
    );
  }

  // The version emitted is always current: a v1 file becomes v2 on the first
  // save, which is the only moment a migration is not a surprise.
  const next: ConfigDocument = { ...mutate(document), version: CONFIG_VERSION };

  // Key order survives because `JSON.stringify` walks own string keys in
  // insertion order and the spread preserves the parsed document's order —
  // comments and unknown keys included. Keys not already present land at the
  // end, which is where a reader would expect something new.
  const serialised = `${JSON.stringify(next, null, 2)}\n`;

  const validated = parseConfig(serialised, LABEL);
  if (validated.fatal) {
    return failed(
      path,
      `${LABEL}: refusing to write a file this build could not read back (${validated.errors[0] ?? 'unknown reason'})`,
    );
  }

  const temp = join(dirname(path), `config.json.${process.pid}.tmp`);
  try {
    writeFileSync(temp, serialised, 'utf8');
    renameSync(temp, path);
  } catch (cause) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may never have been created — `writeFileSync` is the
      // more likely of the two to fail. Nothing to clean up, and reporting a
      // cleanup failure here would bury the cause the user can act on.
    }
    return failed(
      path,
      `${LABEL}: could not write ${path} (${describe(cause)}) — the previous config is unchanged`,
    );
  }

  const projects = resolveProjects(validated.projects, validated.errors);

  return {
    configPath: path,
    templateWritten: false,
    shell: validated.shell ?? DEFAULT_SHELL,
    claudeCommand: validated.claudeCommand ?? DEFAULT_CLAUDE_COMMAND,
    projects,
    errors: validated.errors,
  };
}

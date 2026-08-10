import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  CONFIG_VERSION,
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_JIRA,
  DEFAULT_SHELL,
  type ConfigSnapshot,
} from '@shared/config-contract';
import { resolveNotificationPrefs } from '@shared/notification-contract';

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

/**
 * Thrown by a mutation that has decided not to write.
 *
 * A mutation runs against the document **just read from disk**, which is the
 * only view that is not stale — the config is deliberately not watched, so the
 * cached snapshot can be older than the file. Checks that must see the current
 * file (a duplicate path, a colliding id) therefore belong inside the mutation,
 * and they need a way to abandon the write from in there. `writeConfig` turns
 * this into an ordinary `{ ok: false }`; it never escapes.
 */
export class WriteRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'WriteRefused';
  }
}

/**
 * Whether the write happened, said explicitly.
 *
 * Deliberately **not** "a `ConfigSnapshot` whose `errors` are non-empty". The
 * caller's job is to decide whether to install the result as the cache, and
 * that decision cannot be inferred from the snapshot: a *successful* write can
 * legitimately produce zero projects and a non-empty `errors` — remove the last
 * project from a file that also carries an unknown top-level key — which is
 * indistinguishable, by shape alone, from a failure. Caching a failure would
 * drop every project from main's view without anything on disk changing.
 */
export type WriteResult =
  | { ok: true; snapshot: ConfigSnapshot }
  | { ok: false; reason: string };

const failed = (message: string): WriteResult => ({ ok: false, reason: message });

export function writeConfig(mutate: Mutation): WriteResult {
  const path = configPath();

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    // Includes ENOENT. A file that is not there cannot be safely rewritten from
    // a mutation whose base was never seen; the caller reloads and retries.
    return failed(
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
      `${LABEL}: ${path} could not be read (${current.errors[0] ?? 'unknown reason'}) — nothing was written`,
    );
  }

  let document: ConfigDocument;
  try {
    document = JSON.parse(text) as ConfigDocument;
  } catch (cause) {
    return failed(
      `${LABEL}: could not parse ${path} (${describe(cause)}) — nothing was written`,
    );
  }

  let next: ConfigDocument;
  try {
    // The version emitted is always current: a v1 file becomes v2 on the first
    // save, which is the only moment a migration is not a surprise.
    next = { ...mutate(document), version: CONFIG_VERSION };
  } catch (cause) {
    if (cause instanceof WriteRefused) return failed(`${LABEL}: ${cause.message}`);
    throw cause;
  }

  // Key order survives because `JSON.stringify` walks own string keys in
  // insertion order and the spread preserves the parsed document's order —
  // comments and unknown keys included. Keys not already present land at the
  // end, which is where a reader would expect something new.
  const serialised = `${JSON.stringify(next, null, 2)}\n`;

  const validated = parseConfig(serialised, LABEL);
  if (validated.fatal) {
    return failed(
      `${LABEL}: refusing to write a file this build could not read back (${validated.errors[0] ?? 'unknown reason'})`,
    );
  }

  /**
   * Write beside the **link target**, not the link.
   *
   * `rename` replaces whatever is at the destination, so renaming over a
   * symlink would delete the link and leave a regular file. A config symlinked
   * into a dotfiles repo is a case this code deliberately supports — it is why
   * `addProject` stores paths untilde'd — and losing the link on the first save
   * from Settings would be a silent, surprising break.
   *
   * `realpathSync` also keeps the temp file on the same filesystem as the real
   * target, which is what makes the rename atomic in the first place.
   */
  let target = path;
  try {
    target = realpathSync(path);
  } catch {
    // The file was there a moment ago (it was read above). If it has gone since,
    // the rename below fails and is reported like any other write failure.
  }

  const temp = join(dirname(target), `config.json.${process.pid}.tmp`);
  try {
    /**
     * Written through a file descriptor so it can be `fsync`ed before the
     * rename. `rename` alone makes the swap atomic *for a reader*, which
     * defeats a torn file — but the new contents may still be in the page cache
     * when the machine loses power, and the rename can land without them.
     */
    const fd = openSync(temp, 'w');
    try {
      writeSync(fd, serialised, null, 'utf8');
      fsyncSync(fd);
      // Preserve the mode the user chose. Without this a `chmod 600` config
      // silently widens to the default on the first save from Settings.
      try {
        chmodSync(temp, statSync(target).mode & 0o777);
      } catch {
        // No existing file to copy a mode from; the default is correct.
      }
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  } catch (cause) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may never have been created — `writeFileSync` is the
      // more likely of the two to fail. Nothing to clean up, and reporting a
      // cleanup failure here would bury the cause the user can act on.
    }
    return failed(
      `${LABEL}: could not write ${path} (${describe(cause)}) — the previous config is unchanged`,
    );
  }

  const projects = resolveProjects(validated.projects, validated.errors);

  return {
    ok: true,
    snapshot: {
      configPath: path,
      templateWritten: false,
      shell: validated.shell ?? DEFAULT_SHELL,
      claudeCommand: validated.claudeCommand ?? DEFAULT_CLAUDE_COMMAND,
      projects,
      // Re-resolved from the document that was just written, not carried over
      // from the caller's request: the snapshot every mutating verb returns has
      // to describe the file on disk, including a block a concurrent hand-edit
      // changed (story 106).
      /**
       * Resolved, not spread (HIVE-75).
       *
       * `validated.notifications` deliberately still carries the **raw legacy
       * booleans** — `parse.ts` passes them through unmigrated so that
       * `resolveNotificationPrefs` can read them — so a plain spread leaves
       * `sessionDone` sitting untranslated in an object typed as fully
       * resolved, and every registered kind falls back to its registry default.
       *
       * The bug that caused: a user who had turned session-finish notifications
       * off booted correctly with them off (that path goes through
       * `loadConfig`), then changed *any* unrelated setting — added a project,
       * set the Jira site, moved a different switch — and this snapshot became
       * the cache. Their toasts came back on, and the pane showed
       * "Inbox + desktop" selected.
       */
      notifications: resolveNotificationPrefs(validated.notifications),
      jira: { ...DEFAULT_JIRA, ...validated.jira },
      errors: validated.errors,
    },
  };
}

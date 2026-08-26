import { watch, type FSWatcher } from 'node:fs';
import { sep } from 'node:path';

import type { FsChangedEvent } from '@shared/fs-contract';
import { HIDDEN_ENTRIES } from '@shared/fs-contract';

import { rootFor } from './paths';

/**
 * One recursive watcher, for the project the explorer is currently showing.
 *
 * ## Why exactly one
 *
 * The explorer roots at the active session's project and shows one at a time.
 * A watcher per visited project would be a file-descriptor leak with a long
 * fuse: it grows with navigation, never shrinks, and on macOS each one holds an
 * `FSEvents` stream over a whole repository tree. `watchProject` therefore
 * *replaces* rather than adds, which is also why `unwatch` needs no argument —
 * there is only ever one thing to stop.
 *
 * ## Why the filter is here and not in the renderer
 *
 * A `pnpm install` rewrites tens of thousands of paths under `node_modules`.
 * Filtering in the renderer means every one of them is serialised, crosses the
 * bridge, and is discarded — a burst that would stall the UI thread of an app
 * whose entire premise is a responsive terminal. So the hidden list is applied
 * before anything is emitted.
 *
 * ## Why debounced, and why trailing
 *
 * A single `git checkout` produces a change event per file. The tree re-reads
 * its expanded directories on each flush, so a flush per file would be hundreds
 * of `readdir` calls for one logical event. Trailing rather than leading:
 * firing on the first event of a burst would report the state *before* most of
 * the burst had happened, which is the one thing the flush exists to avoid.
 */

const DEBOUNCE_MS = 300;

/**
 * The longest a burst may postpone a flush.
 *
 * A plain trailing debounce resets on every event, so a sustained write stream
 * at under 300ms intervals — a long build, a big checkout, a watch-mode
 * compiler — would never flush at all, and the tree would sit stale for as long
 * as the agent kept working. That is precisely the moment the user is watching.
 */
const MAX_DEBOUNCE_MS = 2_000;

/**
 * Recursive watching is native on macOS and Windows, and available on Linux
 * from Node 20. The app ships Electron 43 (Node 22), so there is no fallback
 * path here and no polling — if this ever needs one, it needs a design, not a
 * `setInterval`.
 */
interface ActiveWatch {
  projectId: string;
  watcher: FSWatcher;
  pending: Set<string>;
  timer: NodeJS.Timeout | null;
  /** When the current burst began, so it cannot be postponed indefinitely. */
  burstStartedAt: number | null;
}

export interface FsWatchLayer {
  watchProject(projectId: string, sessionId?: string): Promise<void>;
  unwatch(): void;
  dispose(): void;
}

/** Whether any segment of a relative path is a hidden entry. */
function isHiddenPath(relPath: string): boolean {
  return relPath
    .split(sep)
    .some((segment) => HIDDEN_ENTRIES.includes(segment));
}

export function createFsWatchLayer(
  emit: (event: FsChangedEvent) => void,
): FsWatchLayer {
  let active: ActiveWatch | null = null;
  /** Monotonic request id, so an out-of-order `watchProject` cannot install. */
  let requested = 0;

  const stop = (): void => {
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    active.watcher.close();
    active = null;
  };

  const flush = (): void => {
    if (!active) return;
    active.timer = null;
    active.burstStartedAt = null;
    if (active.pending.size === 0) return;

    const paths = [...active.pending];
    active.pending.clear();
    emit({ projectId: active.projectId, paths });
  };

  return {
    async watchProject(projectId, sessionId) {
      /**
       * Resolved through the same guard every read goes through, so "watch" is
       * not a second, weaker way to name a directory. An unknown or unusable
       * project throws here exactly as it would on a read.
       */
      const generation = ++requested;
      // `rootFor`, not `projectRoot`: a session working in a worktree outside
      // the project is watched where it actually is, or the tree the panel
      // shows would never refresh while the one it does not would.
      const root = await rootFor(projectId, sessionId);

      /**
       * Two `fs:watch` calls in flight — a fast session switch across projects
       * — can settle out of order, and the loser would then `stop()` the winner
       * and install itself, leaving the *visible* project unwatched. The
       * generation counter is taken before the await and checked after it, so
       * only the most recent request may install.
       */
      if (generation !== requested) return;

      stop();

      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!active || filename === null) return;
        const relPath = filename.toString();
        if (relPath === '' || isHiddenPath(relPath)) return;

        active.pending.add(relPath);
        active.burstStartedAt ??= Date.now();

        // Postpone, but never past the burst ceiling — see MAX_DEBOUNCE_MS.
        const elapsed = Date.now() - active.burstStartedAt;
        const wait = Math.max(0, Math.min(DEBOUNCE_MS, MAX_DEBOUNCE_MS - elapsed));

        if (active.timer) clearTimeout(active.timer);
        active.timer = setTimeout(flush, wait);
      });

      /**
       * A watcher that errors — the directory was deleted or unmounted — is
       * closed rather than left in place. There is nothing useful to tell the
       * renderer: the tree's next read will fail with the real reason, which is
       * a better message than "the watcher broke".
       *
       * Guarded on identity: a late error from a watcher that has already been
       * replaced must not stop its successor.
       */
      watcher.on('error', () => {
        if (active?.watcher !== watcher) return;
        stop();
      });

      active = {
        projectId,
        watcher,
        pending: new Set(),
        timer: null,
        burstStartedAt: null,
      };
    },

    unwatch: stop,
    dispose: stop,
  };
}

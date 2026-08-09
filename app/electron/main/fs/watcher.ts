import { watch, type FSWatcher } from 'node:fs';
import { sep } from 'node:path';

import type { FsChangedEvent } from '@shared/fs-contract';
import { HIDDEN_ENTRIES } from '@shared/fs-contract';

import { projectRoot } from './paths';

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
}

export interface FsWatchLayer {
  watchProject(projectId: string): Promise<void>;
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

  const stop = (): void => {
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    active.watcher.close();
    active = null;
  };

  const flush = (): void => {
    if (!active) return;
    active.timer = null;
    if (active.pending.size === 0) return;

    const paths = [...active.pending];
    active.pending.clear();
    emit({ projectId: active.projectId, paths });
  };

  return {
    async watchProject(projectId) {
      /**
       * Resolved through the same guard every read goes through, so "watch" is
       * not a second, weaker way to name a directory. An unknown or unusable
       * project throws here exactly as it would on a read.
       */
      const root = await projectRoot(projectId);

      stop();

      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!active || filename === null) return;
        const relPath = filename.toString();
        if (relPath === '' || isHiddenPath(relPath)) return;

        active.pending.add(relPath);
        if (active.timer) clearTimeout(active.timer);
        active.timer = setTimeout(flush, DEBOUNCE_MS);
      });

      /**
       * A watcher that errors — the directory was deleted or unmounted — is
       * closed rather than left in place. There is nothing useful to tell the
       * renderer: the tree's next read will fail with the real reason, which is
       * a better message than "the watcher broke".
       */
      watcher.on('error', () => {
        stop();
      });

      active = { projectId, watcher, pending: new Set(), timer: null };
    },

    unwatch: stop,
    dispose: stop,
  };
}

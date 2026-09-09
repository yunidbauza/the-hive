import { watch, type FSWatcher } from 'node:fs';
import { sep } from 'node:path';

import type { FsChangedEvent } from '@shared/fs-contract';
import { HIDDEN_ENTRIES } from '@shared/fs-contract';

import type { SurfaceId } from '../ipc/surfaces';

import { rootFor } from './paths';

/**
 * One recursive watcher per surface, for the project that surface's explorer is
 * currently showing.
 *
 * ## Why one *per surface*, and still only one within it
 *
 * The explorer roots at the active session's project and shows one at a time,
 * so `watchProject` **replaces** rather than adds *for a given surface*. A
 * watcher per visited project would be a file-descriptor leak with a long fuse:
 * it grows with navigation, never shrinks, and on macOS each one holds an
 * `FSEvents` stream over a whole repository tree.
 *
 * That argument bounds navigation, not devices. Since HIVE-145 two clients can
 * be attached at once, and there was exactly one slot: client B's `fs:watch`
 * silently stole client A's watcher, and A's explorer stopped refreshing with
 * nothing on screen to say so. Surfaces are bounded by how many devices are
 * attached — two, three — where navigation is unbounded, so a watcher each is
 * a different question with a different answer.
 *
 * ## Why not one watcher per resolved root, shared
 *
 * It looks like free savings: the raw `fs.watch` stream for a root is identical
 * whoever is listening. It is not, because this module is not a raw event
 * source. It owns a pending set, a debounce timer and a burst ceiling, so a
 * shared watcher shares one debounce clock — surface A's burst would extend
 * surface B's wait, and both would flush on a cadence neither asked for. The
 * lifetimes couple too, and "the same project" is not even reliably the same
 * tree: {@link rootFor} resolves a session working in a worktree somewhere else
 * entirely.
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
  watchProject(surfaceId: SurfaceId, projectId: string, sessionId?: string): Promise<void>;
  /** That surface stopped watching. Every other surface's watcher stays. */
  unwatch(surfaceId: SurfaceId): void;
  /**
   * That surface went away. Identical to {@link unwatch} in effect, and named
   * for the caller: `surfaces.onGone`, the single release point.
   */
  release(surfaceId: SurfaceId): void;
  /** Every watcher, on teardown. */
  dispose(): void;
}

/** Whether any segment of a relative path is a hidden entry. */
function isHiddenPath(relPath: string): boolean {
  return relPath
    .split(sep)
    .some((segment) => HIDDEN_ENTRIES.includes(segment));
}

export function createFsWatchLayer(
  /**
   * Targeted at the surface that asked (HIVE-145), never broadcast: an
   * explorer must not react to a tree it is not showing, and with two clients
   * on different projects a broadcast would send each of them the other's
   * churn.
   */
  emit: (surfaceId: SurfaceId, event: FsChangedEvent) => void,
): FsWatchLayer {
  const watches = new Map<SurfaceId, ActiveWatch>();
  /**
   * The newest request each surface has made, recorded **before** its `rootFor`
   * await so a slower earlier call can see that it lost and decline to install.
   * Kept beside `watches` rather than on `ActiveWatch`, because the losing call
   * may find no `ActiveWatch` at all — the first two `fs:watch` calls a surface
   * ever makes race with nothing installed yet.
   */
  const latest = new Map<SurfaceId, number>();
  /** Monotonic across surfaces; only ever compared against a surface's own. */
  let requested = 0;

  /** Tear down a surface's watcher. Leaves `latest` alone — see {@link forget}. */
  const stop = (surfaceId: SurfaceId): void => {
    const active = watches.get(surfaceId);
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    active.watcher.close();
    watches.delete(surfaceId);
  };

  /**
   * That surface is done watching: tear the watcher down **and** drop its
   * generation.
   *
   * Separate from {@link stop}, which `watchProject` also calls just before
   * installing a replacement — dropping the generation there would be deleting
   * the entry the guard three lines above had just written. Surface ids are
   * never reused, so a generation left behind is permanent, and on a
   * long-running server every renderer reload and every attach leaves one.
   */
  const forget = (surfaceId: SurfaceId): void => {
    latest.delete(surfaceId);
    stop(surfaceId);
  };

  const flush = (surfaceId: SurfaceId): void => {
    const active = watches.get(surfaceId);
    if (!active) return;
    active.timer = null;
    active.burstStartedAt = null;
    if (active.pending.size === 0) return;

    const paths = [...active.pending];
    active.pending.clear();
    emit(surfaceId, { projectId: active.projectId, paths });
  };

  return {
    async watchProject(surfaceId, projectId, sessionId) {
      /**
       * Resolved through the same guard every read goes through, so "watch" is
       * not a second, weaker way to name a directory. An unknown or unusable
       * project throws here exactly as it would on a read.
       */
      const generation = ++requested;
      latest.set(surfaceId, generation);
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
       *
       * Compared against **this surface's** last request (HIVE-145). A shared
       * counter would let another surface's slow `rootFor` cancel this one's
       * install, which is not the race this guards.
       */
      if (latest.get(surfaceId) !== generation) return;

      stop(surfaceId);

      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        const live = watches.get(surfaceId);
        if (!live || live.watcher !== watcher || filename === null) return;
        const relPath = filename.toString();
        if (relPath === '' || isHiddenPath(relPath)) return;

        live.pending.add(relPath);
        live.burstStartedAt ??= Date.now();

        // Postpone, but never past the burst ceiling — see MAX_DEBOUNCE_MS.
        const elapsed = Date.now() - live.burstStartedAt;
        const wait = Math.max(0, Math.min(DEBOUNCE_MS, MAX_DEBOUNCE_MS - elapsed));

        if (live.timer) clearTimeout(live.timer);
        live.timer = setTimeout(() => { flush(surfaceId); }, wait);
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
        if (watches.get(surfaceId)?.watcher !== watcher) return;
        stop(surfaceId);
      });

      watches.set(surfaceId, {
        projectId,
        watcher,
        pending: new Set(),
        timer: null,
        burstStartedAt: null,
      });
    },

    unwatch: forget,
    release: forget,

    dispose() {
      for (const surfaceId of [...watches.keys()]) stop(surfaceId);
      latest.clear();
    },
  };
}

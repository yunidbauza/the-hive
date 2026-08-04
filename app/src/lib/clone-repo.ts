import { installProjectConfig } from '@/lib/project-config';

import type {
  CloneDoneEvent,
  CloneRequest,
  CloneStartResult,
} from '@shared/config-contract';


/**
 * Cloning a repository, as the renderer sees it (story 102).
 *
 * A thin module rather than a store, for the same reason `project-config.ts` is
 * one: main owns every decision in this flow. It picks the folder name, decides
 * whether the clone succeeded, writes the config and cleans up after a failure.
 * The renderer starts a clone and renders what comes back — so there is no
 * state here worth putting in a reducer.
 *
 * No bridge is the browser demo, not a failure (story 083's rule: feature-detect
 * the bridge, never the user agent). Each verb below degrades in the way its
 * caller already handles.
 */

/**
 * Start a clone.
 *
 * Resolves once `git` is running, **not** once it has finished — the terminal
 * streams in between, and completion arrives on {@link onCloneDone}.
 */
export async function startClone(
  request: CloneRequest,
): Promise<CloneStartResult> {
  const bridge = window.hive;
  if (!bridge) {
    return { ok: false, reason: 'cloning is only available in the desktop app' };
  }
  return bridge.config.startClone(request);
}

/**
 * Ask main to kill a running clone.
 *
 * The directory is removed when the process actually exits, not here — main
 * owns that ordering, because removing a tree underneath a live `git` gives a
 * partially-deleted one instead of none.
 */
export async function cancelClone(): Promise<void> {
  await window.hive?.config.cancelClone();
}

/**
 * Subscribe to the outcome. Returns its own unsubscribe.
 *
 * The event's snapshot is installed **before** the caller sees the event, so a
 * subscriber that navigates back to the project list on success finds it
 * already current. Doing this here rather than at the call site keeps the
 * epic's rule — the renderer never follows a write with a reload — in one
 * place, next to the other verbs that honour it.
 */
export function onCloneDone(
  callback: (event: CloneDoneEvent) => void,
): () => void {
  const bridge = window.hive;
  if (!bridge) return () => {};
  return bridge.config.onCloneDone((event) => {
    installProjectConfig(event.snapshot);
    callback(event);
  });
}

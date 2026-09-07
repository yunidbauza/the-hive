import { useSyncExternalStore } from 'react';

import {
  projectAccess,
  projectConfigSnapshot,
  projectPath,
  subscribeProjectConfig,
  type ProjectAccess,
} from '@lib/project-config';
import { isLoopbackHost, type ConfigSnapshot } from '@shared/config-contract';


/**
 * Reading the workspace config from a component (story 090).
 *
 * `useSyncExternalStore` rather than `useState` + an effect: the snapshot lands
 * once, asynchronously, after several components have already mounted, and
 * every one of them has to re-render when it does. An effect per consumer
 * would give each its own copy and its own moment of truth.
 *
 * These are the named selector hooks `AGENTS.md` requires — components never
 * reach into `@lib/project-config` directly, exactly as they never reach into
 * a store.
 */

/** The whole snapshot — for the first-run notice. `null` in the browser demo. */
export function useProjectConfig(): ConfigSnapshot | null {
  return useSyncExternalStore(
    subscribeProjectConfig,
    projectConfigSnapshot,
    projectConfigSnapshot,
  );
}

/** Whether one project can host a session, and why not when it cannot. */
/**
 * A mapped project's absolute directory, or `null` (HIVE-78).
 *
 * Same subscribe-then-derive shape as {@link useProjectAccess}, and for the
 * same stated reason: the two can never disagree about which snapshot they were
 * computed from.
 */
export function useProjectPath(projectId: string): string | null {
  useSyncExternalStore(
    subscribeProjectConfig,
    projectConfigSnapshot,
    projectConfigSnapshot,
  );
  return projectPath(projectId);
}

export function useProjectAccess(projectId: string): ProjectAccess {
  // Subscribed for the re-render; the value is derived below so the two can
  // never disagree about which snapshot they were computed from.
  useSyncExternalStore(
    subscribeProjectConfig,
    projectConfigSnapshot,
    projectConfigSnapshot,
  );
  return projectAccess(projectId);
}

/**
 * The address the receiver is exposed on, or `null` while it is not (HIVE-134).
 *
 * Derived, never stored — the codebase rule, and here it is also the whole
 * safety argument: there is no `bind.enabled` flag that could say "off" while
 * the socket was open. One predicate, `isLoopbackHost`, answers the question for
 * main and for this hook alike.
 *
 * Returns the address rather than a boolean because the only consumer needs to
 * print it, and a hook that returned `true` would make the caller reach back
 * into the snapshot for the value it actually wanted.
 */
export function useReceiverExposure(): string | null {
  const snapshot = useProjectConfig();
  if (snapshot === null) return null;
  const { host } = snapshot.receiver.bind;
  return isLoopbackHost(host) ? null : host;
}

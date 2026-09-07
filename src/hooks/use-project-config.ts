import { useEffect, useState, useSyncExternalStore } from 'react';

import {
  projectAccess,
  projectConfigSnapshot,
  projectPath,
  readAppInfo,
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
 * The address the receiver is **actually** exposed on, or `null` while it is
 * not (HIVE-134).
 *
 * `snapshot.receiver.bind.host` is the wrong source for this and used to be
 * the one in use: it names what will be bound at the app's *next* launch, not
 * what a listening socket is bound to right now, and the two diverge for a
 * whole running session — toggle the settings switch off and the config file
 * (and this hook's old snapshot read) goes loopback instantly, while the
 * receiver bound wide at boot keeps listening until relaunch, exactly because
 * a listening socket cannot be moved (see Settings' own "takes effect at next
 * launch"). A security indicator has to say what *is* true, not what will
 * become true, so this reads `AppInfo.receiverBoundHost` — the host the
 * receiver's `listen()` actually succeeded with — through the same on-demand
 * `readAppInfo` the diagnostics pane already uses, rather than the config
 * snapshot `useProjectConfig` exposes.
 *
 * One fetch on mount, not a subscription: once main's own bind has resolved —
 * succeeded or failed — `receiverBoundHost` cannot change again before a
 * relaunch (same premise as above, from the other side — nothing on this side
 * of a relaunch can move an already-open socket), so there is nothing for a
 * later render of this hook to catch that the first one missed. This mount's
 * one read still has to land *after* that resolution to be trustworthy —
 * `AppInfo.receiverBoundHost`'s own doc comment covers the review finding
 * that made main careful about exactly when it captures the value, so a read
 * from here never observes a live socket as `null`. Gated on `useProjectConfig`
 * having resolved for the same reason
 * `AdvancedSection` gates its own `readAppInfo` call on it: a proxy for "the
 * bridge is actually up," which the browser demo (no bridge, `snapshot` stays
 * `null`) then correctly never crosses.
 *
 * `isLoopbackHost` is still the one predicate that answers "exposed or not,"
 * for main's guards and for this hook alike — only the value it is asked
 * about changed. Returns the address rather than a boolean because the only
 * consumer needs to print it, and a hook that returned `true` would make the
 * caller reach back for the value it actually wanted.
 */
export function useReceiverExposure(): string | null {
  const snapshot = useProjectConfig();
  const hasSnapshot = snapshot !== null;
  const [boundHost, setBoundHost] = useState<string | null>(null);

  useEffect(() => {
    if (!hasSnapshot) return;

    let cancelled = false;
    void readAppInfo().then((info) => {
      if (!cancelled) setBoundHost(info?.receiverBoundHost ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [hasSnapshot]);

  return boundHost !== null && !isLoopbackHost(boundHost) ? boundHost : null;
}

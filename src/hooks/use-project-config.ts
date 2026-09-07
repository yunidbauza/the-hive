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
 * One retry only, and only when the first read landed `null` (HIVE-134
 * follow-up review). Long enough that a slow DNS lookup or an mDNS `.local`
 * name has a real chance to finish — see this hook's own doc comment for why
 * that lookup can outlast window creation, renderer boot and the first
 * `readAppInfo` round trip. Short enough that the chip still appears well
 * within the session if the bind was merely slow rather than failed or never
 * configured — and a bind that is *still* not up after this either failed or
 * was never widened, so a second miss is not chased with a third.
 *
 * Exported for the test that proves the retry actually fires — deliberately,
 * so that test asserts against the real delay this hook waits on rather than
 * a duplicated magic number that could silently drift out of sync with it.
 */
export const LATE_BIND_RETRY_MS = 2000;

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
 * ## One retry, not a subscription — and not a bare one-shot either
 *
 * A previous version of this comment claimed a one-shot read here "never
 * observes a live socket as `null`," reasoning from `AppInfo.receiverBoundHost`'s
 * own doc comment about exactly when *main* captures the value. That comment
 * is correct about main's side and was still the wrong conclusion: it says
 * nothing about whether *this hook's* read lands before or after main's bind
 * resolves, and nothing enforces that ordering. `hooks.start()` is
 * fire-and-forget from `createSessions`, and for a **hostname** bind (which
 * `isHostAlias` accepts, and Settings lets a user type) `listen()` cannot
 * succeed before a DNS lookup does — an mDNS `.local` name or a slow resolver
 * can easily outlast window creation, renderer boot and this hook's own IPC
 * round trip. A single `null` from that race is not proof nothing is
 * listening, only that the bind had not settled *yet* — so this hook retries
 * once, after {@link LATE_BIND_RETRY_MS}, when and only when the first read
 * comes back `null`. A bind that is already up, or that fails outright, never
 * pays for the retry: `receiverBoundHost` is non-null immediately, or stays
 * `null` on both reads and this correctly reports "not exposed."
 *
 * Gated on `useProjectConfig` having resolved for the same reason
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
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    void readAppInfo().then((info) => {
      if (cancelled) return;
      const host = info?.receiverBoundHost ?? null;
      setBoundHost(host);

      // See `LATE_BIND_RETRY_MS`'s own comment: a `null` here is ambiguous
      // between "nothing is listening" and "the bind has not resolved yet,"
      // and only a second read tells the two apart.
      if (host === null) {
        retryTimer = setTimeout(() => {
          if (cancelled) return;
          void readAppInfo().then((retryInfo) => {
            if (!cancelled) setBoundHost(retryInfo?.receiverBoundHost ?? null);
          });
        }, LATE_BIND_RETRY_MS);
      }
    });

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [hasSnapshot]);

  return boundHost !== null && !isLoopbackHost(boundHost) ? boundHost : null;
}

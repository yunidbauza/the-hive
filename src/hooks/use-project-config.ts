import { useEffect, useState, useSyncExternalStore } from 'react';

import { can, type RemoteCapabilities } from '@config/runtime';
import {
  projectAccess,
  projectConfigSnapshot,
  projectContainerised,
  projectPath,
  readAppInfo,
  readLocalRemote,
  subscribeProjectConfig,
  type ProjectAccess,
} from '@lib/project-config';
import {
  isLoopbackHost,
  type ConfigSnapshot,
} from '@shared/config-contract';
import type { LocalRemoteState } from '@shared/ipc-contract';
import { useRemoteLink } from '@stores/hive-store';


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
 * Whether a project's sessions run in a container (terminals).
 *
 * Same subscribe-then-derive shape as {@link useProjectAccess}, and for the
 * same stated reason: the two can never disagree about which snapshot they
 * were computed from — and the terminal link reads both at once.
 */
export function useProjectContainerised(projectId: string): boolean {
  useSyncExternalStore(
    subscribeProjectConfig,
    projectConfigSnapshot,
    projectConfigSnapshot,
  );
  return projectContainerised(projectId);
}

/**
 * The five `can.*` remote-attach predicates (HIVE-144), reactive to the
 * `@lib/project-config` subscription.
 *
 * Same subscribe-then-derive shape as {@link useProjectAccess}: `can.*` are
 * plain functions so an event handler can call them without a hook (a
 * `spawnSessionIn` check before a click already does this), but a *rendered*
 * disabled state has to re-paint the instant a live mode switch lands, which
 * a bare function call inside a component that reads no other config state
 * would not do on its own. Subscribing here for the re-render, then reading
 * `can.*` fresh, is what keeps the two from disagreeing about which state
 * either was computed from.
 *
 * The subscription is the same one either way, which is why one
 * `useSyncExternalStore` still covers all four: these answer off the runtime
 * attachment (`can`'s own `currentRemote`), and that module emits on its
 * subscribers when the attachment moves exactly as it does when the snapshot
 * does.
 */
export function useRemoteCapabilities(): RemoteCapabilities {
  useSyncExternalStore(
    subscribeProjectConfig,
    projectConfigSnapshot,
    projectConfigSnapshot,
  );
  return {
    chooseDirectory: can.chooseDirectory(),
    importSkillFiles: can.importSkillFiles(),
    importSkill: can.importSkill(),
    revealConfig: can.revealConfig(),
  };
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

/**
 * The address the server-mode socket is **actually** listening on, or `null`
 * while nothing is (HIVE-142).
 *
 * Sourced from `AppInfo.serverBoundHost` rather than `snapshot.server.bind.host`
 * for the same reason `useReceiverExposure` reads `receiverBoundHost` instead
 * of `snapshot.receiver.bind.host`: the config value is what will be bound at
 * the *next* launch, and a listening socket cannot be moved to match a config
 * write that happens after boot. See `AppInfo.serverBoundHost`'s own doc
 * comment for exactly what "bound right now" means and why it can lag a
 * config read for a whole running session.
 *
 * Same one-retry shape as `useReceiverExposure`, using the same
 * {@link LATE_BIND_RETRY_MS}: `startRemoteListener()` is fire-and-forget from
 * main's boot sequence, `server.bind.host` accepts a hostname as well as an
 * IPv4 literal, and a slow resolution can outlast this hook's first read —
 * a lone `null` is ambiguous between "off" and "not resolved yet," so a
 * second read after the same delay tells the two apart.
 *
 * Unlike `useReceiverExposure`, the result is not filtered through
 * `isLoopbackHost`: that predicate answers "is this wider than the user might
 * have meant," which is the receiver's whole question. A server-mode bind is
 * deliberate by construction — nothing sets `server.enabled` by accident —
 * so any non-null address here is worth showing, loopback included.
 */
export function useServerExposure(): string | null {
  const snapshot = useProjectConfig();
  const hasSnapshot = snapshot !== null;
  const [boundHost, setBoundHost] = useState<string | null>(null);

  useEffect(() => {
    if (!hasSnapshot) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    void readAppInfo().then((info) => {
      if (cancelled) return;
      const host = info?.serverBoundHost ?? null;
      setBoundHost(host);

      // See `LATE_BIND_RETRY_MS`'s own comment: a `null` here is ambiguous
      // between "nothing is listening" and "the bind has not resolved yet,"
      // and only a second read tells the two apart.
      if (host === null) {
        retryTimer = setTimeout(() => {
          if (cancelled) return;
          void readAppInfo().then((retryInfo) => {
            if (!cancelled) setBoundHost(retryInfo?.serverBoundHost ?? null);
          });
        }, LATE_BIND_RETRY_MS);
      }
    });

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [hasSnapshot]);

  return boundHost;
}

/**
 * How many devices are paired to this Hive's server mode, right now, or `0`
 * before the first read lands (HIVE-142, HIVE-144 Task 13).
 *
 * A separate hook from {@link useServerExposure} rather than a second field on
 * its return, because the two answer genuinely different questions that
 * happen to share a source object: `useServerExposure` gates whether
 * `ServingChip` renders at all (is a socket bound?), and this hook answers how
 * many devices are paired **independent of that** — `AppInfo.servingDeviceCount`
 * reads `server.devices` off disk, which exists whether or not anything is
 * currently listening. Folding them into one return would force every caller
 * of the gate to also destructure a count it may not want, and would make "is
 * this hook's `null` the gate or the count" a question the type alone cannot
 * answer.
 *
 * No late-bind retry, unlike `useServerExposure`: pairing a device
 * (`pairDevice`, `@lib/project-config`) writes `server.devices` synchronously,
 * not over a DNS lookup that can outlast this hook's first round trip, so a
 * `0` here is never ambiguous between "really zero" and "not read yet" the
 * way a fresh bind's `null` is for {@link useServerExposure}.
 *
 * Gated on `useProjectConfig` having resolved, the same proxy for "the bridge
 * is actually up" every hook in this file uses, so the browser demo (no
 * bridge, snapshot stays `null`) correctly never calls `readAppInfo` at all.
 *
 * **Keyed on the snapshot, not on `hasSnapshot` (HIVE-144 review, M7).** It
 * used to depend on the boolean, which is a `false → true` edge and therefore
 * fires exactly once — right for a bind that cannot move for the life of the
 * process, wrong for a roster the user edits from the pane this number is
 * rendered on. `pairDevice` and `revokeDevice` both install a fresh snapshot
 * when they land, so keying on the snapshot itself is what makes the count
 * follow a pairing or a revocation instead of describing the roster as it was
 * when Settings first opened. It is the identical correction Ruling 29 made to
 * {@link useAttachedServer} below, for the identical reason, and it costs one
 * `app:info` per config write to a `PROCESS_LOCAL` channel.
 */
export function useServingDeviceCount(): number {
  const snapshot = useProjectConfig();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (snapshot === null) return;

    let cancelled = false;
    void readAppInfo().then((info) => {
      if (!cancelled) setCount(info?.servingDeviceCount ?? 0);
    });

    return () => {
      cancelled = true;
    };
  }, [snapshot]);

  return count;
}

/**
 * The name of the server this window is attached to over a socket, or `null`
 * in `'local'` mode (HIVE-144, Task 13).
 *
 * Sourced from `AppInfo.attachedServerName`, never from
 * `ConfigSnapshot.attachedServer` — see that field's own doc comment, and
 * `AppInfo.attachedServerName`'s, for the full config-versus-runtime split.
 * This hook reads the runtime half exactly as `useServerExposure` and
 * `useReceiverExposure` read theirs.
 *
 * One-shot, not the two-read late-bind retry those hooks carry: that retry
 * exists because a *hostname* bind resolves via DNS on a timeline a first
 * `readAppInfo` round trip can outrun, so a bare `null` is ambiguous between
 * "off" and "not yet resolved." Attaching has no equivalent race from here —
 * `readAppInfo()` itself does not resolve until whichever process is
 * answering it has already finished computing the answer, so a `null` this
 * hook sees is always the real one, not a read that landed early.
 *
 * Gated on `useProjectConfig` having resolved, the same proxy for "the bridge
 * is actually up" every hook in this file uses.
 *
 * **Re-read on every snapshot, not only on the first one (HIVE-144, Ruling
 * 29).** Its two siblings above key their effect on `hasSnapshot`, which is a
 * `false → true` edge and therefore fires once — right for a bind that cannot
 * move for the life of the process, wrong for this one. Attachment changes
 * *during* a session, and the moment it changes is a `config:set-remote` that
 * also replaces the snapshot: attaching swaps in the far end's, detaching swaps
 * back to this machine's. Keying on the snapshot itself is what makes this
 * value follow the socket rather than describe whatever was true at boot — and
 * it is load-bearing now that Settings reads it, because a stale `null` there
 * hides the detach control and a stale name offers one that has nothing to
 * detach. The header chip gets the same correction for free; it was quietly
 * stale after any switch before this.
 *
 * The extra reads this costs are one `app:info` per config write, to a channel
 * that is `PROCESS_LOCAL` and answered without touching a socket at all.
 */
/**
 * Whether this process was launched to serve (HIVE-144 review, I3).
 *
 * `AppInfo.serving` — intent, not a bound socket, and emphatically not
 * `ConfigSnapshot.server.enabled`, which while attached describes the
 * **server's** file and reads `true` on a client attached to a real server.
 * See that field's own doc comment for both halves.
 *
 * One-shot, keyed on `hasSnapshot`, and that is the right dependency here
 * where it is the wrong one two hooks up: this value is fixed for the life of
 * the process. A serving machine cannot stop serving without a relaunch (the
 * socket cannot be moved, which is what "takes effect at next launch" means),
 * and a client cannot start.
 *
 * Settings uses it for the interlock: the attach half is disabled on a
 * serving machine, with the reason on the control, rather than offering a
 * switch `switchIpcMode` would refuse.
 */
export function useServing(): boolean {
  const snapshot = useProjectConfig();
  const hasSnapshot = snapshot !== null;
  const [serving, setServing] = useState(false);

  useEffect(() => {
    if (!hasSnapshot) return;

    let cancelled = false;
    void readAppInfo().then((info) => {
      if (!cancelled) setServing(info?.serving ?? false);
    });

    return () => {
      cancelled = true;
    };
  }, [hasSnapshot]);

  return serving;
}

export function useAttachedServer(): string | null {
  /*
    **Sourced from the pushed link, not from a read (HIVE-150).**

    The doc comment above describes what this was: an `app:info` read keyed on
    the config snapshot. That was already the second attempt — Ruling 29 moved
    it from a one-shot to a per-snapshot read, because attachment changes during
    a session — and it was still wrong in the same way, one level down. It
    followed *config writes*, and the drop this story exists for writes no
    config at all. A socket that died left this naming a machine the window
    could no longer reach, for as long as the window stayed open.

    `remote:link-status` is pushed on every transition instead, so this now
    follows the socket rather than the file. `useRemoteLinkStream` mounts the
    subscription once in the app shell and hydrates it from the same `app:info`
    read this used to make, which is what keeps a boot attach — whose push
    happened before the window existed — from showing nothing.

    It answers the far machine's name in **every** remote state, not only while
    a socket is open. Every caller asks the same question with it — "is this
    window driving another machine?" — and the answer stays yes while the link
    is being re-established: the projects, the sessions and the config on screen
    are still that machine's. The three-way distinction between attached,
    reconnecting and given up belongs to the two surfaces that render it, and
    they read {@link useRemoteLink} for it.
  */
  return useRemoteLink()?.serverName ?? null;
}

/**
 * This machine's own `remote` block, or `null` until it has been read
 * (HIVE-149).
 *
 * It exists for the reason {@link useAttachedServer} and {@link useServing} do:
 * the question "what is true of *this* process" cannot be answered from the
 * snapshot while attached, because that snapshot comes from the server — whose
 * own `remote.mode` reads `local`, since a server is not attached to anyone.
 * `config:get-remote` is `PROCESS_LOCAL`, so it is answered here in either mode.
 *
 * **A read keyed on the snapshot, like {@link useServing}, not a pushed value
 * like {@link useAttachedServer} became in HIVE-150.** The distinction is which
 * thing the value follows. That one follows the *socket*, because a link can die
 * without anything being written. This follows the *file*, because that is the
 * only thing that moves it: `config:set-remote` is the sole writer, and it
 * installs a fresh snapshot on the way through, so keying on the snapshot
 * already covers both a mode switch and a reload. There is nothing here a push
 * would tell us sooner.
 */
export function useLocalRemote(): LocalRemoteState | null {
  const snapshot = useProjectConfig();
  const [local, setLocal] = useState<LocalRemoteState | null>(null);

  useEffect(() => {
    if (snapshot === null) return;

    let cancelled = false;
    void readLocalRemote().then((block) => {
      /*
        A failed read keeps the last good block rather than nulling it, which is
        what `readLocalRemote`'s own doc comment promises ("a caller shows what
        it already had rather than an address this machine never stated"). This
        effect re-fires on every new snapshot, so without the `??` one failed
        *re*-read after a good one would drop the pane back to no answer — and
        the address fields with it.
      */
      if (!cancelled) setLocal((previous) => block ?? previous);
    });

    return () => {
      cancelled = true;
    };
  }, [snapshot]);

  return local;
}

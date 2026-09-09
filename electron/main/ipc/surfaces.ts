import type { ServerFrame } from '@shared/remote-contract';

import type { RemoteReporter } from './registry';
import type { AttachedSocket } from './socket-broadcaster';

/**
 * Who is looking at this Hive right now, and how to reach exactly one of them
 * (HIVE-145).
 *
 * ## Why this exists
 *
 * Five pieces of main-process state were written by "the" renderer, back when
 * there was provably one: `deliver`'s input-box record, `foregroundTerminalId`,
 * the `pty:ack` backpressure window, the fs watch slot, and the notification
 * presenter. HIVE-143 made every channel reachable from an attached socket and
 * HIVE-144 shipped the client half, so "the renderer" became "whichever surface
 * spoke last" — and each of those five went from a fact to a race. Three of
 * them carried a comment saying so and naming this story.
 *
 * They are all the same bug, so they get one fix and one identity to key on
 * rather than five private maps that can disagree about who is live.
 *
 * ## What counts as a surface
 *
 * A local window's `webContents`, and an attached socket. Both are things a
 * person is looking at, both can go away, and both write the same state — which
 * is the whole definition. Nothing else qualifies: a scheduler wake or an MCP
 * call is not a surface, because there is nobody at the other end of it.
 *
 * ## Identity, and why it is the reporter object
 *
 * `watchReporter` (`ipc/index.ts`) already deduped surfaces by object identity
 * through a `WeakSet`, because `pty:prompt` arrives per keystroke and
 * registering a fresh listener set on each one would leak. `deliver.ts` names
 * that identity as the thing to key by. This module is that function widened:
 * same dedupe, same duck-typed `on`, but it hands back an id and announces the
 * lifetime instead of calling one collaborator directly.
 *
 * A `WeakMap` rather than a `Map`, for the reason the `WeakSet` was weak: a
 * closed window's `webContents` must be collectable, and a registry that
 * outlives the app's windows by holding them is a leak wearing a bookkeeping
 * costume.
 *
 * ## The single release point
 *
 * {@link SurfaceRegistry.onGone} is where every per-surface consumer unhooks.
 * That is the story's "release every server resource on disconnect", and it is
 * a subscription rather than a leak hunt: nothing was found unreleased today,
 * but five maps keyed by surface are five things that would be.
 */

/** Opaque, and only ever compared for equality. */
export type SurfaceId = string;

/**
 * `window` reads its focus live from this machine's `BrowserWindow`s; `socket`
 * reports its own, because a served Mac's windows say nothing about a laptop
 * four time zones away. See `isForegroundFor` in `ipc/index.ts`.
 */
export type SurfaceKind = 'window' | 'socket';

export interface Surface {
  readonly id: SurfaceId;
  readonly kind: SurfaceKind;
  /**
   * Push to **just this surface**.
   *
   * The targeted counterpart to `Broadcaster.emit`, which reaches all of them.
   * What needs it: a toast, which belongs to whoever is not already looking at
   * the session, and `fs:changed`, which belongs to the surface whose explorer
   * asked for the watch and to no other.
   */
  send(channel: string, payload: unknown): void;
}

/**
 * An attached socket **and** its own lifetime, in one object.
 *
 * `RemoteReporter` is already the duck-typed "surface with a lifetime" shape
 * (`./registry.ts`), and `AttachedSocket` is already the frame sink. Before
 * HIVE-145 a connection had one of each and they were separate objects, which
 * meant two identities for one socket and a lookup between them. They are the
 * same object now, and this is the type that says so.
 */
export type AttachedSurface = AttachedSocket & RemoteReporter;

export interface SurfaceRegistry {
  /**
   * A local window reported itself. `send` is how main pushes to it —
   * `contents.send`, injected rather than imported so this module never needs
   * `BrowserWindow`.
   *
   * Returns the id, existing or new. A reporter with no `on` is ignored and
   * gets a throwaway id, so callers need no branch for the shapes the unit
   * suites hand in.
   */
  trackWindow(reporter: unknown, send: Surface['send']): SurfaceId;
  /**
   * A socket attached. One object is both the frame sink and the lifetime
   * (HIVE-145): two objects for one connection meant two keys and a lookup
   * between them, which is the shape of bug this module closes.
   */
  trackSocket(socket: AttachedSurface): SurfaceId;
  /**
   * Remove a surface by its object, if it is tracked. Idempotent, and the
   * same removal the lifetime events trigger — `onGone` still fires exactly
   * once however the surface goes away.
   *
   * The listener's `onDetach` calls this. Its `close` handler fires the
   * socket's own `destroyed` listeners *and* `onDetach`, and both converge
   * here: one removal, two triggers, rather than two removal paths that can
   * disagree.
   */
  untrack(value: unknown): void;
  get(id: SurfaceId): Surface | undefined;
  all(): Surface[];
  /**
   * The attached sockets, for `createSocketBroadcaster`. Handles rather than
   * {@link Surface}s, so the broadcaster keeps owning frame construction and
   * the `undefined`-payload reasoning that goes with it.
   */
  sockets(): AttachedSocket[];
  size(): number;
  /** One surface went away. The single release point. Returns an unsubscribe. */
  onGone(listener: (id: SurfaceId) => void): () => void;
  /**
   * The registry went from empty to non-empty — somebody is looking again.
   * What flushes the toast queue, which exists precisely for the stretch when
   * nobody was.
   */
  onFirst(listener: () => void): () => void;
  /**
   * Drop everything **without announcing it**, for `resetIpcHandlers`.
   *
   * Silent on purpose: a teardown is not a disconnect. Firing `onGone` here
   * would drive consumers that are themselves being disposed in the same pass,
   * in an order nothing guarantees.
   */
  clear(): void;
}

/**
 * The events that mean a surface is gone.
 *
 * A window has three ways to stop being the thing that reported: it navigated
 * (a dev reload), its renderer died, or it closed. A socket only ever has the
 * last — it is open or it is gone — and `remote-host/listener.ts` wires only
 * that one, so the extra two cost a socket nothing.
 */
const LIFETIME_EVENTS = ['did-start-loading', 'render-process-gone', 'destroyed'] as const;

const asReporter = (value: unknown): RemoteReporter | null => {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { on?: unknown };
  return typeof candidate.on === 'function' ? (value as RemoteReporter) : null;
};

export function createSurfaceRegistry(): SurfaceRegistry {
  const live = new Map<SurfaceId, Surface>();
  /** Socket handles, by id, so `sockets()` needs no cast back. */
  const handles = new Map<SurfaceId, AttachedSocket>();
  /** Identity → id, weak so a closed window's contents can be collected. */
  let ids = new WeakMap<object, SurfaceId>();
  const goneListeners = new Set<(id: SurfaceId) => void>();
  const firstListeners = new Set<() => void>();

  let counter = 0;
  const nextId = (): SurfaceId => `surface-${String(++counter)}`;

  const remove = (id: SurfaceId, reporter: object): void => {
    // At most once. Every lifetime event is wired, and a window that navigates
    // and is then destroyed fires two of them.
    if (!live.has(id)) return;
    live.delete(id);
    handles.delete(id);
    // Dropped so the same object coming back — a reloaded `webContents` — is a
    // new surface rather than an id pointing at nothing.
    ids.delete(reporter);
    /*
      Every listener runs, whatever the ones before it did. This is the single
      release point — the ledger's focus record, the foreground map, the
      flow-control window and the fs watch layer all unhook here — so one
      throwing consumer must not strand the rest holding state for a surface
      that is gone. A stranded flow-control mark in particular would pause a
      session for the life of the process.
    */
    for (const listener of goneListeners) {
      try {
        listener(id);
      } catch (cause) {
        console.error('[hive] surface release listener failed:', cause);
      }
    }
  };

  const track = (
    value: unknown,
    kind: SurfaceKind,
    send: Surface['send'],
    handle?: AttachedSocket,
  ): SurfaceId => {
    const reporter = asReporter(value);

    /*
      A window with no lifetime to watch is not tracked at all, which is
      `watchReporter`'s own rule kept intact: the unit suites hand in a bare
      object as `event.sender`, and a surface that can never announce its own
      death would hold that renderer's input-box record forever.

      A socket is the other way round. Being in the fan-out is the whole point
      of an attached socket and never depended on having a lifetime — the
      `Set<AttachedSocket>` this replaced did not care — so one is registered
      either way and `untrack` from the listener's `onDetach` is what removes
      it. Silently dropping it would leave a client that looks attached and
      receives nothing.
    */
    if (reporter === null && kind === 'window') return nextId();

    const key = reporter ?? (value as object | null);
    if (key !== null) {
      const existing = ids.get(key);
      if (existing !== undefined) return existing;
    }

    const id = nextId();
    const wasEmpty = live.size === 0;

    if (key !== null) ids.set(key, id);
    live.set(id, { id, kind, send });
    if (handle !== undefined) handles.set(id, handle);

    if (reporter !== null) {
      for (const event of LIFETIME_EVENTS) {
        reporter.on(event, () => { remove(id, reporter); });
      }
    }

    if (wasEmpty) {
      for (const listener of firstListeners) {
        try {
          listener();
        } catch (cause) {
          console.error('[hive] surface arrival listener failed:', cause);
        }
      }
    }
    return id;
  };

  return {
    trackWindow(reporter, send) {
      return track(reporter, 'window', send);
    },

    trackSocket(socket) {
      return track(
        socket,
        'socket',
        (channel, payload) => {
          /*
            `payload` passed straight through, `undefined` included — the same
            absent-versus-empty distinction `createSocketBroadcaster` documents:
            `JSON.stringify` drops an `undefined` value's key entirely, so the
            frame on the wire has no `payload` at all, which is what the local
            push had too. Substituting `null` would invent a value.
          */
          socket.send({ kind: 'event', channel, payload } as unknown as ServerFrame);
        },
        socket,
      );
    },

    untrack(value) {
      if (typeof value !== 'object' || value === null) return;
      const id = ids.get(value);
      if (id === undefined) return;
      remove(id, value);
    },

    get: (id) => live.get(id),
    all: () => [...live.values()],
    sockets: () => [...handles.values()],
    size: () => live.size,

    onGone(listener) {
      goneListeners.add(listener);
      return () => goneListeners.delete(listener);
    },

    onFirst(listener) {
      firstListeners.add(listener);
      return () => firstListeners.delete(listener);
    },

    clear() {
      live.clear();
      handles.clear();
      /*
        Replaced, not merely emptied — a `WeakMap` has no `clear`, and leaving
        it would be worse than a leak. A reporter that survives the teardown
        (the same `webContents`, or a suite's module-scope fake event) would
        still resolve to its old id, and `track` would hand that id back for a
        surface no longer in `live` — so every per-surface lookup would miss
        and the surface would be invisible while looking tracked.
      */
      ids = new WeakMap<object, SurfaceId>();
    },
  };
}

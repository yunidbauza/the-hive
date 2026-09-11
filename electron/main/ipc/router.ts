import { powerMonitor } from 'electron';

import { isRemoteTarget, type SwitchOutcome } from '@shared/config-contract';
import { CH, type AppInfo, type RemoteLinkStatus } from '@shared/ipc-contract';

import {
  PlaintextRefusedError,
  connectRemote,
  type ConnectRemoteDeps,
  type RemoteClient,
} from '../../remote-client/socket';
import type { StoredDeviceCredential } from '../../remote-client/token-store';
import { getConfig } from '../config';
import { isServerMode } from '../server-mode';

import { createWindowBroadcaster, type Broadcaster } from './broadcaster';
import { createReattachLoop, type ReattachLoop } from './reattach';
import { applyRemoteForget, applyRemotePair } from './remote-pairing';
import { registerRemoteProxy, remoteProxyBindingsSize, resetRemoteProxy } from './remote-proxy';
import { composeResumeFrom, createResumeTracker, type ResumeTracker } from './resume-tracker';
import { applySetRemote } from './set-remote';

import {
  ipcBindingsSize,
  readRemoteCredential,
  registerIpcHandlers,
  remoteCredentialStore,
  resetIpcHandlers,
  sessionsLayer,
} from './index';

/**
 * Where this process's IPC is answered (HIVE-141).
 *
 * `local` is today and every day so far: `registerIpcHandlers()` binds every
 * channel to handlers in this process. `remote` is the mode where they are
 * answered by another machine instead — `registerRemoteProxy` forwards each
 * one to the socket this process attached to, over `RemoteClient` (HIVE-144).
 *
 * The switch lands a story before it does anything so that the boot path has
 * exactly one shape from here on. A mode added later to a boot path that never
 * had one is a refactor of `electron/main/index.ts`; a mode added to a switch is
 * a branch.
 */
export type IpcMode = 'local' | 'remote';

export interface RegisterIpcOptions {
  /**
   * Where main → renderer pushes go. Defaults to every live window either
   * way: in local mode that is the only surface there is, and in remote mode
   * it is what `registerRemoteProxy` pumps `client.onEvent` into. Supplied
   * explicitly by the remote host once sockets can attach *to* this process,
   * which is a different broadcaster answering a different question.
   */
  broadcaster?: Broadcaster;
  /** The attached socket, required in `remote` mode and ignored in `local`. */
  client?: RemoteClient;
  /**
   * Where a reconnect's `resumeFrom` is built from, in `remote` mode
   * (HIVE-150).
   *
   * Passed in rather than read off this module's own {@link resumeTracker} so
   * that the value the proxy is fed and the value a reattach composes from are
   * the same object by construction, rather than by two reads that could
   * straddle a mode switch.
   */
  resumeTracker?: ResumeTracker;
}

/**
 * Bind this process's IPC according to `mode`.
 *
 * Local mode forwards to `registerIpcHandlers` and nothing else — no wrapping,
 * no filtering, no authorization check. The table in
 * `electron/shared/remote-contract.ts` is consulted by nothing in this path on
 * purpose: local callers are the sandboxed renderer of the app's own window,
 * already vouched for by `electron/main/ipc/sender.ts`, and adding a second gate
 * that always passes would be a gate nobody could tell was working.
 *
 * Remote mode forwards to `registerRemoteProxy`, which consults the same
 * sender check and nothing else — the renderer is the same sandboxed window
 * either way, only what answers it changes. `client` has no default: a caller
 * that asks for `remote` without a socket already open is a programming
 * error, not a runtime condition to recover from.
 */
export function registerIpc(mode: IpcMode, options: RegisterIpcOptions = {}): void {
  if (mode === 'remote') {
    if (options.client === undefined) {
      throw new Error('registerIpc("remote", ...) requires a client — there is no socket to attach to.');
    }
    const broadcaster = options.broadcaster ?? createWindowBroadcaster();
    registerRemoteProxy({
      client: options.client,
      broadcaster,
      resumeTracker: options.resumeTracker,
      onLinkLoss: () => noteLinkLoss(broadcaster),
      // See `localAppInfo`'s own doc comment: this is the closure the most
      // recent `registerIpc('local', ...)` produced, so `CH.appInfo` keeps
      // answering from *this* process even once it stops answering anything
      // else (HIVE-144, Ruling 24).
      localAppInfo: localAppInfo ?? undefined,
      /*
        `CH.configSetRemote`, answered here rather than over the socket
        (HIVE-144, Ruling 28).

        Built fresh at each registration rather than captured the way
        `localAppInfo` is, because unlike that one it closes over no
        registration at all — `applySetRemote` reaches only config-module
        functions and `switchIpcMode`, both of which outlive every teardown
        this module performs. `switchIpcMode` is named directly, from inside
        the module that defines it, which is what keeps this out of the
        `import/no-cycle` bind that makes `localAppInfo` a handed-down value:
        `remote-proxy.ts` cannot import this module back.

        The reflexive call is the point and not an accident: this hands the
        proxy a function whose job is to tear the proxy down.
      */
      localSetRemote: (payload) => applySetRemote(payload, switchIpcMode, attachedSnapshot),
      /*
        `CH.remotePair` and `CH.remoteForget`, answered here rather than over
        the socket (HIVE-153). While they were proxied, a Forget click on an
        attached client cleared the *server's* credential — the far machine's
        own pairing revoked from the near machine's UI, and the clicking
        user's credential untouched.

        Built fresh at each registration for `localSetRemote`'s reason. The
        store is finer-grained still — one per *invocation*, constructed inside
        the arrow bodies rather than closed over — which `readRemoteCredential`
        already does and which `createTokenStore` is written for: it caches
        nothing and holds no handle, so a per-call store and a hoisted one
        behave identically. Constructing it here keeps the
        `app.getPath('userData')` read inside a function that only ever runs
        after the app is ready, and it goes through `remoteCredentialStore()`
        because that is the one function allowed to spell the filename —
        precisely so a credential paired from the local handler is looked for
        by the proxy at the same path.
      */
      localRemotePair: (payload) => applyRemotePair(payload, remoteCredentialStore()),
      localRemoteForget: () => applyRemoteForget(remoteCredentialStore()),
      localRemotePaired: () => remoteCredentialStore().read() !== null,
    });
    return;
  }
  /*
    `switchIpcMode` is handed *down* rather than imported *up* (HIVE-144).

    `config:set-remote`'s handler lives inside `registerIpcHandlers` and has to
    be able to switch this process's mode, but `ipc/index.ts` importing this
    module would close a cycle — this module already imports that one — and
    `import/no-cycle` is an error here. So the one capability the handler needs
    crosses the seam as an argument. That is also the honest shape: the router
    owns which mode is bound, and the handler asks it rather than reaching into
    it.
  */
  localAppInfo = registerIpcHandlers(
    options.broadcaster,
    switchIpcMode,
    attachedServerName,
    attachedSnapshot,
    attachedLinkStatus,
  );
}

/**
 * The `CH.appInfo` answer the most recent local registration built (HIVE-144,
 * Ruling 24) — `registerIpcHandlers`'s own return value, over *that* call's
 * `hooks`, `remoteListener` and `sessions`.
 *
 * `null` only before the very first `registerIpc('local', ...)` this process
 * ever makes, which boot never lets `registerIpc('remote', ...)` outrun:
 * `electron/main/index.ts` always calls `registerIpc('local')` first and only
 * conditionally follows it with `switchIpcMode('remote')`. `registerRemoteProxy`'s
 * own `localAppInfo` parameter is optional and defaults to a throwing
 * placeholder for the one caller that can still see `null` here — a test that
 * calls `registerIpc('remote', ...)` directly, skipping the local call that
 * would have set this.
 */
let localAppInfo: (() => AppInfo) | null = null;

/**
 * What a live switch may be told, beyond where the pushes go.
 *
 * Deliberately **not** {@link RegisterIpcOptions}, though the plan's signature
 * said so: that type's `client` is a socket the caller already opened, and an
 * open socket is the one thing this function produces rather than consumes.
 * Offering both would be two ways to say the same thing, and the second one to
 * drift would win silently.
 *
 * Everything here has a production default. The injectable seams exist for the
 * same reason `connectRemote`'s own `WebSocketCtor` and `resolveAddress` do —
 * so a unit test can drive this branch without a socket, a keyring, or a live
 * PTY — and for one more: `target` is genuinely different at the two call
 * sites. The settings pane switches to an address the user has just typed and
 * that Ruling 19 forbids writing to disk until the switch has succeeded, so
 * the stored config is exactly the wrong place to read it from there.
 */
export interface SwitchIpcOptions {
  /** Where main → renderer pushes go, as in {@link RegisterIpcOptions}. */
  broadcaster?: Broadcaster;
  /**
   * Where to attach. Defaults to the stored `remote` block — right for boot,
   * wrong for the settings pane, which passes the address being committed.
   */
  target?: { host: string; port: number };
  /** Who is attaching. Defaults to this machine's stored device credential. */
  credential?: StoredDeviceCredential | null;
  /** The dialler. Defaults to the real socket. */
  connect?: (deps: ConnectRemoteDeps) => Promise<RemoteClient>;
  /**
   * The local sessions a switch to remote would strand. Defaults to the live
   * sessions layer, which is `null` — and so answers none — whenever local
   * handlers are not the bound surface.
   */
  liveSessions?: () => readonly string[];
}

/**
 * The socket {@link switchIpcMode} opened, so that the same function can close
 * it when it detaches.
 *
 * Module scope for the reason `remote-proxy.ts`'s own `bindings` is: it is
 * filled by one call and has to be released by a later, unrelated one. Not a
 * mirror of "which mode is bound" — that question is answered by reading the
 * two binding recorders, which are what `ipcMain` actually holds. This is
 * ownership of a resource, and nothing else derives from it.
 */
let attached: RemoteClient | null = null;

/**
 * The name of the server `attached` is open against, or `null` when this
 * process is not attached to one (HIVE-144 Task 13).
 *
 * `registerIpcHandlers` is handed this the same way it is handed
 * `switchIpcMode` — as an argument, not an import — for the identical reason
 * {@link ModeSwitcher}'s own doc comment gives: `ipc/index.ts` already imports
 * this module, so the reverse import would close the `import/no-cycle` this
 * repo enforces. It reads the module-scope `attached` fresh on every call
 * rather than closing over a snapshot of it, because `registerIpcHandlers`
 * runs once at boot while `attached` changes underneath it on every
 * `switchIpcMode` call this session makes.
 *
 * `client.serverName()` (`RemoteClient`, Task 7) is the far end's own
 * `hostname()`, carried over in the attach handshake — see
 * `AppInfo.attachedServerName`'s own doc comment for why this is the
 * *runtime* half of the config-versus-runtime split `ConfigSnapshot.attachedServer`
 * draws the other half of.
 */
export function attachedServerName(): string | null {
  return attached?.serverName() ?? null;
}

/**
 * The reconnect loop for the current attachment, or `null` when there is not
 * one (HIVE-150).
 *
 * Module-scope beside {@link attached} and for the same reason: it is a
 * resource one call acquires and an unrelated later one has to release. A
 * timer that outlived its mode switch would reattach a user who explicitly
 * asked to work locally, some seconds after they asked.
 */
let reattach: ReattachLoop | null = null;

/**
 * What this attachment has seen, so a reconnect can resume rather than
 * re-hydrate (HIVE-150).
 *
 * Outlives any one socket — that is the whole point — and is discarded with the
 * attachment itself. A tracker carried across a full detach and re-attach would
 * offer the new server resume points minted by the old one.
 */
let resumeTracker: ResumeTracker | null = null;

/**
 * Stops the current client's close subscription (HIVE-150).
 *
 * Held at module scope beside {@link attached} because it must be dropped
 * *before* that socket is closed on purpose. `unbindEverything` closes the
 * client it dialled; `ws` answers with `'close'`; `onClose` fires; and without
 * this the reconnect loop takes a deliberate detach for a dropped connection
 * and starts dialling the server the user has just left. `cancel()` alone does
 * not prevent it — a cancelled loop is idle, and `begin` on an idle loop is
 * exactly how a real drop starts one.
 *
 * Found by the live two-app suite, which drives a real socket; every unit fake
 * had a `close()` that fired no listeners, so nothing in-process could see it.
 */
let stopWatchingClose: (() => void) | null = null;

/**
 * The reattach epoch, monotonic for this **process**, not for one loop
 * (HIVE-150).
 *
 * The renderer keys the effects that own per-surface state on it, and those
 * effects re-run because the value *changed* — so it has to keep climbing
 * across attachments, not just within one. A detach or a re-target builds a new
 * loop, and a counter living inside the loop restarts at 0: re-attaching to the
 * same server with the same project and session open would leave `projectId`,
 * `sessionId`, `root` and the epoch all unchanged, and neither owner would
 * re-arm against the surface the server has just minted.
 */
let reattachEpoch = 0;

/**
 * The last link status this process pushed, for {@link AppInfo.remoteLink}
 * (HIVE-150).
 *
 * A window that has just opened has received no push, and
 * `attachedServerName()` alone told it the wrong thing: that field stays
 * non-null through a drop and through a terminal disconnect, so a window opened
 * mid-outage painted a healthy chip over a link that was down — and after a
 * terminal disconnect no further transition ever arrives to correct it.
 */
let lastLinkStatus: RemoteLinkStatus | null = null;

/** What {@link AppInfo.remoteLink} answers — the last status pushed, or none. */
export function attachedLinkStatus(): RemoteLinkStatus | null {
  return lastLinkStatus;
}

/**
 * Calls and keystrokes the link lost since it last held (HIVE-140 audit, gap
 * 1) — see {@link RemoteLinkStatus.lost}. Stamped onto every status here rather
 * than threaded through the reconnect loop, which has no reason to know.
 */
let lostSinceHeld = 0;

/** Push a link status, recording it for whoever opens a window next. */
function pushLink(broadcaster: Broadcaster, status: Omit<RemoteLinkStatus, 'lost'> | null): void {
  // Only a window that goes local starts the count over. A reattach keeps it,
  // because that is the moment the chip tells the user to redo what it lists;
  // the chip clears it on a click (HIVE-140 audit, review round 1).
  if (status === null) lostSinceHeld = 0;
  lastLinkStatus = status === null ? null : { ...status, lost: lostSinceHeld };
  broadcaster.emit(CH.remoteLinkStatus, lastLinkStatus);
}

/**
 * One more call or keystroke the link swallowed: count it and re-push the
 * current status so the chip says so now, not at the next transition.
 *
 * The re-push drops `snapshot`: that key means "a reattach just happened, apply
 * this fleet", and repeating it on every lost keystroke would re-hydrate the
 * store from a stale accept frame.
 */
function noteLinkLoss(broadcaster: Broadcaster): void {
  lostSinceHeld += 1;
  if (lastLinkStatus === null) return;
  const next: RemoteLinkStatus = { ...lastLinkStatus, lost: lostSinceHeld };
  delete next.snapshot;
  lastLinkStatus = next;
  broadcaster.emit(CH.remoteLinkStatus, next);
}

/** Test-only: the tracker the proxy feeds, so a spec can drive it. */
export function attachedResumeTracker(): ResumeTracker | null {
  return resumeTracker;
}

/**
 * The fleet the server sent with its accept frame, or `null` when this
 * process is not attached (HIVE-144 review, I1).
 *
 * `RemoteClient.snapshot()` had no production caller before this, so the six
 * `SNAPSHOT_CHANNELS` reads a server performs on every accept were computed,
 * bounded, sent, parsed and dropped. This is where they are picked up:
 * `applySetRemote` calls it either side of the switch, reports what moved as
 * `SetRemoteResult.changed`, and the renderer clears the departed mode's
 * entities and seeds the new one's from it.
 *
 * Reads the module-scope `attached` fresh on every call, exactly as
 * {@link attachedServerName} does and for the same reason.
 */
export function attachedSnapshot(): Readonly<Record<string, unknown>> | null {
  return attached?.snapshot() ?? null;
}

/**
 * Leave `ipcMain` clean, whichever surface was on it.
 *
 * Both, unconditionally, and one function rather than two calls repeated at
 * three sites: the remote proxy binds the same channel *names* the local
 * surface does, so whichever is bound has to be gone before the other can
 * claim them — `ipcMain.handle` refuses a second handler for a channel, which
 * is the throw this whole sequence is built around. Each is a no-op for a
 * surface that is not bound (`resetRemoteProxy` sees a `null` recorder;
 * `resetIpcHandlers` sees an empty one), so "which mode am I in?" is a
 * question this function never has to ask — and therefore never gets wrong.
 *
 * `resetRemoteProxy` is not optional. `registerRemoteProxy` refuses a second
 * registration outright (HIVE-144, Task 9) rather than silently orphaning the
 * previous one's `notify` listeners, so a re-register that skipped this would
 * throw where the caller expects an outcome.
 */
function unbindEverything(): void {
  /*
    First, and before anything is unbound (HIVE-150). A live backoff timer
    outliving this call is the sharpest failure in the reconnect design: the
    user asks to work locally, `config:set-remote` answers — it is
    `PROCESS_LOCAL` precisely so that it can, with the socket dead — and then a
    timer fires seconds later and silently attaches them again. `cancel` also
    invalidates any dial already in flight, which a `clearTimeout` alone could
    not.
  */
  /*
    Before the cancel, and long before the `close()` below: this is what stops
    a deliberate detach being heard as a drop. See {@link stopWatchingClose}.
  */
  stopWatchingClose?.();
  stopWatchingClose = null;
  reattach?.cancel();
  reattach = null;
  resumeTracker = null;
  resetRemoteProxy();
  /*
    `{ flush: true }` is what makes this a switch rather than a teardown
    (HIVE-144, fix round 1). `resetIpcHandlers` finalises every headless run in
    flight and then, by default, *cancels* the `agents.json` write that
    finalisation scheduled — dropping the closed run's `sessionUuid`, so the
    next wake starts a fresh conversation instead of `--resume`-ing. Correct
    for a unit test, whose paths are stubbed; silent data loss for a user who
    attaches, detaches, or merely suffers a failed attach while an agent is
    mid-run. The shutdown hook has always flushed here; this is the second
    production caller, and it makes the same choice.
  */
  resetIpcHandlers({ flush: true });
  /*
    Whoever opened it closes it. `registerRemoteProxy` is handed a client it
    did not open and does not own, so `resetRemoteProxy` correctly leaves it
    alone — which would make a detached socket a leak that outlives every
    window this app has, still holding its half of the server's fan-out. This
    is the one place that knows the socket was opened here.

    Only what *this* module dialled: a client passed straight to `registerIpc`
    by some other caller was never recorded here and is that caller's to close.
  */
  attached?.close();
  attached = null;
}

/** The stored target, for a switch that was not told one. */
function configuredTarget(): { host: string; port: number } {
  const { host, port } = getConfig().remote;
  return { host, port };
}

/**
 * Which arm of {@link SwitchOutcome} a failed dial lands on.
 *
 * `PlaintextRefusedError` — from either of `connectRemote`'s two fences, the
 * host string and the address DNS actually returned — is the one failure whose
 * remedy is "fix the address, or bring the tailnet up", and the settings pane
 * says that beside the address field. Everything else is `connect-failed`:
 * `AttachRefusedError` (the server refused the handshake — a revoked
 * credential, a protocol mismatch), `AttachFrameTooLargeError` (a `resumeFrom`
 * that outgrew `ATTACH_FRAME_MAX_BYTES`, which this client refuses to send
 * because the server would answer `unauthorized` and the pane would blame the
 * credential), and the ordinary transport failures — `ECONNREFUSED`, a
 * handshake timeout, a socket closed mid-attach. Those three have three
 * different remedies and no useful shared code, which is exactly why this arm
 * carries the message and `plaintext-refused` does not.
 */
function outcomeFor(cause: unknown): SwitchOutcome {
  if (cause instanceof PlaintextRefusedError) return { ok: false, reason: 'plaintext-refused' };
  return {
    ok: false,
    reason: 'connect-failed',
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

/**
 * Move this process's IPC between {@link IpcMode}s without a relaunch (HIVE-144).
 *
 * ## The ordering, which is the whole task
 *
 * 1. **Refusals first, while still bound.** A refused switch must change
 *    nothing — not one channel, not the config file. Checking after the unbind
 *    would leave a window with no IPC over a switch that was never going to
 *    happen: an app that looks alive and answers nothing.
 * 2. **Unbind**, both surfaces, unconditionally. `resetRemoteProxy` and
 *    `resetIpcHandlers` are each a no-op for a surface that is not bound, and
 *    calling both is what makes the two directions of this switch one path
 *    rather than two that can drift. `resetRemoteProxy` is not optional:
 *    `registerRemoteProxy` refuses a second registration by design (Task 9),
 *    so a re-register without it throws.
 * 3. **Register the new mode.** If the dial fails, or bringing the new surface
 *    up throws, **rebind local** before returning — the failure arm is the one
 *    that would otherwise leave the window dead, and it is reached far more
 *    often than the success arm on a laptop that has left the tailnet.
 * 4. Only then report success.
 *
 * ## The two directions
 *
 * `remote → local` is never refused. The sessions this client was watching are
 * the *server's*, running on the other machine, and detaching does not touch
 * them — the mini keeps them, this window simply stops showing them. There is
 * nothing to strand and so nothing to refuse over, which is why the
 * `live-sessions` check is inside the `remote` arm rather than above it.
 *
 * `local → remote` is refused while this machine's own sessions are live,
 * because those are PTYs this process owns: unbinding the local surface stops
 * the renderer that was driving them from reaching them at all, and they would
 * keep burning tokens behind a window that can no longer show them.
 *
 * ## The two registration paths
 *
 * Boot (`electron/main/index.ts`) and the settings pane reach the same bound
 * surface because they reach it through this same function — boot binds local
 * first so a window can never open onto nothing, then attaches through here if
 * the config says `remote`. A separate boot-time attach path would be a second
 * description of "what remote mode is bound to", and the difference would only
 * show up after the first switch.
 */
export async function switchIpcMode(
  mode: IpcMode,
  options: SwitchIpcOptions = {},
): Promise<SwitchOutcome> {
  const { broadcaster } = options;

  /*
    `remote → local` has no refusal arm at all — see this function's own doc
    comment. It unbinds and rebinds through the same two calls the other
    direction uses, which is what makes the two directions undo each other
    rather than merely resemble each other.
  */
  if (mode === 'local') {
    /*
      Already local, and already bound: nothing to undo, and undoing it anyway
      would be destructive rather than merely wasteful. `resetIpcHandlers`
      disposes the sessions layer, and that does **not** kill the ptys — it
      **orphans** them. `ptyIpc.dispose()` (`ipc/pty.ts`) only unsubscribes,
      and `registry.clear()` drops the references, so every `claude` this
      machine was running keeps running: still burning tokens, invisible to
      the app, and no longer reachable by anything that could stop it. Worse
      than a leak and worse than a kill. A settings pane committing the
      address field while in local mode — a request whose *effective* mode is
      unchanged — must not pass through here as a teardown.

      Read off the two recorders themselves rather than a remembered mode.
      They are what `ipcMain` actually holds, so they cannot drift from it;
      a `let bound` mirror updated by `registerIpc` would be a second answer
      to "which mode is bound", and the first one to fall out of step would
      win silently.
    */
    if (remoteProxyBindingsSize() === 0 && ipcBindingsSize() > 0) return { ok: true };
    unbindEverything();
    registerIpc('local', { broadcaster });
    /*
      This window has no link now, and it has to be told so (HIVE-150).

      Without this the last `attached` status stands, and every consumer of it
      goes on naming a machine the user has deliberately stopped driving — the
      header chip, the attach pane, and `useAttachedServer`'s callers. That is
      the same staleness this channel exists to end, arriving through the other
      door: not a socket that died unannounced, but a socket this process closed
      on purpose and never mentioned.
    */
    announceNoLink(broadcaster);
    return { ok: true };
  }

  /*
    Step 1. Every refusal, before anything is touched. Nothing below this block
    runs when one fires, which is the property `remote-composition.test.ts`
    asserts by *count* rather than by invoking one channel and finding it alive
    — half an unbound surface answers that one channel too.
  */
  /*
    The interlock, and it is first because it is the one refusal that is about
    this *machine's* role rather than about the moment (HIVE-144 review, I3).

    An install is the server or a client and never a hybrid — `RemoteConfig`'s
    own doc comment — and until this line nothing enforced it. What that cost
    is not a muddle: `unbindEverything()` below stops and drops
    `remoteListener`, which `registerIpcHandlers` builds and which `.start()`
    is called on from exactly one place, inside `whenReady`. A boot attach on
    a serving machine therefore tore the listener down *before* it was ever
    started, and that machine stopped serving permanently — across relaunches,
    with the tray still claiming server mode. `electron/main/server-mode.ts`
    carries the reasoning for refusing rather than preserving the listener.

    `connect-failed` rather than an arm of its own: the pane already renders
    that arm's message verbatim, and the sentence *is* the remedy. Settings
    also disables the control outright on a serving machine
    (`AppInfo.serving`), so this is the fence behind the fence rather than the
    only place a user finds out.
  */
  if (isServerMode()) {
    return {
      ok: false,
      reason: 'connect-failed',
      message:
        'This Hive is serving its own sessions, so it cannot also drive another ' +
        "machine's. An install is the server or the client, never both. Turn " +
        'server mode off and relaunch, then attach.',
    };
  }

  const live = (options.liveSessions ?? (() => sessionsLayer()?.entities() ?? []))();
  /*
    Copied, and in the order the sessions were opened. `entities()` reads a
    `Map`'s keys, so that order is the order they were inserted — a language
    guarantee, not an accident of this implementation — and it is the order a
    pane should list them in. Copied because the caller must not be able to
    mutate the layer's own array through the outcome it was handed.
  */
  if (live.length > 0) return { ok: false, reason: 'live-sessions', sessions: [...live] };

  const target = options.target ?? configuredTarget();
  /*
    Before the switch, not inside it (Ruling 19). `connectRemote` runs this
    same predicate itself and would refuse anyway — but by then this function
    has already unbound the local surface, and a refusal is supposed to cost
    nothing. This is also the check that keeps `config:set-remote` from
    dialling an address it has not validated: the socket is plaintext, so a
    wrong host is a device credential handed to whoever answers.
  */
  if (!isRemoteTarget(target.host)) return { ok: false, reason: 'plaintext-refused' };

  // Step 2.
  unbindEverything();

  /*
    Step 3. The dial and the registration share one `catch`, because both are
    "bring the remote surface up" and either failing leaves exactly the same
    hole: unbound local, nothing in its place.
  */
  let client: RemoteClient | null = null;
  const dial = options.connect ?? connectRemote;
  /*
    Resolved once rather than per registration (HIVE-150). The reconnect loop
    needs a concrete one to push `remote:link-status` through, and
    `createWindowBroadcaster` resolves its windows per emit — so building it
    here rather than inside each `registerIpc` costs nothing and gives both
    halves the same target.
  */
  const pushes = broadcaster ?? createWindowBroadcaster();
  try {
    /*
      Inside the `try`, because it throws for a machine that has never paired
      and that has to surface as the `connect-failed` outcome a pane can render
      — with local rebound, since the unbind has already happened by now —
      rather than as an unhandled rejection in main.
    */
    const credential = requireCredential(options);
    /*
      Built before the dial so the very first client is registered with it
      (HIVE-150). A tracker created afterwards would leave the first
      connection's `pty:data` unrecorded, and the first drop — the one most
      likely to happen while the user is actually watching a terminal — would
      resume from nothing.
    */
    resumeTracker = createResumeTracker();
    client = await dial({
      host: target.host,
      port: target.port,
      credential,
    });
    registerIpc('remote', { client, broadcaster: pushes, resumeTracker });
    // Recorded only once the surface is up, so a registration that threw
    // leaves nothing behind for the next `unbindEverything` to close twice —
    // the catch below closes this attempt's own socket itself.
    attached = client;
    armReattach(client, { host: target.host, port: target.port }, credential, dial, pushes);
  } catch (cause) {
    /*
      Whatever the failed attempt managed to bind, unbound again before local
      claims those channels back. `registerRemoteProxy` refuses before binding
      anything, so this is belt and braces today — and it is the line that
      keeps this catch honest if a future failure arrives from further into the
      registration.
    */
    resetRemoteProxy();
    client?.close();
    registerIpc('local', { broadcaster });
    // A failed attach lands local too, and owes the window the same sentence.
    announceNoLink(broadcaster);
    return outcomeFor(cause);
  }
  return { ok: true };
}

/**
 * Listen for this socket dying, and reconnect when it does (HIVE-150).
 *
 * **One loop per attachment, not one per socket.** The loop owns the reattach
 * epoch, and the renderer keys the effects that own per-surface state on it —
 * so a loop rebuilt for each replacement client would count 1, 1, 1 across
 * successive drops instead of 1, 2, 3, and every reconnect after the first
 * would leave the explorer's watcher and the foreground record stale with
 * nothing on screen to say so. Only the `onClose` subscription is per socket,
 * because `onClose` fires once per connection.
 *
 * **The rebind is the narrow pair, never `unbindEverything`.** That function
 * also disposes the sessions layer and stops the receiver, and calling it here
 * would tear down local machinery a reconnect has no quarrel with — and, on a
 * serving machine, trip the serve-or-attach interlock. What actually needs
 * replacing is the proxy's bindings, which close over the client: they point at
 * the dead socket until they are rebuilt against the live one.
 *
 * The old bindings are deliberately left in place while the loop runs. A call
 * during the gap then rejects promptly with "the connection is closed", which
 * is a better answer than an unbound channel, and there is no window in which
 * the surface is half-bound.
 */
function armReattach(
  client: RemoteClient,
  target: { host: string; port: number },
  credential: StoredDeviceCredential,
  dial: (deps: ConnectRemoteDeps) => Promise<RemoteClient>,
  pushes: Broadcaster,
): void {
  const serverName = client.serverName();

  const loop = createReattachLoop({
    serverName,
    connect: () => {
      /*
        The point of the whole story: a reconnect that names where each watched
        terminal left off, so the server replays what was missed instead of the
        client re-hydrating from nothing. Recomputed per dial rather than
        captured, because which sessions are worth resuming changes while the
        loop is running.

        The key is omitted rather than set to `undefined` when there is nothing
        to resume, for the reason `attachRequest` states: an absent map and an
        empty one mean different things to a server deciding whether to replay.
      */
      const resumeFrom = resumeTracker === null ? undefined : composeResumeFrom(resumeTracker);
      return dial({
        host: target.host,
        port: target.port,
        credential,
        ...(resumeFrom === undefined ? {} : { resumeFrom }),
      });
    },
    onStatus: (status) => {
      pushLink(pushes, status);
    },
    onAttached: (fresh) => {
      resetRemoteProxy();
      registerIpc('remote', { client: fresh, broadcaster: pushes, resumeTracker: resumeTracker ?? undefined });
      attached = fresh;
      // The replacement's own subscription, against the loop that already exists.
      watchForClose(fresh, loop);
      /*
        Re-state the fleet from the accept frame this reattach just received
        (HIVE-150). Everything the server pushed while the socket was down is
        gone — a session that ended still renders as running, notifications
        never reached the inbox, ledger entries and PR sweeps vanished. The
        `attached` status the loop emitted a moment ago carries no snapshot,
        because the loop has no access to one; this is the follow-up that does.
      */
      pushLink(pushes, {
        state: 'attached',
        serverName,
        attempt: 0,
        nextAttemptAt: null,
        reason: null,
        epoch: reattachEpoch,
        snapshot: fresh.snapshot(),
      });
    },
    onWake: subscribeToWake,
    nextEpoch: () => {
      reattachEpoch += 1;
      return reattachEpoch;
    },
  });

  reattach = loop;
  watchForClose(client, loop);
  pushLink(pushes, {
    state: 'attached',
    serverName,
    attempt: 0,
    nextAttemptAt: null,
    reason: null,
    /*
      The epoch this process is currently on, unchanged by a *first* attach —
      nothing needs re-establishing against a surface the renderer has never
      talked to. It climbs only when a socket is replaced, which is exactly when
      the old surface's watcher and focus record went away with it.
    */
    epoch: reattachEpoch,
  } satisfies Omit<RemoteLinkStatus, 'lost'>);
}

/**
 * Tell the window it has no attachment (HIVE-150).
 *
 * `null` rather than a `disconnected` status: that state means "a link ended
 * for a reason retrying cannot fix", which a deliberate detach is not. A window
 * that went local has no link to describe at all, and the chip's answer to that
 * is to render nothing.
 */
function announceNoLink(broadcaster: Broadcaster | undefined): void {
  pushLink(broadcaster ?? createWindowBroadcaster(), null);
}

/**
 * Hands one connection's ending to the loop that outlives it.
 *
 * The unsubscribe is kept so a *deliberate* close can drop it first — see
 * {@link stopWatchingClose}.
 */
function watchForClose(client: RemoteClient, loop: ReattachLoop): void {
  stopWatchingClose = client.onClose((cause) => {
    loop.begin(cause);
  });
}

/**
 * Tell the loop when this machine wakes from sleep (HIVE-150).
 *
 * The only place in `electron/` that touches `powerMonitor`. It is imported at
 * module scope, like `broadcaster.ts` imports `BrowserWindow`, but **read at
 * call time** — see the body. The distinction matters: the import is harmless
 * before the app is ready, dereferencing the object is not, and a unit test's
 * `electron` mock supplies only the surface that test needs.
 *
 * Failing to subscribe is not an error worth propagating. The loop still
 * reconnects on its own schedule — a wake only saves it from waiting out the
 * thirty-second step it happened to be parked on.
 */
function subscribeToWake(listener: () => void): () => void {
  /*
    Read at call time rather than destructured at import. `electron` is imported
    at module scope here the way `broadcaster.ts` imports it, but a unit test's
    `electron` mock supplies only the surface that test needs — and a mock
    without `powerMonitor` must leave the loop working rather than throw while
    arming it.
  */
  const monitor: Electron.PowerMonitor | undefined = powerMonitor;
  if (monitor === undefined) return () => undefined;

  monitor.on('resume', listener);
  return () => {
    monitor.removeListener('resume', listener);
  };
}

/**
 * The stored device credential, or a failure that reads as one.
 *
 * A missing credential is `connect-failed` rather than an arm of its own: it
 * is a state a *paired* machine cannot be in, the union the plan pinned has no
 * arm for it, and the sentence below is the whole remedy. Thrown rather than
 * returned so it lands on {@link switchIpcMode}'s own rebind-local catch —
 * there is exactly one path back from a half-torn-down surface and every
 * failure has to take it.
 */
function requireCredential(options: SwitchIpcOptions): StoredDeviceCredential {
  /*
    `!== undefined`, never `??`: an explicit `null` means "this caller has
    already looked and there is none", and `??` would treat it as "unset" and
    go to the store behind the caller's back.
  */
  const credential =
    options.credential !== undefined ? options.credential : readRemoteCredential();
  if (credential === null) {
    throw new Error(
      'This machine has no device credential for the server it was asked to attach to. ' +
        'Pair with it first — the server mints the credential, and pairing stores it here.',
    );
  }
  return credential;
}

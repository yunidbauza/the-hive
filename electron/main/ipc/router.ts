import { isRemoteTarget, type SwitchOutcome } from '@shared/config-contract';

import {
  PlaintextRefusedError,
  connectRemote,
  type ConnectRemoteDeps,
  type RemoteClient,
} from '../../remote-client/socket';
import type { StoredDeviceCredential } from '../../remote-client/token-store';
import { getConfig } from '../config';

import { createWindowBroadcaster, type Broadcaster } from './broadcaster';
import { registerRemoteProxy, remoteProxyBindingsSize, resetRemoteProxy } from './remote-proxy';

import {
  ipcBindingsSize,
  readRemoteCredential,
  registerIpcHandlers,
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
    registerRemoteProxy({
      client: options.client,
      broadcaster: options.broadcaster ?? createWindowBroadcaster(),
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
  registerIpcHandlers(options.broadcaster, switchIpcMode, attachedServerName);
}

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
    return { ok: true };
  }

  /*
    Step 1. Every refusal, before anything is touched. Nothing below this block
    runs when one fires, which is the property `remote-composition.test.ts`
    asserts by *count* rather than by invoking one channel and finding it alive
    — half an unbound surface answers that one channel too.
  */
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
  try {
    client = await (options.connect ?? connectRemote)({
      host: target.host,
      port: target.port,
      credential: requireCredential(options),
    });
    registerIpc('remote', { client, broadcaster });
    // Recorded only once the surface is up, so a registration that threw
    // leaves nothing behind for the next `unbindEverything` to close twice —
    // the catch below closes this attempt's own socket itself.
    attached = client;
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
    return outcomeFor(cause);
  }
  return { ok: true };
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

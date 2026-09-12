import { containsPath } from '@lib/explorer/session-root';
import type {
  AddProjectRequest,
  BrowseListing,
  CommandDiagnostic,
  ConfigSnapshot,
  DiagnoseCommandRequest,
  DiagnoseEnvRequest,
  EnvDiagnostic,
  ModeChange,
  ProjectConfig,
  ProjectStatus,
  RemotePairRequest,
  RemoveProjectRequest,
  RenameProjectRequest,
  ReorderProjectsRequest,
  RepointProjectRequest,
  SetJiraRequest,
  SetNotificationsRequest,
  SetDisabledSessionPluginsRequest,
  SetProjectAutoMergeRequest,
  SetProjectKeyRequest,
  SetProjectRuntimeRequest,
  SetReceiverRequest,
  SetRemoteRequest,
  SetRuntimeRequest,
  SetServerRequest,
  SwitchOutcome,
} from '@shared/config-contract';
import type { FsResult } from '@shared/fs-contract';
import type {
  AppInfo,
  IntegrationsStatus,
  LoginEnvStatus,
  NotificationDeliveryStatus,
  LocalRemoteState,
} from '@shared/ipc-contract';

/**
 * The workspace config, as the renderer sees it (story 090).
 *
 * A module with a subscription rather than a Zustand store, deliberately. The
 * two stores are split along "what the user is looking at" versus "what the
 * system knows" (`AGENTS.md`), and this is neither — it is a fact about the
 * *machine*, read once from main, never mutated here, and consumed by exactly
 * two surfaces. Putting it in `hive-store` would mean fixture data and
 * filesystem truth sharing one reducer, which is the confusion story 090's
 * scope discipline is trying to avoid.
 *
 * It lives in `src/lib/` so `src/config/runtime.ts` can consult it without
 * importing a store, and so the ESLint zones keep it out of reach of
 * `src/components/terminal/`.
 */

let snapshot: ConfigSnapshot | null = null;
const listeners = new Set<() => void>();

/**
 * The server a socket is open to right now, or `null` — `AppInfo.attachedServerName`,
 * cached here so a synchronous predicate can read it (HIVE-144 review, C1).
 *
 * **Runtime, never config.** `config:get` is proxied while attached, so
 * `snapshot.remote.mode` above is the *server's* answer, and a server is not
 * attached to anyone: it reads `'local'` on exactly the window that is
 * attached. Every gate that asked the snapshot that question got the wrong
 * answer in the one state it existed for — the defect Ruling 29 closed in the
 * settings pane, closed here too. `AppInfo` is `PROCESS_LOCAL`, so this value
 * is answered by *this* process in both modes.
 *
 * Kept beside the snapshot rather than in a store because its one consumer is
 * `src/config/runtime.ts`, which may not import a store, and because it moves
 * for exactly one reason: a mode switch, which also replaces the snapshot. See
 * {@link install}.
 */
let attachment: string | null = null;

function emit(): void {
  // Copied before iterating: a listener that unsubscribes during the emit is
  // the ordinary React teardown case, not an edge case.
  for (const listener of [...listeners]) listener();
}

/**
 * Re-ask *this* process whether a socket is open, and emit if the answer moved.
 *
 * Guarded on a change rather than emitting unconditionally: this runs after
 * every config write, and the answer moves only on a mode switch, so an
 * unguarded emit would re-render every subscriber on each save for a value
 * that did not change.
 */
async function refreshAttachment(): Promise<void> {
  const info = await readAppInfo();
  const next = info?.attachedServerName ?? null;
  if (next === attachment) return;
  attachment = next;
  emit();
}

/**
 * Install a snapshot and re-derive the attachment alongside it.
 *
 * Used by the two paths that can change which process answers this window:
 * {@link read}, which is boot and reload, and {@link setRemoteConfig}, which
 * is the switch itself. Nothing else here can move it — see {@link mutate}.
 *
 * Awaited rather than fired and forgotten: every caller already returns a
 * promise the app treats as "the config read is done", and a gate that
 * answered from a stale attachment for one more round trip after that is the
 * same silent failure this whole fix is about.
 */
async function install(next: ConfigSnapshot | null): Promise<void> {
  snapshot = next;
  emit();
  await refreshAttachment();
}

/**
 * The name of the server this window is attached to, or `null` (HIVE-144).
 *
 * Synchronous, because its consumer is: `can.*` in `src/config/runtime.ts` are
 * plain predicates an event handler calls without a hook. Components that
 * *render* a disabled state go through `useRemoteCapabilities`, which
 * subscribes to this module for the re-render {@link refreshAttachment}
 * triggers.
 */
export function attachedServerNow(): string | null {
  return attachment;
}

/** `useSyncExternalStore`'s subscribe. Returns its own disposer. */
export function subscribeProjectConfig(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The current snapshot, or `null` when there is none.
 *
 * `null` means one of two things and deliberately does not distinguish them:
 * the browser demo has no bridge to ask, and the desktop app has not finished
 * asking yet. Both should behave identically — see {@link projectAccess}.
 */
export function projectConfigSnapshot(): ConfigSnapshot | null {
  return snapshot;
}

async function read(
  fetch: (bridge: NonNullable<Window['hive']>) => Promise<ConfigSnapshot>,
): Promise<void> {
  const bridge = window.hive;
  // No bridge is the browser demo, not a failure. Story 083's rule: feature-
  // detect the bridge, never the user agent.
  if (!bridge) return;

  let next: ConfigSnapshot | null;
  try {
    next = await fetch(bridge);
  } catch (cause) {
    // Main never rejects a *read* — it returns a snapshot even for a malformed
    // file. A rejection here means the channel itself failed, which is not
    // something the user can fix by editing their config, so the surfaces stay
    // permissive rather than locking the app over a broken IPC hop.
    console.error('[hive] could not read the workspace config:', cause);
    next = null;
  }
  await install(next);
}

/**
 * Run a mutating verb, keeping the last good snapshot if it is refused.
 *
 * Separate from {@link read} because the two failures mean opposite things. A
 * failed read is a broken channel, and story 090 decided that must leave the
 * app permissive rather than locked. A failed **write** says only that the
 * write did not happen — nothing on disk changed, so the snapshot the renderer
 * already holds is still exactly true.
 *
 * Clearing it here was a real bug: story 103's payload guards throw, and
 * `handle` does not catch, so a refused mutation rejects the invoke. That is
 * reachable without malice — a config holding two entries with the same id
 * renders two rows, and reordering posts a duplicate the guard refuses. The
 * settings list emptied, and `projectAccess` (permissive with no snapshot, by
 * design) reopened the spawn gate for every project until a reload.
 */
async function mutate(
  call: (bridge: NonNullable<Window['hive']>) => Promise<ConfigSnapshot>,
): Promise<void> {
  const bridge = window.hive;
  if (!bridge) return;

  try {
    snapshot = await call(bridge);
  } catch (cause) {
    console.error('[hive] the workspace config was not written:', cause);
  }
  // Not {@link install}: no mutating verb in this module can change which
  // process answers this window's IPC — only `config:set-remote` can, and it
  // does not come through here — so re-deriving the attachment on every save
  // would be an `app:info` round trip per write for a value that cannot have
  // moved.
  emit();
}

/**
 * How the boot read backs off when it lands on an unbound channel (HIVE-144
 * review, M8) — 250 ms, doubling, seven attempts, so the last one is about
 * 16 s after the first.
 *
 * Sized against what it is waiting out. A boot attach unbinds the local
 * surface *before* it dials, and `CLIENT_ATTACH_TIMEOUT_MS` bounds that dial
 * at 10 s — after which `switchIpcMode` rebinds local and `config:get` starts
 * answering again. A window shorter than that would give up while the app is
 * still on its way to being usable; a fixed short interval would spend seven
 * reads inside the first two seconds and miss the same moment.
 *
 * Exported so the test asserts against the real schedule rather than a
 * duplicated magic number, exactly as `LATE_BIND_RETRY_MS` is.
 */
export const BOOT_READ_BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;

/**
 * Ask main for the config, retrying while the answer has not landed
 * (HIVE-144 review, M8).
 *
 * A single unretried read raced the boot dial. `switchIpcMode('remote')`
 * unbinds every local channel synchronously and only rebinds when the dial
 * settles, so a `config:get` issued in that window rejects — and {@link read}
 * correctly treats a broken channel as "stay permissive", which leaves the
 * snapshot `null` **permanently**, until someone finds the Reload button in a
 * pane the snapshot being `null` renders as an empty state. It compounds with
 * the dial having had no deadline at all before this review round.
 *
 * Retries only while the snapshot is still `null`, so a read that succeeded
 * costs nothing extra, and never in the browser demo, where the absence of a
 * bridge is the answer rather than a failure to get one.
 *
 * Not shared with {@link reloadProjectConfig}: that one is a user pressing a
 * button and watching for a result, so a failure should be visible at once
 * rather than retried behind a UI that looks like it is doing nothing.
 */
export async function loadProjectConfig(): Promise<void> {
  await read((bridge) => bridge.config.get());

  for (const delay of BOOT_READ_BACKOFF_MS) {
    // `window.hive` rather than a captured flag: the browser demo has no
    // bridge and never will, and there is nothing here to wait for.
    if (snapshot !== null || window.hive === undefined) return;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    await read((bridge) => bridge.config.get());
  }
}

/** Re-read the file the user just edited, without restarting the app. */
export const reloadProjectConfig = (): Promise<void> =>
  read((bridge) => bridge.config.reload());

/**
 * Add a directory the user chose (story 101).
 *
 * No reload follows. Every mutating verb returns the fresh snapshot, and
 * `mutate` installs it — which is the whole reason the contract is shaped that
 * way: the renderer can never render a list the write already invalidated.
 */
export const addProjectToConfig = (request: AddProjectRequest): Promise<void> =>
  mutate((bridge) => bridge.config.addProject(request));

/**
 * Change the top-level shell or agent command (story 104).
 *
 * Same `mutate` path as every other write: main returns the fresh snapshot and
 * it becomes what the UI renders, so there is no optimistic value here to
 * reconcile if the write is refused.
 */
export const setRuntimeConfig = (request: SetRuntimeRequest): Promise<void> =>
  mutate((bridge) => bridge.config.setRuntime(request));

/**
 * Change one project's overrides (story 104).
 *
 * `null` clears an override; an absent field is untouched. The distinction is
 * preserved all the way from the input to the file, which is what lets the UI
 * save the shell field without disturbing an env map it is not showing.
 */
export const setProjectRuntimeConfig = (
  request: SetProjectRuntimeRequest,
): Promise<void> =>
  mutate((bridge) => bridge.config.setProjectRuntime(request));

/**
 * Change which events raise an OS notification (story 106).
 *
 * The same `mutate` path as every other write. Only the classes named are
 * touched, so a section that saves one switch cannot restate another.
 */
export const setNotificationPrefs = (
  request: SetNotificationsRequest,
): Promise<void> => mutate((bridge) => bridge.config.setNotifications(request));

/**
 * Change the Jira site and account email (HIVE-67).
 *
 * Here rather than in `lib/jira.ts` because it writes the config file and
 * returns a `ConfigSnapshot`, so it needs this module's `mutate` to install the
 * fresh one — the same path every other settings write takes. The *token* lives
 * in `lib/jira.ts`, because it is not config and does not produce a snapshot.
 *
 * `null` clears a field; an absent field is untouched, so saving the site never
 * restates the email.
 */
export const setJiraConnection = (request: SetJiraRequest): Promise<void> =>
  mutate((bridge) => bridge.config.setJira(request));

/**
 * Change the container host alias (HIVE-131).
 *
 * Routed through `mutate` like every other settings write, so the fresh snapshot
 * main returns becomes the one every subscriber reads. Nothing consumes the
 * alias yet — HIVE-132 is what bakes it into a container session's generated
 * files — so this write is durable configuration rather than a live switch.
 */
export const setReceiverConfig = (
  request: SetReceiverRequest,
): Promise<void> => mutate((bridge) => bridge.config.setReceiver(request));

/**
 * Turn server mode on or off, and change where it listens (HIVE-142).
 *
 * Routed through `mutate` like every other settings write, so the fresh
 * snapshot main returns — `enabled` and `bind`, never a credential — is what
 * the switch and the bind fields render. `bind` takes effect at next launch,
 * exactly as {@link setReceiverConfig}'s does.
 */
export const setServerConfig = (request: SetServerRequest): Promise<void> =>
  mutate((bridge) => bridge.config.setServer(request));

/**
 * Mint a device credential named `name`, and answer its plaintext once
 * (HIVE-142).
 *
 * Not routed through `mutate`: `server:pair` does not return a
 * `ConfigSnapshot`, it returns the one-time secret. The snapshot is re-read
 * afterward so the caller's device list picks up the new entry without a
 * manual Reload — the same reason every mutating verb elsewhere returns its
 * own fresh snapshot, reached here by one extra read instead.
 *
 * `{ error }` on a refusal — a duplicate name, or a credential that could not
 * be minted uniquely — rather than a rejected promise, so the settings pane
 * can show the reason inline the same way the server-mode tray does.
 *
 * The plaintext token is the return value and nothing else. It is never
 * logged, and this function never writes it anywhere the caller did not ask
 * for it.
 *
 * The pair itself and the snapshot re-read are two separate `try` blocks,
 * deliberately (review finding, Minor 1). A device that minted successfully
 * is already on disk — a `config:get` that then fails (a closed window, a
 * broken channel) must not turn that success into `{ error: 'Pairing failed.' }`,
 * which would send the caller to retry a name `server:pair` now refuses as a
 * duplicate. The outcome from `server:pair` is captured and returned
 * regardless of whether the re-read lands.
 */
export async function pairDevice(
  name: string,
): Promise<{ token: string; deviceId: string } | { error: string }> {
  const bridge = window.hive;
  if (!bridge) return { error: 'No bridge available.' };

  let outcome: { token: string; deviceId: string } | { error: string };
  try {
    outcome = await bridge.server.pair({ name });
  } catch (cause) {
    console.error('[hive] could not pair a device:', cause);
    return { error: 'Pairing failed.' };
  }

  if ('token' in outcome) {
    try {
      snapshot = await bridge.config.get();
    } catch (cause) {
      console.error(
        '[hive] paired a device, but could not refresh the config afterward:',
        cause,
      );
    }
    emit();
  }

  return outcome;
}

/**
 * Revoke the device named `name` (HIVE-142).
 *
 * Answers `{ ok } | { error }` rather than `void` (review finding, Important)
 * so the pane can say why a Revoke click did nothing — the most urgent
 * control on this whole surface must not fail silently. The snapshot is
 * re-read afterward for the same reason {@link pairDevice} reads it:
 * revoking has to reach the caller's device list — the list `ServerModeGroup`
 * renders — without a manual Reload, and this verb returns no snapshot of
 * its own to install.
 *
 * The revoke and the snapshot re-read are two separate `try` blocks, for the
 * same reason {@link pairDevice}'s are: a revoke that actually landed must be
 * reported as `{ ok: true }` even if the follow-up read fails.
 *
 * `bridge.server.revoke`'s own resolved value is inspected now (HIVE-142
 * review, I7), not discarded — main can answer `{ error }` for a name that
 * matches nothing (a hand-edit or a rename since boot) or a config write
 * that did not land, and this used to report `{ ok: true }` unconditionally
 * the instant the promise resolved, whatever main actually said.
 */
export async function revokeDevice(
  name: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const bridge = window.hive;
  if (!bridge) return { ok: false, error: 'No bridge available.' };

  let outcome: { revoked: true } | { error: string };
  try {
    outcome = await bridge.server.revoke({ name });
  } catch (cause) {
    console.error('[hive] could not revoke the device:', cause);
    return { ok: false, error: 'Could not revoke the device. Try again.' };
  }

  if ('error' in outcome) return { ok: false, error: outcome.error };

  try {
    snapshot = await bridge.config.get();
  } catch (cause) {
    console.error(
      '[hive] revoked a device, but could not refresh the config afterward:',
      cause,
    );
  }
  emit();
  return { ok: true };
}

/**
 * Turn client mode on or off, and change where it attaches (HIVE-144).
 *
 * Not routed through {@link mutate}: `config:set-remote` answers a
 * {@link SetRemoteResult}, not a bare `ConfigSnapshot`, because the verb also
 * *performs* the switch and the switch can be refused (Ruling 19). The
 * snapshot half is installed unconditionally — it is the old one, untouched,
 * whenever the switch is not `ok`, so installing it always is exactly as safe
 * as installing it only on success, and simpler than branching to skip a copy
 * that would be identical anyway.
 *
 * The caller renders {@link SwitchOutcome} — the returned half this function
 * does not swallow — because Ruling 19 is a promise about the *file*, not
 * about what the pane may claim: a refused switch must not present the
 * address that was just tried as saved, and the only way the pane can avoid
 * that is by reading what actually happened rather than assuming success.
 *
 * `{ ok: false, reason: 'connect-failed', message }` on no bridge or a broken
 * channel, matching the shape a real dial failure already takes, so the pane
 * has exactly one failure branch to render instead of a second one for "the
 * IPC itself did not work."
 *
 * ## `changed` is passed through, not acted on here (HIVE-144 review, I1)
 *
 * The fleet on screen belongs to the machine that was just left, and clearing
 * it is a **store** operation — `clearModeEntities` then `applyAttachSnapshot`.
 * This module cannot perform it: `hive-store` reaches `@config/runtime`, which
 * reaches this file, so importing the store from here would close a cycle
 * `import/no-cycle` fails the build over. So the answer is handed up, and the
 * caller applies it through `useApplyModeChange` — one named store action, so
 * the ordering of the two steps lives in one place rather than at each call.
 */
export async function setRemoteConfig(
  request: SetRemoteRequest,
): Promise<RemoteSwitch> {
  const bridge = window.hive;
  if (!bridge) {
    return {
      switched: { ok: false, reason: 'connect-failed', message: 'No bridge available.' },
      changed: null,
    };
  }

  try {
    const result = await bridge.config.setRemote(request);
    /*
      **The returned snapshot is this machine's, so installing it while a socket
      is still open would replace the whole app's view of the fleet (HIVE-149).**

      `config:set-remote` is `PROCESS_LOCAL`, so main answers it here and hands
      back *this* machine's `ConfigSnapshot`. That is right for the two calls
      that switch mode — the window is becoming local, or has just become
      remote and `applyModeChange` is about to run off `changed`.

      It is wrong for a **write-only** commit, which is a thing only since
      HIVE-149 un-hid the address fields while attached. There `changed` is
      `null`, nothing switched, the socket is still open, and installing would
      publish this Mac's projects, Jira and Slack values to every
      `useProjectConfig()` consumer while their writes still proxy to the
      server — and nothing would put the server's snapshot back until a manual
      Reload, a detach or a relaunch.

      So the install is gated on the two states where it is the point: a mode
      actually changed, or this window is not attached (where the returned
      snapshot is the only one there is). The commit still lands on disk either
      way; what is withheld is republishing it as the app's current config.
    */
    if (result.changed !== null || attachment === null) await install(result.config);
    return { switched: result.switched, changed: result.changed };
  } catch (cause) {
    console.error('[hive] the attach switch did not complete:', cause);
    return {
      switched: {
        ok: false,
        reason: 'connect-failed',
        message: 'The request could not be sent.',
      },
      changed: null,
    };
  }
}

/**
 * What {@link setRemoteConfig} hands back — {@link SetRemoteResult} minus the
 * snapshot, which this module installs rather than returning.
 *
 * Two fields because they answer different questions and can disagree: a
 * write-only commit succeeds (`switched.ok`) while changing no mode at all
 * (`changed === null`), and that is the case finding 6 exists about.
 */
export interface RemoteSwitch {
  switched: SwitchOutcome;
  changed: ModeChange | null;
}

/**
 * Store the device credential a `server:pair` mint on some *other* Hive
 * handed back (HIVE-144).
 *
 * Not routed through {@link mutate}: `remote:pair` writes no config, so there
 * is no snapshot to install — the credential lives in `safeStorage`, never in
 * `config.json`. `{ error }` on a refusal (most likely a locked keychain) is
 * passed straight through so the pane can show it beside the pairing fields,
 * matching {@link pairDevice}'s own shape for the opposite direction.
 */
export async function pairRemoteDevice(
  request: RemotePairRequest,
): Promise<{ paired: true } | { error: string }> {
  const bridge = window.hive;
  if (!bridge) return { error: 'No bridge available.' };

  try {
    return await bridge.remote.pair(request);
  } catch (cause) {
    console.error('[hive] could not store the device credential:', cause);
    return { error: 'Pairing failed.' };
  }
}

/**
 * Discard the credential {@link pairRemoteDevice} stored (HIVE-144).
 *
 * Idempotent and writes no config, so there is nothing to install — a no-op
 * with no bridge, matching every other verb in this module that touches
 * nothing on disk.
 */
export async function forgetRemoteDevice(): Promise<void> {
  const bridge = window.hive;
  if (!bridge) return;

  try {
    await bridge.remote.forget();
  } catch (cause) {
    console.error('[hive] could not forget the device credential:', cause);
  }
}

/**
 * What this machine's `gh` looks like (story 106).
 *
 * Not routed through `mutate` — it writes nothing, so there is no snapshot to
 * install. Returns `null` with no bridge (the browser demo) or on a failed
 * channel, and the caller says so rather than rendering a fabricated verdict.
 */
export async function readIntegrationsStatus(): Promise<IntegrationsStatus | null> {
  const bridge = window.hive;
  if (!bridge) return null;

  try {
    return await bridge.integrations.status();
  } catch (cause) {
    console.error('[hive] reading integrations status failed:', cause);
    return null;
  }
}

/**
 * The environment this app searched, without asking about `gh`.
 *
 * A separate verb rather than `readIntegrationsStatus().loginEnv`, because that
 * one executes `gh` twice through `spawnSync` and blocks main while it does —
 * a price the Runtime pane has no reason to pay for a value resolved at boot.
 *
 * Returns `null` on the two cases the caller must tell apart from a slow
 * answer: no bridge (the browser demo) and a failed channel.
 */
export async function readLoginEnvStatus(): Promise<LoginEnvStatus | null> {
  const bridge = window.hive;
  if (!bridge) return null;

  try {
    return await bridge.integrations.loginEnv();
  } catch (cause) {
    console.error('[hive] reading login-shell environment failed:', cause);
    return null;
  }
}

/**
 * Whether the OS is actually accepting desktop notifications.
 *
 * Deliberately **not** read off {@link readIntegrationsStatus}, which carries
 * the same two facts: that one executes `gh` to build the rest of its answer,
 * and this is the value the Notifications pane has to re-ask on a timer,
 * because a refusal is only knowable once a delivery has been attempted and
 * turned down. Polling the other verb would spawn a subprocess every few
 * seconds to read a variable.
 *
 * `null` with no bridge — the browser demo has no OS to ask, and the pane
 * renders its controls without a verdict rather than inventing one.
 */
export async function readNotificationDelivery(): Promise<NotificationDeliveryStatus | null> {
  const bridge = window.hive;
  if (!bridge) return null;

  try {
    return await bridge.notifications.delivery();
  } catch (cause) {
    console.error('[hive] reading notification delivery status failed:', cause);
    return null;
  }
}

/**
 * Show the config file in the OS file manager (story 107).
 *
 * Not routed through `mutate`: it writes nothing and returns no snapshot, so
 * there is nothing to install. Silent with no bridge — the browser demo has no
 * file manager to open, and story 083's rule is to feature-detect the bridge
 * rather than the user agent.
 *
 * A failure is logged rather than surfaced. The only thing that can go wrong is
 * that the OS declined to open a window, and there is nothing the user could do
 * about that in this pane which the path printed above the button has not
 * already given them.
 */
export async function revealConfigFile(): Promise<void> {
  const bridge = window.hive;
  if (!bridge) return;

  try {
    await bridge.config.revealConfig();
  } catch (cause) {
    console.error('[hive] could not reveal the config file:', cause);
  }
}

/**
 * Put the config file back to the first-run template (story 107).
 *
 * Routed through `mutate` like every other write, which is what makes a refused
 * reset leave the last good snapshot in place rather than emptying the UI's
 * project list over a write that never happened — the bug story 103 fixed, and
 * the whole reason `mutate` exists separately from `read`.
 */
export const resetConfigToTemplate = (): Promise<void> =>
  mutate((bridge) => bridge.config.resetConfig());

/**
 * Versions, platform, log directory and PTY counters (story 107).
 *
 * Not routed through `mutate` — it writes nothing, so there is no snapshot to
 * install. `null` with no bridge (the browser demo) or on a failed channel, and
 * the caller says so rather than rendering fabricated version numbers: a
 * diagnostics pane that invented an answer would be worse than no pane.
 *
 * Asked on demand rather than subscribed to. `appInfo` is `invoke`-only and
 * there is no push channel for the counters, so the pane carries an explicit
 * refresh — see `advanced-section.tsx` for why polling was rejected.
 */
export async function readAppInfo(): Promise<AppInfo | null> {
  const bridge = window.hive;
  if (!bridge) return null;

  try {
    return await bridge.appInfo();
  } catch (cause) {
    console.error('[hive] reading app info failed:', cause);
    return null;
  }
}

/**
 * This machine's own `remote` block (HIVE-149).
 *
 * Deliberately *not* read off the snapshot this module installs, which is the
 * whole reason the channel exists: while attached, `config:get` is answered by
 * the server, so `ConfigSnapshot.remote` describes the far end — whose own
 * `mode` reads `local`, because the server is the thing being attached to.
 * `config:get-remote` is `PROCESS_LOCAL` and describes this window.
 *
 * Asked on demand rather than subscribed to, exactly as {@link readAppInfo} is
 * and for the same reason: there is no push channel for it, and the two things
 * that change it — a mode switch and a config reload — both already re-render
 * whatever asked.
 *
 * `null` when there is no bridge (the browser demo) or the channel fails, so a
 * caller shows what it already had rather than an address this machine never
 * stated.
 */
export async function readLocalRemote(): Promise<LocalRemoteState | null> {
  const bridge = window.hive;
  if (!bridge) return null;

  try {
    return await bridge.config.getRemote();
  } catch (cause) {
    console.error('[hive] reading the local remote block failed:', cause);
    return null;
  }
}

/**
 * Ask why the agent command was not found (story 104).
 *
 * Not routed through `mutate`: it writes nothing, so there is no snapshot to
 * install. Returns `null` when there is no bridge (the browser demo) or the
 * channel fails, and the caller renders nothing rather than a fake verdict —
 * a diagnostic that invented an answer would be worse than no diagnostic.
 */
export async function diagnoseAgentCommand(
  request: DiagnoseCommandRequest,
): Promise<CommandDiagnostic | null> {
  const bridge = window.hive;
  if (!bridge) return null;

  try {
    return await bridge.config.diagnoseCommand(request);
  } catch (cause) {
    console.error('[hive] the command diagnostic failed:', cause);
    return null;
  }
}

/**
 * Ask which configured environment variables survived the shell's rc file
 * (story 108).
 *
 * Not routed through `mutate`: it writes nothing, so there is no snapshot to
 * install. Returns `null` when there is no bridge (the browser demo) or the
 * channel fails, and the caller renders nothing rather than a fake verdict —
 * for the identical reason {@link diagnoseAgentCommand} does.
 */
export async function diagnoseSessionEnv(
  request: DiagnoseEnvRequest,
): Promise<EnvDiagnostic | null> {
  const bridge = window.hive;
  if (!bridge) return null;

  try {
    return await bridge.config.diagnoseEnv(request);
  } catch (cause) {
    console.error('[hive] the environment diagnostic failed:', cause);
    return null;
  }
}

/** Remove one entry by id (story 101). */
export const removeProjectFromConfig = (
  request: RemoveProjectRequest,
): Promise<void> => mutate((bridge) => bridge.config.removeProject(request));

/**
 * Change a project's display name (story 103).
 *
 * Routed through `mutate` like every other mutating verb, so the snapshot main
 * returns is the one the UI renders. There is deliberately no optimistic name
 * held here to reconcile — that is the whole reason the contract returns a
 * snapshot instead of a status.
 */
export const renameProjectInConfig = (
  request: RenameProjectRequest,
): Promise<void> => mutate((bridge) => bridge.config.renameProject(request));

/**
 * Change a project's typing alias (HIVE-94).
 *
 * Refused by main when another project already holds the key — which arrives,
 * like every other refusal, as the returned snapshot's `errors`. The editor
 * checks for a duplicate too, but that check is the courtesy: main has the file
 * and the renderer has a snapshot that a hand edit may already have outdated.
 */
export const setProjectKeyInConfig = (
  request: SetProjectKeyRequest,
): Promise<void> => mutate((bridge) => bridge.config.setProjectKey(request));

/** Set the plugins a Hive session does not load (HIVE-176). */
export const setDisabledSessionPluginsInConfig = (
  request: SetDisabledSessionPluginsRequest,
): Promise<void> => mutate((bridge) => bridge.config.setDisabledSessionPlugins(request));

/** Turn unattended merging on or off for one project (HIVE-166). */
export const setProjectAutoMergeInConfig = (
  request: SetProjectAutoMergeRequest,
): Promise<void> => mutate((bridge) => bridge.config.setProjectAutoMerge(request));

/** Point a project at a folder that moved (story 103). */
export const repointProjectInConfig = (
  request: RepointProjectRequest,
): Promise<void> => mutate((bridge) => bridge.config.repointProject(request));

/**
 * Rewrite the project order (story 103).
 *
 * The whole ordering, because main refuses one that is not a permutation of the
 * file on disk — see {@link ReorderProjectsRequest}.
 */
export const reorderProjectsInConfig = (
  request: ReorderProjectsRequest,
): Promise<void> => mutate((bridge) => bridge.config.reorderProjects(request));

/**
 * Open the native directory dialog (story 101).
 *
 * Resolves `null` when the user cancelled *and* when there is no bridge — the
 * browser demo has no filesystem to offer, and story 083's rule is to
 * feature-detect the bridge rather than the user agent. The caller treats both
 * the same way: no path, no write.
 */
export const chooseProjectDirectory = async (): Promise<string | null> => {
  const bridge = window.hive;
  if (!bridge) return null;
  return bridge.config.chooseDirectory();
};

/**
 * List one directory on the machine that answers config calls (HIVE-146).
 *
 * While attached that is the **server**, which is the whole reason this exists
 * beside {@link chooseProjectDirectory}: a native dialog opened on a machine
 * nobody is sitting at helps no one, so the renderer asks for a listing and
 * draws the picker itself.
 *
 * `null` with no bridge, the same answer {@link chooseProjectDirectory} gives
 * and for the same reason — the browser target has no filesystem to offer, and
 * the picker is never reachable there.
 *
 * Note what is *not* here: no try/catch. An `FsResult` already carries a
 * refusal as a value, so the only way this rejects is a broken channel, and the
 * picker renders that as the failure it is rather than an empty folder.
 */
export const browseServerDirectory = async (
  path: string,
): Promise<FsResult<BrowseListing> | null> => {
  const bridge = window.hive;
  if (!bridge) return null;
  return bridge.config.browseDirectory({ path });
};

/**
 * Install a snapshot main pushed with an event (story 102).
 *
 * The mutating *verbs* return their snapshot and `mutate` installs it, which is
 * what stops the renderer rendering a list a write already invalidated. A clone
 * concludes on an **event** instead — it finishes long after the call that
 * started it returned — so its snapshot needs the same treatment, or the
 * project list stays exactly as stale as it would have been without the rule.
 */
export function installProjectConfig(next: ConfigSnapshot): void {
  snapshot = next;
  emit();
}

/** Test-only: drop the snapshot, the attachment and every subscriber. */
export function resetProjectConfig(): void {
  snapshot = null;
  attachment = null;
  listeners.clear();
}

/** Test-only: install a snapshot without going through the bridge. */
export function setProjectConfigForTest(next: ConfigSnapshot | null): void {
  snapshot = next;
  emit();
}

/**
 * Test-only: put this window in the attached state without a bridge or a
 * socket (HIVE-144 review, C1).
 *
 * Separate from {@link setProjectConfigForTest} because the two are separate
 * facts, and conflating them is the defect that fix closes: a *real* attached
 * client holds the **server's** snapshot, whose `remote.mode` reads `'local'`.
 * A suite that proves an attached-state behaviour by installing a snapshot
 * saying `'remote'` is describing a state no window can be in — so it sets
 * this instead, and leaves the snapshot as the server's.
 */
export function setAttachedServerForTest(next: string | null): void {
  attachment = next;
  emit();
}

/**
 * Why an entry is unusable, in words the person editing the file can act on.
 *
 * The status code itself is the reason — these only spell it out. `ok` has an
 * empty entry rather than being excluded from the map, so adding a status to
 * the union is a type error here rather than a silently blank tooltip.
 */
const STATUS_REASON: Record<ProjectStatus, string> = {
  ok: '',
  missing: 'the configured path does not exist',
  'not-a-directory': 'the configured path is not a directory',
  'not-absolute': 'the configured path is not absolute',
  'duplicate-id': 'this id is already claimed by an earlier entry',
};

export interface ProjectAccess {
  /** May a session be started in this project? */
  spawnable: boolean;
  /** Tooltip text explaining a refusal. `null` when spawnable. */
  reason: string | null;
  /**
   * The project is mapped but its entry is broken — amber, not muted.
   *
   * The distinction the user needs: *unmapped* is a thing they have not done
   * yet, *invalid* is a thing they did wrong. Painting both the same colour
   * makes a typo look like an unfinished setup.
   */
  invalid: boolean;
}

const SPAWNABLE: ProjectAccess = { spawnable: true, reason: null, invalid: false };

/**
 * Whether a session may be started in a project.
 *
 * **Permissive with no snapshot.** With no config loaded — the browser demo,
 * and the first frames of a desktop launch — every project is spawnable. Two
 * reasons, and they point the same way:
 *
 * - The browser build is a fixtures-only demo where "start a session" adds a
 *   fixture entity rather than a process (story 083). Gating it would remove
 *   the demo's main flow while protecting nothing, and would break five of the
 *   six Playwright web specs — which story 083 already names as the signal
 *   that the gate is wrong rather than the specs.
 * - On desktop, refusing until the async read lands would flash every project
 *   as unmapped for a frame or two on every launch.
 */
/**
 * A mapped project's absolute directory, or `null` (HIVE-78).
 *
 * The config already carries it — `resolve.ts` expands, absolutises and
 * `realpath`s every project path — and until now nothing in the renderer needed
 * it, because every filesystem verb names a `projectId` and lets main resolve
 * the rest. The explorer's worktree retarget is the first thing that has to
 * compare an absolute path to another absolute path, so it needs the value
 * rather than the id.
 *
 * **This does not become a way to read files by path.** It answers one
 * question — "is the session's cwd inside this project?" — and `fs-contract`'s
 * rule that no verb takes a path is untouched.
 *
 * `null` for an unknown project and for one whose `status` is not `ok`, which
 * are the same two cases `projectRoot()` refuses in main.
 */
export function projectPath(projectId: string): string | null {
  const entry = snapshot?.projects.find((project) => project.id === projectId);
  if (!entry || entry.status !== 'ok') return null;
  return entry.path;
}

/**
 * The project whose checkout is, or holds, `path` (HIVE-172), or `null`.
 *
 * `containsPath`'s boundary rule: `/repos/the-hive` owns `/repos/the-hive/src`
 * and not `/repos/the-hive-docs`. Unmapped projects have no path and own
 * nothing.
 */
export function projectIdForPath(path: string): string | null {
  let best: { id: string; depth: number } | null = null;
  for (const project of snapshot?.projects ?? []) {
    if (project.status !== 'ok' || project.path === null) continue;
    if (!containsPath(project.path, path)) continue;
    // The deepest checkout that holds the path: a sub-project mapped inside
    // a monorepo root wins over the root, whatever order the config lists.
    if (best === null || project.path.length > best.depth) {
      best = { id: project.id, depth: project.path.length };
    }
  }
  return best?.id ?? null;
}

/** Which field of a project answered to what the user typed (HIVE-94). */
export type ProjectRefField = 'key' | 'id' | 'name';

/**
 * What one project reference resolved to.
 *
 * Three states rather than "the project or null", because *ambiguous* and
 * *unknown* are different answers and only one of them is the user's mistake.
 * Collapsing them would make the console tell someone their project does not
 * exist while it is sitting in the list twice.
 */
export type ProjectRefResult =
  | { kind: 'none' }
  | { kind: 'match'; project: ProjectConfig; matched: ProjectRefField }
  | {
      kind: 'ambiguous';
      matched: ProjectRefField;
      projects: readonly ProjectConfig[];
    };

/**
 * Resolve whatever the user typed to exactly one project (HIVE-94).
 *
 * Every surface that takes a project *from a human* goes through here — the
 * console's `spawn`, and the new-session picker's search — so there is one
 * answer to "does this name a project?" rather than one per caller.
 *
 * ## Exact, never a prefix
 *
 * `incorp` does not resolve to `incorpx-server`, and that is the point: a spawn
 * lands in a folder and starts an agent in it. A prefix match turns a typo into
 * a session in the wrong repository, which is discovered later and by then has
 * done work. Refusing costs a retype.
 *
 * ## Key, then id, then name
 *
 * Keys are kept clear of ids and names when they are generated and when they are
 * typed (`projectAliases`), and duplicate ids are already disabled by
 * `resolveProjects` — so the order decides only the one ambiguity the config can
 * still contain: a display **name** equal to another project's id. The id wins
 * there because it is the older, stable handle.
 * {@link ProjectRefResult.matched} reports which field answered so a caller can
 * say so.
 *
 * ## Two projects with the same name refuse, they do not race
 *
 * Display names are never uniqueness-checked — two folders both called `api`,
 * a monorepo split, a pair of worktrees — so `find` would silently hand back
 * whichever sat first in the file. That is precisely the "agent in the wrong
 * repository" failure the exactness rule above exists to prevent, arriving by a
 * different door. Ambiguity is reported, and the caller asks for a key.
 *
 * Case-insensitive throughout: keys and ids are lowercase by construction, and
 * a user reading `The Hive` off the Projects pane should not have to reproduce
 * its capitals.
 */
export function resolveProjectRef(
  input: string,
  projects: readonly ProjectConfig[],
): ProjectRefResult {
  const wanted = input.trim().toLowerCase();
  if (wanted === '') return { kind: 'none' };

  const on = (matched: ProjectRefField): ProjectRefResult | null => {
    const hits = projects.filter(
      (candidate) => candidate[matched].toLowerCase() === wanted,
    );
    if (hits.length === 0) return null;
    if (hits.length === 1) return { kind: 'match', project: hits[0], matched };
    return { kind: 'ambiguous', matched, projects: hits };
  };

  return on('key') ?? on('id') ?? on('name') ?? { kind: 'none' };
}

export function projectAccess(projectId: string): ProjectAccess {
  const current = snapshot;
  if (!current) return SPAWNABLE;

  const entry = current.projects.find((project) => project.id === projectId);

  if (!entry) {
    return {
      spawnable: false,
      invalid: false,
      reason: `not mapped in ${current.configPath} — add it there to open a session in this project`,
    };
  }

  if (entry.status === 'ok') return SPAWNABLE;

  return {
    spawnable: false,
    invalid: true,
    reason: `${STATUS_REASON[entry.status]} (${entry.status}) — check ${current.configPath}`,
  };
}

/**
 * Whether a project's sessions run in a container (terminals).
 *
 * The tree's terminal link reads `terminal · host` for one, because a terminal
 * is host-only in this phase and an unlabelled "terminal in it" beside
 * containerised sessions would read as the container.
 *
 * Presence of the block is the switch — there is no `enabled` flag — so this
 * asks only whether the entry declared one, and answers `false` for an unknown
 * project and for no snapshot at all.
 */
export function projectContainerised(projectId: string): boolean {
  const entry = snapshot?.projects.find((project) => project.id === projectId);
  return entry?.container !== undefined;
}

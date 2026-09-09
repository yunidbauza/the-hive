import { spawn, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

import {
  BrowserWindow,
  Notification,
  app,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';

import { SNAPSHOT_READ_BUDGET_MS, createRemoteListener } from '@remote-host/listener';
import {
  AGENT_LIMIT_DEFAULTS,
  formatRunCost,
  type AgentLinesPush,
  type AgentRotateResult,
  type AgentRunResult,
  type AgentStatus,
  type AgentStatusPush,
  type WakeSpec,
} from '@shared/agent-contract';
import { AUTH_ENV_KEYS } from '@shared/config-contract';
import type {
  CloneStartResult,
  CommandDiagnostic,
  ConfigSnapshot,
  EnvDiagnostic,
  SetRemoteResult,
} from '@shared/config-contract';
import type {
  DirEntry,
  FileContent,
  FsChangedEvent,
  FsRefusal,
  FsResult,
  RootInfo,
  SearchResults,
  WriteFileResult,
} from '@shared/fs-contract';
import type { GhResult, PrRecord, PrsSnapshot } from '@shared/github-contract';
import {
  parseAckRequest,
  parsePromptReport,
  parseAgentNameRequest,
  parseAgentRenameRequest,
  parseAgentRunRequest,
  parseAgentWriteRequest,
  parseAddProjectRequest,
  parseCloneRequest,
  parseDiagnoseCommandRequest,
  parseReadDirRequest,
  parseReadFileRequest,
  parseRootRequest,
  parseSearchRequest,
  parseWatchRequest,
  parseWriteFileRequest,
  parseDiagnoseEnvRequest,
  parseSpawnRequest,
  parseSpawnTerminalRequest,
  parseKillRequest,
  parseLedgerAnswerRequest,
  parseLedgerPostBody,
  parseLedgerReadQuery,
  parseRemoveProjectRequest,
  parseRenameProjectRequest,
  parseSetProjectKeyRequest,
  parseReorderProjectsRequest,
  parseRepointProjectRequest,
  parseResizeRequest,
  parseAddJiraCommentRequest,
  parseApplyJiraTransitionRequest,
  parseJiraConversationRequest,
  parseJiraIssueRequest,
  parseJiraSearchRequest,
  parseJiraTransitionsRequest,
  parseSetJiraRequest,
  parseSetJiraTokenRequest,
  parseRemotePairRequest,
  parseSetReceiverRequest,
  parseSetServerRequest,
  parseSetSlackRequest,
  parseSetSlackTokensRequest,
  parseDismissRequest,
  parseMarkReadRequest,
  parseNotificationAction,
  parsePairDeviceRequest,
  parseRevokeDeviceRequest,
  parseSetNotificationsRequest,
  parseSetProjectRuntimeRequest,
  parseSetRuntimeRequest,
  parseSearchPrsRequest,
  parseSessionNoteRequest,
  parseSessionPrRequest,
  parseSkillDropRequest,
  parseSkillFileWriteRequest,
  parseSkillImportRequest,
  parseSkillMoveRequest,
  parseSkillNameRequest,
  parseSkillPathRequest,
  parseSkillRenameRequest,
  parseSkillWriteRequest,
  parseWriteRequest,
} from '@shared/guards';
import {
  CH,
  type AppInfo,
  type Channel,
  type IntegrationsStatus,
  type LoginEnvStatus,
  type NotificationActivateEvent,
  type NotificationDeliveryStatus,
  type NotificationDismissedEvent,
  type NotificationReadEvent,
} from '@shared/ipc-contract';
import type {
  JiraComment,
  JiraIdentity,
  JiraIssue,
  JiraLink,
  JiraResult,
  JiraSearchResult,
  JiraStatus,
  JiraTransition,
} from '@shared/jira-contract';
import { LEDGER_DIR, OVERMIND } from '@shared/ledger-contract';
import type { NotificationAction } from '@shared/notification-contract';
import { SNAPSHOT_CHANNELS } from '@shared/remote-contract';
import { SESSION_NAME_DISPLAY_MAX } from '@shared/session-contract';
import {
  SESSION_HISTORY_FILE,
  type SessionHistoryEntry,
} from '@shared/session-history-contract';
import {
  SLACK_TOKENS_FILE,
  type SlackSocketState,
  type SlackSocketStatus,
  type SlackSocketTestResult,
  type SlackStatus,
  type SlackTokensState,
} from '@shared/slack-contract';
import type { UpdateStatus } from '@shared/update-contract';

import {
  NO_ENCRYPTION_REASON,
  createTokenStore,
  type StoredDeviceCredential,
  type TokenStore,
} from '../../remote-client/token-store';
import { createAgentsRuntime, type AgentRegistry } from '../agents';
import { resolveClaude } from '../agents/claude-path';
import { agentsDirectoryFor } from '../agents/directory';
import {
  agentPromptFile,
  agentStateFile,
  agentWorkdir,
  agentsRoot,
} from '../agents/paths';
import { createPermissions, type Permissions } from '../agents/permissions';
import { createAgentRunFiles } from '../agents/run-files';
import {
  createRunTracker,
  type ChildLike,
  type RunTracker,
} from '../agents/runs';
import { createScheduler, type Scheduler } from '../agents/scheduler';
import { createAgentState, type AgentState } from '../agents/state';
import { mergeRunState } from '../agents/summary';
import { createWakeCommand } from '../agents/wake-command';
import { createCloneFlow, type CloneFlow } from '../clone';
import {
  addProject,
  configPath,
  getConfig,
  reloadConfig,
  removeProject,
  renameProject,
  reorderProjects,
  repointProject,
  resetConfig,
  setJira,
  setNotifications,
  setProjectKey,
  setProjectRuntime,
  setReceiver,
  setRuntime,
  setServer,
  setSlack,
} from '../config';
import { diagnoseEnv } from '../config/env-diagnostic';
import { loginEnvStatus } from '../config/login-env';
import { diagnoseCommand, effectiveRuntime, receiverHostAliases } from '../config/runtime';
import { isSafeExternalUrl } from '../external-links';
import {
  createFsWatchLayer,
  forgetProbedRoots,
  readDirectory,
  readFileContent,
  readRoot,
  setSessionCwdLookup,
  searchProject,
  writeFileContent,
  type FsWatchLayer,
} from '../fs';
import { createHookRuntime } from '../hooks';
import { readGhStatus, runCommand } from '../integrations/gh';
import { createGithub } from '../integrations/github';
import { runAsync, type RunAsync } from '../integrations/github/run';
import { createJira } from '../integrations/jira';
import { credentialFile } from '../integrations/jira/auth';
import { createSlackBridge, type SlackBridge } from '../integrations/slack/bridge';
import { openSlackSocket, openSlackWeb } from '../integrations/slack/clients';
import { signInToSlack, signOutOfSlack } from '../integrations/slack/login';
import { probeSlack } from '../integrations/slack/probe';
import { readSlackStatus } from '../integrations/slack/status';
import {
  readSubscriptions,
  type SubscribableAgent,
} from '../integrations/slack/subscriptions';
import { createSlackTokens } from '../integrations/slack/tokens';
import { createLedger } from '../ledger';
import { createDeliver } from '../ledger/deliver';
import { createLedgerNotifier } from '../ledger/notify';
import { agentMcpConfigFile, createMcpRuntime } from '../mcp';
import {
  createNotificationHub,
  createNotifier,
  createSessionNames,
  createToastQueue,
  createToastRoute,
} from '../notifications';
import { registerPtyHost } from '../pty-host';
import {
  pairDevice,
  pairOutcomeMessage,
  revokeDevice,
  revokeOutcomeMessage,
} from '../server/devices';
import { readServerDevicesFromDisk, serverDeviceStore } from '../server/file-backed-io';
import { isServerMode } from '../server-mode';
import { createSessions, type Sessions } from '../sessions';
import {
  createSessionHistory,
  type SessionHistory,
} from '../sessions/history';
import { onShutdown } from '../shutdown';
import { createSkillsRuntime, type SkillsRuntime } from '../skills';
import { PLUGIN_DIR } from '../skills/paths';
import { parseSaveThemeRequest, pickTheme, saveTheme } from '../theme';
import {
  checkForUpdatesInteractively,
  downloadUpdate,
  installUpdate,
  setUpdateNotificationSink,
  updateStatus,
} from '../updates';

import { createBindings } from './bindings';
import { createWindowBroadcaster, type Broadcaster } from './broadcaster';
import { createIpcRegistry, type CallHandler } from './registry';
import { createRemoteDispatch } from './remote-dispatch';
import { assertSender } from './sender';
import { applySetRemote, type AttachedSnapshot, type ModeSwitcher } from './set-remote';
import {
  createFanOutBroadcaster,
  createSocketBroadcaster,
} from './socket-broadcaster';
import { createSurfaceRegistry, type SurfaceId } from './surfaces';

/**
 * Channel handlers (story 082).
 *
 * Every handler validates before acting: `assertSender` first, then the payload
 * guard. The renderer is untrusted input because terminal output is untrusted
 * input and it renders there.
 *
 * `app:info` proved the path in story 082; `config:*` landed in 090; the PTY
 * channels and their flow control are story 093's.
 */

/**
 * Which handler answers which channel, for the remote path (HIVE-143).
 *
 * Module scope beside {@link remoteListener} and for the same reason: both are
 * process-wide, both are built by `registerIpcHandlers`, and both must be torn
 * down by `resetIpcHandlers` or a suite leaks them into the next one.
 *
 * Declared here rather than beside `remoteListener` itself only because `on`
 * and `handle` below are what fill it, and a reader of those two lines should
 * not have to go looking.
 */
const remoteRegistry = createIpcRegistry();

/**
 * Who is looking at this Hive, and how to reach exactly one of them
 * (HIVE-145).
 *
 * Attached sockets *and* local windows, in one registry, because the state
 * this file keys by surface — the input-box record, the foreground terminal,
 * the ack window, the fs watch — is written by both. It replaced a bare
 * `Set<AttachedSocket>` here: a second registry of the same connections is
 * exactly the disagreement this story exists to close.
 *
 * Module scope for the reason `remoteRegistry` is: `registerIpcHandlers` fills
 * it, and a live mode switch tears down and re-registers around it.
 */
const surfaces = createSurfaceRegistry();

/**
 * Interruptions raised while nobody was looking (HIVE-145).
 *
 * Only the kinds a person must answer, bounded by age and by subject — see the
 * module for why a faithful replay would be the worse product. Flushed the
 * moment a surface arrives.
 *
 * Module scope beside `surfaces`, and for the same two reasons: it holds
 * nothing that belongs to one registration, and `resetIpcHandlers` has to be
 * able to empty it. A mode switch that left it full would raise the departed
 * mode's questions at the machine you just attached to.
 */
const toastQueue = createToastQueue();

/**
 * The surface behind an IPC event, registering it on first sight.
 *
 * Named for what it answers rather than for `trackWindow`, which it calls,
 * because it cannot mislabel a socket: a notify dispatched from an attached
 * socket arrives with the socket itself as `event.sender`
 * (`recordNotify` below wraps it as `{ sender: reporter }`), and that object is
 * already tracked as a `socket` surface by `onAttach`. `trackWindow` then
 * returns the existing id, kind intact.
 */
const surfaceFor = (sender: unknown): SurfaceId =>
  surfaces.trackWindow(sender, (channel, payload) => {
    const contents = sender as { send?: (channel: string, payload: unknown) => void };
    contents.send?.(channel, payload);
  });

/**
 * Every channel this process has bound (HIVE-144). Module scope for the same
 * reason `remoteRegistry` is: `registerIpcHandlers` fills it, and a live mode
 * switch must be able to empty it from outside that function.
 */
const bindings = createBindings(ipcMain);

/**
 * How many channels this process has bound locally (HIVE-144).
 *
 * Test-only, in the same register as {@link remoteRegistrySize} below and
 * `remoteProxyBindingsSize` in `remote-proxy.ts` — and it is what makes a
 * refused mode switch *provably* free. Invoking one channel and finding it
 * alive is necessary and not sufficient: half an unbound surface answers that
 * one channel too. A count is what distinguishes "still works" from "still
 * entirely intact".
 */
export function ipcBindingsSize(): number {
  return bindings.size();
}

/**
 * The device credential this machine was handed when it attached to someone
 * else's Hive (HIVE-144) — composed exactly as Jira's is: `safeStorage` and a
 * file under `userData`, both injected, so `token-store.ts` can be answered by
 * a unit test without a keyring.
 *
 * A function rather than a module-scope constant because `app.getPath` is only
 * answerable after the app exists, and this module is imported long before
 * that. One function rather than two construction sites because
 * `remote:pair`'s handler writes through it and {@link readRemoteCredential}
 * reads through it, and a second spelling of that filename is a credential
 * written to one path and looked for at another.
 */
function remoteCredentialStore(): TokenStore {
  return createTokenStore({
    safeStorage,
    filePath: join(app.getPath('userData'), 'remote-credential.bin'),
  });
}

/**
 * The stored device credential, or `null` when there is none this machine can
 * use (HIVE-144).
 *
 * Exported for exactly one caller: `ipc/router.ts`'s `switchIpcMode`, which
 * needs it to dial and has no business composing the store itself — Ruling 2
 * put the read on the switch rather than inside `connectRemote`, precisely so
 * the socket module stays free of Electron's `safeStorage`.
 *
 * Still not reachable from the renderer: no IPC verb returns this, and none
 * may. `remote:pair` writes the credential and `remote:forget` clears it;
 * neither hands it back.
 */
export function readRemoteCredential(): StoredDeviceCredential | null {
  return remoteCredentialStore().read();
}

/**
 * How `config:set-remote` asks this process to change mode (HIVE-144).
 *
 * Re-exported rather than declared here since Ruling 28: the verb's body moved
 * to `./set-remote` so `registerRemoteProxy` can answer it too, and the type
 * moved with it. Both callers name the same one, which is the point — a second
 * structural declaration would be free to drift from the switcher it describes.
 */
export type { ModeSwitcher };

/**
 * The default {@link ModeSwitcher}: a loud failure, never a quiet success.
 *
 * Reached only by a suite that calls `registerIpcHandlers` directly —
 * `registerIpc` always passes the real one, so production cannot land here.
 * It throws rather than answering `{ ok: true }` because a silent success
 * would let `config:set-remote` write `mode: "remote"` to disk over a switch
 * that never happened, which is the exact state Ruling 19 exists to make
 * impossible.
 */
const noModeSwitcher: ModeSwitcher = () => {
  throw new Error(
    'config:set-remote reached a registration with no mode switcher. ' +
      'registerIpcHandlers was called directly rather than through registerIpc.',
  );
};

/**
 * The event object handed to a call handler reached over a socket.
 *
 * There is no `IpcMainInvokeEvent` to give it, because there is no renderer and
 * no window. That is safe rather than lucky: exactly four call channels
 * dereference this, all four for a parent `BrowserWindow`, and all four are
 * in `WINDOW_BOUND` and refused before `remote-dispatch` ever reaches a
 * handler. `skills:file:import` (HIVE-148) is the fourth — choosing files for
 * a skill opens the same native dialog the other three needed a window for.
 * If a fifth ever grows the dependency, it must be added to that table in the
 * same commit — this cast is the reason that is a rule and not a preference.
 *
 * **And the rule is checked, not merely stated (HIVE-143 review).**
 * `remote-composition.test.ts` reads this file as source text, finds every
 * `handle`/`on` site that binds an `event` parameter it actually uses, and
 * fails if that set is anything other than `WINDOW_BOUND`'s four channels plus
 * `pty:prompt` — the one that dereferences the event deliberately, for a
 * *surface lifetime* rather than a window, which a socket satisfies. That test
 * is what makes the paragraph above enforceable; the `_event` naming
 * convention every other handler follows is what makes it readable.
 */
const REMOTE_INVOKE_EVENT = {} as IpcMainInvokeEvent;

/**
 * Fire-and-forget channels (story 093).
 *
 * `send`, not `invoke`, for keystrokes, resizes and acks: awaiting a round trip
 * per character would put the main process in the typing-latency path, and
 * ordering is already guaranteed on a single channel — which is what actually
 * matters.
 */
function on(
  channel: string,
  handler: (event: IpcMainEvent, payload: unknown) => void,
): void {
  ipcMain.on(channel, (event, payload: unknown) => {
    assertSender(event);
    try {
      handler(event, payload);
    } catch (cause) {
      // A `send` channel has no reply, so a throw here would be an unhandled
      // rejection in main rather than an error the renderer sees. Rejected
      // input is logged and dropped — never acted on.
      console.error(`[hive] rejected ${channel}:`, cause);
    }
  });
  /*
    Recorded once at registration, never inside the `ipcMain` callback above —
    a record per invocation would rewrite the same entry on every keystroke.
    `remote-dispatch.ts` owns the refusals; this stores and nothing else.
  */
  remoteRegistry.recordNotify(channel as Channel, (payload, reporter) => {
    // The reporter stands in for `event.sender`. Only `pty:prompt` reads it,
    // through `watchReporter`, which already accepts anything with an `.on`.
    handler({ sender: reporter } as unknown as IpcMainEvent, payload);
  });
  // HIVE-144: so a later mode switch can unbind this channel from `ipcMain`
  // and register it again against a different set of layers.
  bindings.record(channel);
}

/** Wrap a handler so sender validation cannot be forgotten on a new channel. */
function handle<T>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, payload: unknown) => T,
): void {
  ipcMain.handle(channel, (event, payload: unknown) => {
    assertSender(event);
    return handler(event, payload);
  });
  // Registration-time, as in `on` above. `assertSender` is deliberately absent:
  // there is no sender to assert, and the socket's own gate is the handshake
  // plus `remote-dispatch.ts` — the one remote gate, kept out of the local path.
  remoteRegistry.recordCall(channel as Channel, (payload) =>
    handler(REMOTE_INVOKE_EVENT, payload),
  );
  // HIVE-144: so a later mode switch can unbind this channel from `ipcMain`
  // and register it again against a different set of layers.
  bindings.record(channel);
}

/**
 * The payload each {@link SNAPSHOT_CHANNELS} entry is read with — the same one
 * `electron/preload/index.ts` sends for it, defaulting to `undefined` (HIVE-144).
 *
 * Every one of the six is called with no argument from the renderer at boot
 * *except* `ledger:list`: its bridge method is `(query?) =>
 * ipcRenderer.invoke(CH.ledgerList, query ?? {})`, so `undefined` never
 * actually crosses that wire, and `parseLedgerReadQuery` — correctly — refuses
 * it with `TypeError: ledger query must be an object` when it does. Read that
 * refusal here (`{}`, not the whole map's default) rather than silently
 * matching what `guards.ts` will accept: this is one bridge's own choice of
 * default, not a rule every channel happens to share.
 */
const SNAPSHOT_PAYLOAD: Partial<Record<Channel, unknown>> = {
  [CH.ledgerList]: {},
};

/**
 * Races one {@link SNAPSHOT_CHANNELS} read against
 * {@link SNAPSHOT_READ_BUDGET_MS}, resolving `[channel, value]` on a timely
 * answer and `null` on anything else — a throw, a rejection, or simply
 * running out of time (HIVE-144 review; Ruling 15 extended: a slow read is
 * dropped exactly like a broken one, because a client waiting on either
 * cannot tell them apart).
 *
 * **Never rejects.** Every path resolves, which is what lets
 * {@link buildAttachSnapshot} run all six of these concurrently with a plain
 * `Promise.all` — one slow or broken read cannot take the others down with
 * it, and cannot make them wait for it either.
 *
 * `handler` may be `null` — a channel `handle()` has not registered yet — and
 * that is deliberately not special-cased with its own branch. Calling `null`
 * as a function throws a `TypeError` that reaches the same `.catch` below a
 * broken *registered* handler's error would, and the observable outcome —
 * the key is omitted, the reason is logged — is identical either way. A
 * dedicated `if (handler === null)` here would be the same unfalsifiable
 * shape `electron/remote-host/listener.ts`'s deleted `fitSnapshot` fast path
 * was (HIVE-144 review): nothing distinguishes its own correctness from the
 * shared catch path that already covers it.
 */
function raceSnapshotRead(
  channel: Channel,
  handler: CallHandler | null,
): Promise<readonly [Channel, unknown] | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      /*
        Unreachable by contract, not merely unlikely (HIVE-144 review — three
        guards examined for the shape Task 6's deleted `.catch()` check was:
        argued as covered, actually exercised by nothing).

        The only way `settled` could already be `true` here is the read
        having settled first — and both branches below call `clearTimeout(timer)`
        in the same synchronous turn they set `settled`, before this callback
        could ever be dispatched. `clearTimeout` guarantees a cleared timer's
        callback never runs at all, not merely that it early-returns if it
        does — so by the time either branch below finishes, this callback has
        already been prevented from firing, on this event loop or any other.
        Kept rather than deleted: it is the one line standing between "provably
        unreachable today" and "silently double-resolves if a future edit ever
        reorders `clearTimeout` after `resolve`" — a correctness note a reader
        can verify against the two branches below, not a test that can ever
        exercise it.
      */
      if (settled) return;
      settled = true;
      console.error(
        `[hive] attach snapshot read for ${channel} exceeded ${String(SNAPSHOT_READ_BUDGET_MS)}ms; omitted`,
      );
      resolve(null);
    }, SNAPSHOT_READ_BUDGET_MS);

    Promise.resolve()
      // The cast is the point, not a workaround for one: see the null branch
      // above. `await` on a non-promise is a no-op, so this one `.then` covers
      // both `github:prs` (genuinely asynchronous) and the five that are not.
      .then(() => (handler as CallHandler)(SNAPSHOT_PAYLOAD[channel]))
      .then((value) => {
        /*
          Reachable — the timeout can fire first on a genuinely slow read —
          but with no observable effect once it does (HIVE-144 review): a
          `Promise` settles at most once by spec, so the `resolve` three lines
          down is silently ignored either way, and `clearTimeout` on a timer
          that already fired is a documented no-op. Nothing this branch does
          past this line can be told apart, by any test, from this branch not
          running at all. Contrast the `.catch` branch below, which is the one
          of these three where skipping it is actually visible.
        */
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve([channel, value]);
      })
      .catch((cause: unknown) => {
        /*
          The one of these three guards with a real, tested effect (HIVE-144
          review): without it, a read that times out and *later* rejects logs
          twice for the same channel — the timeout's own "exceeded ...ms;
          omitted" line, and this catch's "could not read" line for a failure
          nobody is still waiting to hear about. `tests/electron/main/ipc/remote-composition.test.ts`
          drives this exact ordering (a hung read that times out, then rejects
          well after) and asserts the second log never happens.
        */
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        console.error(`[hive] attach snapshot could not read ${channel}:`, cause);
        resolve(null);
      });
  });
}

/**
 * Builds `AttachAccepted.snapshot` — the six {@link SNAPSHOT_CHANNELS} reads a
 * joining client needs to render the fleet without six round trips (HIVE-144).
 *
 * Calls each channel's handler through `remoteRegistry.call`, the exact
 * function a socket's own `call` frame would reach — the same one `handle`
 * above records — so there is no second source of truth for what a channel
 * answers. Read with {@link SNAPSHOT_PAYLOAD}'s entry for the channel, or
 * `undefined` when it has none — the payload every one of these six takes at
 * boot in the renderer.
 *
 * A snapshot is a convenience, not a precondition (Ruling 15, HIVE-144
 * review, and extended in review): a channel whose handler is not yet
 * registered is omitted, one whose handler throws or rejects is omitted, and
 * one that simply takes longer than {@link SNAPSHOT_READ_BUDGET_MS} is
 * omitted too — a slow read costs the same key a broken one would, never the
 * whole snapshot, and never the handshake itself. All six race that budget
 * **concurrently** (`raceSnapshotRead`, via `Promise.all`), not one after
 * another: a sequential sum of six "safe" per-channel waits could still blow
 * past the handshake's own deadline on its own, which a single shared budget
 * bounding the whole call cannot.
 *
 * Sizing the resulting frame against the wire's ceiling is deliberately not
 * this function's job — it returns whatever it could read, and
 * `electron/remote-host/listener.ts`'s `fitSnapshot` is what weighs the
 * accept frame this becomes and drops keys if a busy server's answer would
 * not otherwise fit.
 */
async function buildAttachSnapshot(): Promise<Partial<Record<Channel, unknown>>> {
  const results = await Promise.all(
    SNAPSHOT_CHANNELS.map((channel) => raceSnapshotRead(channel, remoteRegistry.call(channel))),
  );
  const snapshot: Partial<Record<Channel, unknown>> = {};
  for (const result of results) {
    if (result !== null) snapshot[result[0]] = result[1];
  }
  return snapshot;
}

/**
 * Why the OS last refused a desktop notification, or `null`.
 *
 * Module scope rather than a field on the hub, because it is not a fact about
 * notifications — it is a fact about **this operating system's answer to this
 * process**, learned the only way it can be learned, by trying. The hub is
 * deliberately ignorant of how a notification is presented, and giving it
 * somewhere to store a macOS authorization error would be the first crack in
 * that.
 *
 * Never reset. A refusal is not transient in the case that produces it — an
 * unsigned bundle stays unsigned for the life of the process — and clearing it
 * on the next successful send would mean the settings pane flickered between
 * two accounts of the same system.
 */
let systemNotificationRefusal: string | null = null;

/**
 * The server-mode socket (HIVE-142), constructed unconditionally below but
 * only ever `start()`-ed by `index.ts`, and only in server mode. `null` here
 * means "not yet composed" (before `registerIpcHandlers` runs, or in a test
 * that never calls it) — `startRemoteListener` and `remoteListenerBoundAddress`
 * both treat that the same as "not listening" rather than throwing.
 */
let remoteListener: ReturnType<typeof createRemoteListener> | null = null;
/**
 * The port `remoteListener` was actually constructed with (HIVE-142 review,
 * N3) — captured once, beside `remoteListener` itself, rather than read
 * again later through `getConfig()`. See the assignment site's own comment.
 */
let remoteListenerPort: number | null = null;

let sessions: Sessions | null = null;
/**
 * The session history (HIVE-87), or `null` before registration.
 *
 * Held here rather than reached through `sessions` because two unrelated things
 * need it: the session layer writes to it, and `session:history` reads from it.
 * Routing the read through the session layer would mean widening that layer's
 * surface with a verb it does not otherwise need.
 */
let history: SessionHistory | null = null;
/**
 * The custom-skills runtime (HIVE-96), or `null` before registration.
 *
 * Held here for the reason `history` is: two unrelated callers need it. The
 * session layer syncs it before every spawn and reads its path, and the four
 * `skills:*` handlers below read and write the tree it manages.
 */
let skills: SkillsRuntime | null = null;
let agents: AgentRegistry | null = null;
/**
 * `~/.hive/ledger/agents.json`, or `null` before registration (HIVE-115).
 *
 * Held beside `agents` rather than inside it because they are two different
 * kinds of fact about the same names — the registry owns what the user wrote,
 * this owns what the app has since done — and three unrelated callers need
 * this one: `agents:list` merges it, the run tracker writes it, and the
 * shutdown hook flushes it.
 */
let agentState: AgentState | null = null;
/**
 * Every `claude` this layer spawned for Slack, as one thing to hang up on
 * (HIVE-123).
 *
 * `before-quit` already kills the agent runs, and `pty-host` already kills the
 * sessions; the Slack children were in neither registry, so a quit during a
 * sign-in left a `claude mcp login` alive for the rest of its ten-minute
 * budget — holding Slack's single registered callback port 3118, so the
 * relaunched app's sign-in failed on a port conflict with nothing on screen to
 * explain it. One controller rather than a set of pids: `runAsync` takes an
 * `AbortSignal` and Node does the signalling, which is both fewer moving parts
 * and correct from a synchronous shutdown hook.
 */
let slackChildren: AbortController | null = null;
/**
 * The Slack verbs currently running, keyed by channel (HIVE-123).
 *
 * The pane guards its own buttons, but that guarantee lasts exactly as long as
 * the component stays mounted: closing Settings and reopening it re-enables
 * both. Two `mcp login` children then contend for port 3118 and two probes
 * spend two model turns for one answer. Deduping in main makes it a property
 * of the verb instead of a property of a component, which is where it belongs.
 */
const slackInFlight = new Map<string, Promise<SlackStatus>>();
/**
 * Slack Socket Mode, or `null` before registration (HIVE-124).
 *
 * Module scope for `scheduler`'s reason and half of `slackChildren`'s. It is
 * reached from three places that never see each other: the composition that
 * builds it, the handlers and the folder watcher that re-`sync()` it, and both
 * teardown paths — which must stop it **before** `scheduler`, since it is the
 * producer of wakes that scheduler consumes.
 */
let slackBridge: SlackBridge | null = null;
/**
 * Live agent runs, or `null` before registration (HIVE-115).
 *
 * Module scope, like `sessions`, and for the same reason: it is reached from
 * two places that never see each other. The `agents:run` / `agents:kill`
 * handlers below drive it, and the hook receiver's agent route calls
 * `noteTurnEnded` on it when a turn ends (HIVE-115, task 8).
 */
let runs: RunTracker | null = null;
/**
 * Ledger-addressed wakes, or `null` before registration (HIVE-120).
 *
 * Module scope for the same reason as `runs`, and reached lazily by the tracker
 * that it in turn drives: `onRunClosed` is a dependency of `createRunTracker`,
 * and the scheduler cannot be built until the tracker it calls exists. One of
 * the two has to reach the other through a binding rather than an argument, and
 * this is the one whose consumers already tolerate `null`.
 */
let scheduler: Scheduler | null = null;
/**
 * Answers become grants, or `null` before registration (HIVE-119).
 *
 * Module scope for the same reason as `scheduler`, and armed at the same
 * point in the composition: it neither spawns nor needs `mcp.start()`
 * itself, but `ledger.onChange` is wired far above where `agents` and
 * `ledger` exist, so the dispatch there reaches this the same way it reaches
 * `scheduler` — through a binding read at call time, not a value closed over
 * at registration.
 */
let permissions: Permissions | null = null;
/**
 * The agent names the ledger will accept as a party.
 *
 * A `Set` rather than an `await agents.list()` because `knowsParty` is
 * synchronous — it is consulted inside `Ledger.append`, which the receiver
 * calls on a request it must answer. It is refreshed from the registry at boot
 * and on every folder change, and a name is also added the moment a wake
 * command is successfully built for it: building one means main read that
 * agent's definition off its own disk, which is a stronger proof of existence
 * than a listing that may be a few hundred milliseconds old.
 */
const knownAgents = new Set<string>();
/**
 * The subset of {@link knownAgents} whose definitions take ledger wakes.
 *
 * A second set rather than a lookup through the registry, for the reason
 * `knownAgents` is a set at all: the scheduler is consulted synchronously from
 * inside `Ledger.append`, and `agents.list()` is a promise that re-reads and
 * re-parses every definition on disk.
 *
 * Deliberately **not** widened by a live run the way `knownAgents` is. That
 * exception exists so a run already going keeps its right to write to the log
 * when its file stops parsing mid-edit; it says nothing about whether its author
 * asked for ledger wakes, and inferring one from the other would wake an agent
 * on a setting nobody chose.
 */
const ledgerAgents = new Set<string>();
/**
 * Every valid agent's schedule, for the scheduler's tick (HIVE-121).
 *
 * A third cache beside the two above, filled in the same pass and for the same
 * reason: the tick runs every sixty seconds and `agents.list()` is a promise
 * that re-reads and re-parses every definition on disk. Doing that on a timer
 * would put a folder walk between the clock and every wake.
 *
 * It being *rebuilt* on every folder change is what makes "a definition change
 * re-arms the schedule" need no code: there is no armed timer to re-arm, only
 * a map the next tick reads again. An `invalid` definition is left out, which
 * is what keeps a broken file off the timer while it stays listed to be fixed.
 */
const agentSchedules = new Map<
  string,
  { wake: WakeSpec; dailyUsd?: number; mcp: string[] }
>();
/**
 * Every valid agent's `limits.parallel` (HIVE-128), for the tracker's gate and
 * the scheduler's flush — both asked synchronously, so it is cached beside the
 * schedule rather than read off disk. Absent reads as 1, the default.
 */
const agentParallel = new Map<string, number>();
/**
 * Every valid agent's own `container.host_alias`, for the receiver's `Host`
 * guard (HIVE-134 follow-up).
 *
 * A cache beside the three above and filled in the same pass, for the same
 * reason: the guard is consulted **synchronously**, on every request the
 * receiver serves, and `agents.list()` is a promise that re-reads and
 * re-parses every definition on disk. An agent with no `container.host_alias`
 * of its own contributes nothing here — it inherits the global alias, which
 * `hostAliases` below always includes on its own.
 *
 * Absent from `AgentSummary` until this cache needed it, hence
 * `AgentSummary.container` (HIVE-134 follow-up): a definition fact like
 * `rotateAfter` and `dailyUsd` beside it, carried from `registry.list()` the
 * same way they are.
 */
const agentHostAliases = new Set<string>();
/**
 * Every hostname the receiver's guard must admit as a `Host` header
 * (HIVE-134 follow-up), read fresh on every call.
 *
 * A getter passed straight to `createHookRuntime`, exactly as
 * `hostAlias: () => getConfig().receiver.hostAlias` beside it always has
 * been — a config reload has to be picked up while the socket stays open,
 * which is the whole reason that one was a getter rather than a captured
 * value. `receiverHostAliases` itself is pure and cheap (it only iterates
 * `getConfig().projects`, already in memory), so there is nothing to memoise
 * on this side; the one genuinely expensive input — every agent's alias — is
 * `agentHostAliases` above, already kept live off the folder watcher rather
 * than reread here.
 */
const hostAliases = (): ReadonlySet<string> =>
  receiverHostAliases(getConfig(), agentHostAliases);
/**
 * Whether {@link agentSchedules} has been filled at least once.
 *
 * An empty map means two very different things, and the scheduler must not
 * confuse them: "this machine has no scheduled agents" and "the folder walk has
 * not finished yet". The second is the common case at boot — `agents.list()`
 * reads and parses every `AGENT.md`, while `scheduler.start()` ticks
 * synchronously — and reading it as the first would have the tick clear every
 * agent's overdue `nextRunAt` on the launch right after a missed window.
 */
let agentsListed = false;

/**
 * Re-read the folder into {@link knownAgents}.
 *
 * Fire-and-forget, and a failure is swallowed on purpose: this is the *cache*
 * of a fact, and the authoritative path — `command()` adding the name it just
 * read a definition for — does not depend on it. A rejected `list()` here means
 * an unrun agent cannot post to the ledger until the next folder change, which
 * is a far smaller failure than an unhandled rejection at startup.
 *
 * A folder listed as `invalid` is left out. It cannot be woken, so nothing can
 * legitimately write to the ledger as that name.
 *
 * A **live run** is the exception, and it is the epic's own premise rather than
 * a defensive edge case: an agent is meant to be edited in a text editor while
 * it works, and a save mid-edit routinely lands a file that does not parse. The
 * watcher fires, the rebuild drops the name, and everything the running child
 * does next is refused as an unknown party — its hooks 404, its `ledger_*` tool
 * calls come back refused, and at close the tracker's own `run.ended` append is
 * rejected, leaving a `run.started` with no end in the log that is supposed to
 * be the record of what happened. A run that is already going was authorised
 * when it started, so it keeps its name until it ends.
 */
function refreshKnownAgents(): void {
  void agents
    ?.list()
    .then((snapshot) => {
      knownAgents.clear();
      ledgerAgents.clear();
      agentSchedules.clear();
      agentParallel.clear();
      agentHostAliases.clear();

      for (const agent of snapshot.agents) {
        if (agent.invalid !== undefined) continue;

        knownAgents.add(agent.name);
        // The definition's own gate, cached beside the party register because
        // the scheduler is asked synchronously, from inside `Ledger.append`.
        if (agent.wake.on.includes('ledger')) ledgerAgents.add(agent.name);
        // And the schedule, for the tick — which is asked just as
        // synchronously, sixty seconds at a time. `mcp` rides along so the
        // tick's Slack skip (HIVE-123) can gate on the agent's *current*
        // definition rather than on stale run history.
        agentSchedules.set(agent.name, {
          wake: agent.wake,
          ...(agent.dailyUsd === undefined ? {} : { dailyUsd: agent.dailyUsd }),
          mcp: agent.mcp,
        });
        // The parallel cap, for the same two synchronous askers (HIVE-128).
        agentParallel.set(
          agent.name,
          agent.parallel ?? AGENT_LIMIT_DEFAULTS.parallel,
        );
        // The receiver's `Host` guard (HIVE-134 follow-up), asked just as
        // synchronously as the two above. Absent means this agent inherits
        // the global alias, which `hostAliases` always admits on its own —
        // nothing to add here for the common case.
        if (agent.container?.hostAlias !== undefined) {
          agentHostAliases.add(agent.container.hostAlias);
        }
      }

      for (const name of runs?.live() ?? []) knownAgents.add(name);

      // Only now may the tick trust an absence — see `agentsListed`.
      agentsListed = true;

      /*
        And the socket, which is held open only for what an enabled agent
        subscribes to (HIVE-124).

        Here rather than in the `agents:write` / `agents:remove` / `agents:rename`
        handlers, and that is the correct seam rather than a convenience:
        {@link subscribableAgents} answers from the caches this pass has just
        rebuilt, so a `sync()` fired from inside a write handler would read the
        subscription set as it was *before* the write. The folder change is what
        makes the new answer knowable, so it is what re-asks the question — and
        it covers an edit made in a text editor as well as one made in the pane.
      */
      slackBridge?.sync();
    })
    .catch(() => {
      // Keep whatever we already knew — including, deliberately, whether the
      // schedules have ever been read. A failed listing must not license the
      // tick to clear the times a previous one established.
    });
}
/**
 * Who the socket is held open for, as `subscriptions.ts` asks it (HIVE-124).
 *
 * Built from {@link agentSchedules} and {@link agentState}, and **synchronous**,
 * because `SlackBridge.sync` is: it is called from an IPC handler and from a
 * folder change, and both have to be able to decide whether to connect without
 * waiting on a promise. `agents.list()` re-reads and re-parses every definition
 * on disk, which is precisely why those caches exist.
 *
 * Every entry is `valid: true` by construction — `refreshKnownAgents` leaves an
 * unparseable definition out of the map entirely, which is the same answer
 * `readSubscriptions` would reach from the flag.
 */
function subscribableAgents(): SubscribableAgent[] {
  return [...agentSchedules.entries()].map(([name, schedule]) => ({
    name,
    on: schedule.wake.on,
    valid: true,
    paused: agentState?.read(name).status === 'paused',
  }));
}

/** The clone flow (story 102), or `null` before registration. */
let cloneFlow: CloneFlow | null = null;
/** The single project watcher, or `null` before registration. */
let fsWatch: FsWatchLayer | null = null;

/** A plain object, for the payload guards below. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What each surface has on its centre stage, and whether that surface is
 * focused (HIVE-81, HIVE-145).
 *
 * Module scope for the reason `systemNotificationRefusal` is: it is a fact
 * about who is looking at this process, not about notifications, and the hub is
 * deliberately ignorant of what the user is looking at. The hub asks a
 * predicate; it never holds this.
 *
 * **A map, because one value could not be true of two devices.** It was a
 * single `foregroundTerminalId`, and every attached socket sends
 * `ui:foreground` down the same notify channel a renderer does — so it held
 * whatever the last surface to change stage said. With two devices attached,
 * one switching tabs rewrote the other's answer: a notification for the session
 * device A was watching got suppressed because device B happened to be on it,
 * or — worse, because it is the case the suppression exists for — was *raised*
 * while A was watching it, because B moved on.
 *
 * **`focused` travels with it, and only a socket's is read.** `windowFocused()`
 * is a fact about *this* machine's windows, and a served Mac usually has none,
 * so it is the wrong question to ask of a remote surface. A window surface
 * therefore still reads its focus live from `BrowserWindow` — a renderer-published
 * boolean goes stale in exactly the case the feature exists for — while a socket
 * reports its own, stamped by the client's main process, which is the only
 * process that can see that machine's windows.
 *
 * Absent `focused` means **not** focused. That is the conservative default: the
 * failure it produces is a toast for a session the user was already watching,
 * and the one the opposite default produces is silence about a session nobody
 * is looking at.
 */
const foreground = new Map<SurfaceId, { terminalId: string | null; focused: boolean }>();

/**
 * Whether **any** window of this app has focus right now.
 *
 * Read from `BrowserWindow` rather than published by the renderer, and that
 * asymmetry is the whole design. A renderer-published focus boolean goes stale
 * in exactly the case the feature exists for — the window hidden, the app in
 * the background — because the renderer stops running to update it.
 *
 * ## "Any window", not "the main window", and that is on purpose
 *
 * The app creates three (`window.ts`, `splash.ts`, `about.ts`), so with the
 * About panel focused over the main window this still answers `true` and the
 * session on the stage still reads as foreground. That is the right answer,
 * not a leak: About is a small frameless panel, the terminal is visible behind
 * it, and the user is a keystroke from the window they were already watching.
 * The question the gate asks is "is this session on the user's screen and in
 * front of them", and it is.
 *
 * The failure mode worth avoiding is the opposite one — going quiet when the
 * user cannot see anything — and no window of ours being focused is exactly
 * that. Narrowing this to the main window would instead make the About panel
 * (or the splash, during startup) turn every foreground session into an
 * interruption about something on screen.
 */
const windowFocused = (): boolean =>
  BrowserWindow.getAllWindows().some(
    (window) => !window.isDestroyed() && window.isFocused(),
  );

/**
 * Is this terminal the one **that surface** is already looking at?
 *
 * Both halves, and neither alone is the question. A matching id with the
 * surface behind another app is precisely when the notification is worth
 * raising.
 *
 * Where "focused" comes from depends on the kind, and that asymmetry is the
 * whole design (HIVE-145). A window's is read live from `BrowserWindow`,
 * because a renderer-published boolean goes stale in exactly the case the
 * feature exists for — the window hidden, the app in the background — since the
 * renderer stops running to update it. A socket's is whatever it reported,
 * because this machine's windows say nothing about a laptop four time zones
 * away, and a served Mac has no windows at all.
 *
 * This is the per-surface question, which is what decides whether *this*
 * surface gets a toast. {@link isForeground} is the any-surface one.
 */
const isForegroundFor = (surfaceId: SurfaceId, terminalId: string): boolean => {
  const held = foreground.get(surfaceId);
  if (held === undefined || held.terminalId !== terminalId) return false;
  return surfaces.get(surfaceId)?.kind === 'window' ? windowFocused() : held.focused;
};

/**
 * Is **any** surface already looking at this terminal?
 *
 * The hub's sweep asks this one (`notifications/hub.ts`): may this inbox row be
 * dropped because somebody has seen it. "Any" is its right answer with two
 * devices attached — a row one of them is staring at is a row that has been
 * seen — where "which one" is only the toast's question.
 */
export const isForeground = (terminalId: string): boolean =>
  surfaces.all().some((surface) => isForegroundFor(surface.id, terminalId));

/** Told when foreground state changes, so the re-arm can run (HIVE-81). */
const foregroundListeners = new Set<() => void>();

/**
 * Window focus changed, or the renderer reported a different terminal
 * (HIVE-81). Called from the `CH.uiForeground` handler below, and — via
 * {@link scheduleForegroundChange} — from the app-level window focus events.
 */
export const notifyForegroundChange = (): void => {
  for (const listener of foregroundListeners) {
    try {
      listener();
    } catch (cause) {
      console.error('[hive] foreground listener failed:', cause);
    }
  }
};

/**
 * Subscribe to foreground changes (HIVE-81's re-arm).
 *
 * The only way into `foregroundListeners`, which stays private: the notifier's
 * subscription in `registerIpcHandlers` goes through here, so the path a test
 * exercises is the path production runs.
 *
 * Answers a disposer. Nothing in the shipped app unsubscribes today — the one
 * subscription lives as long as the process — but a subscribe with no way out
 * is a leak waiting for its second caller, and the set was otherwise emptied
 * only by the test-only `resetIpcHandlers`.
 */
export function onForegroundChange(listener: () => void): () => void {
  foregroundListeners.add(listener);
  return () => {
    foregroundListeners.delete(listener);
  };
}

/**
 * A deferred re-evaluation, or `null`.
 *
 * See {@link scheduleForegroundChange} for why the deferral exists at all.
 */
let foregroundTick: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-evaluate foreground state **after the current focus shuffle settles**
 * (HIVE-81 review).
 *
 * ## Why the app-level events, and not the window's own
 *
 * This was wired as `focus`/`blur` on the main window, in `window.ts`, while
 * {@link windowFocused} counts *every* window of ours. The mismatch loses a
 * real notification: main focused with a gated pending row, the user opens the
 * About panel (main blurs, About focuses — still foreground, correctly nothing
 * promoted), then switches to another application. It is **About** that blurs,
 * and nothing was listening to it, so the re-arm never ran. The still-blocked
 * session kept its silent, already-read row for as long as the user was away —
 * exactly the failure the gate exists to prevent.
 *
 * `app.on('browser-window-blur' | 'browser-window-focus')` fires for every
 * window, which is the same set the predicate reads. Wiring the two per-window
 * instead — About, splash, and whatever comes next — is three sites to
 * remember and is the mistake `aux-windows.ts` was written about.
 *
 * ## Why it is deferred by a tick
 *
 * Because the app-level events walk straight into the opposite bug. On macOS
 * `blur` on the outgoing window fires **before** `focus` on the incoming one,
 * so switching from the main window to About passes through a moment in which
 * no window of ours is focused. Evaluating synchronously there promotes a
 * gated row and shows a toast about a session the user can see behind the
 * panel — contradicting {@link windowFocused}'s own reason for counting About
 * as foreground.
 *
 * One timer, coalescing every event that lands before it runs, so the burst of
 * a window switch becomes a single evaluation of the settled state. The re-arm
 * is a decision about whether to interrupt someone who has walked away; a tick
 * of latency is not a cost it can notice.
 *
 * ## The alternative that was rejected
 *
 * Narrowing {@link windowFocused} to `appWindows()` — the non-auxiliary
 * windows — was the other candidate. It *removes* the ordering hazard, and it
 * gets the answer wrong: with About focused no app window is focused, so every
 * gated row would promote with a toast about a terminal visible right behind a
 * small frameless panel. `isAuxiliary` answers "which windows are the app",
 * which is the question `activate` and the updater's dialogs ask. It is not
 * the question "is the app in front of the user", and this is that one.
 */
const scheduleForegroundChange = (): void => {
  if (foregroundTick !== null) return;
  foregroundTick = setTimeout(() => {
    foregroundTick = null;
    notifyForegroundChange();
  }, 0);
  // Never a reason to hold the process open; the app's own windows do that.
  foregroundTick.unref?.();
};

/** Undo {@link watchWindowFocus}, or a no-op before it has run. */
let unwatchWindowFocus: (() => void) | null = null;

/**
 * Wire the app-level focus events. Idempotent: a second call replaces the
 * first rather than doubling the listeners.
 */
function watchWindowFocus(): void {
  unwatchWindowFocus?.();
  app.on('browser-window-blur', scheduleForegroundChange);
  app.on('browser-window-focus', scheduleForegroundChange);
  unwatchWindowFocus = () => {
    app.removeListener('browser-window-blur', scheduleForegroundChange);
    app.removeListener('browser-window-focus', scheduleForegroundChange);
    unwatchWindowFocus = null;
  };
}

/**
 * Guards the env diagnostic against concurrent invokes (story 108's fix
 * round).
 *
 * Every invoke spawns a full interactive login shell that executes the
 * user's rc file, held up to 5s with 512 KiB of buffering — the same shape
 * of cost the pty spawn path caps with `maxSessions`
 * (`pty-host/session-manager.ts`), and this channel had no equivalent cap.
 * The renderer already disables its button while a probe is in flight
 * (`envDiagnosticPending` in `runtime-section.tsx`), but that is renderer
 * state and story 082's posture is that the renderer is untrusted input — a
 * compromised or merely buggy renderer must not be able to multiply this
 * into unbounded concurrent rc-file executions.
 *
 * **Refuses rather than shares the in-flight probe.** Sharing looked
 * simpler at first — return the same promise to every caller while one is
 * running — but the two concurrent requests are not necessarily for the
 * same project: a renderer that fired one probe for project A and, before it
 * resolved, another for project B would get project A's verdict back
 * labelled as an answer to its second call. Refusing with a clear `error`
 * (the exact shape a failed probe already uses) never risks handing back the
 * wrong project's environment.
 */
let envDiagnosticInFlight = false;

/** The live sessions layer, or `null` before registration. Test-only reach-in. */
export function sessionsLayer(): Sessions | null {
  return sessions;
}

/**
 * Starts the server-mode socket (HIVE-142). Resolves the bound `ws://` URL,
 * or `null` on bind failure — see {@link createRemoteListener}'s own `start`.
 *
 * Called from `index.ts`, and only when this run is server mode; every other
 * launch leaves {@link remoteListener} constructed but never started, so no
 * port is ever bound on a machine that never asked for one.
 */
export function startRemoteListener(): Promise<string | null> {
  return remoteListener ? remoteListener.start() : Promise.resolve(null);
}

/**
 * `host:port`, for the tray's informational item — both pieces sourced from
 * what the listener actually bound, not composed from a separate config read
 * (HIVE-142 review, N3). An earlier revision built the displayed address
 * from a host-only accessor plus a fresh `getConfig().server.bind.port`
 * read; that agreed with the socket only by coincidence, because nothing
 * else here reads `server.bind` a second time after construction — a
 * hand-edited port would show in the tray while the already-listening
 * socket, which cannot rebind without a restart, kept answering on the old
 * one. `remoteListenerPort` is the exact number `createRemoteListener` was
 * given, captured once beside it.
 */
export function remoteListenerBoundAddress(): string | null {
  const host = remoteListener?.boundHost ?? null;
  return host === null || remoteListenerPort === null ? null : `${host}:${String(remoteListenerPort)}`;
}

/**
 * Why nothing is bound yet, for the tray's own informational item (HIVE-142
 * review, I3) — `null` on every launch that is not server mode, exactly like
 * {@link remoteListenerBoundAddress} above, since `remoteListener` is
 * constructed unconditionally but only ever started in server mode.
 */
export function remoteListenerBindError(): string | null {
  return remoteListener?.lastBindError ?? null;
}

/**
 * @param broadcaster Where main → renderer pushes go (HIVE-141). Defaults to
 * the windows of this process, which is every caller today; server mode passes
 * one that also writes to attached sockets. Optional rather than required so the
 * boot path and eight existing suites call this exactly as they did.
 *
 * @param switchMode How `config:set-remote` changes this process's IPC mode
 * (HIVE-144). See {@link ModeSwitcher} for why it arrives as an argument
 * rather than as an import, and {@link noModeSwitcher} for why its default
 * throws instead of quietly succeeding.
 *
 * @param attachedServerName What `AppInfo.attachedServerName` answers
 * (HIVE-144 Task 13) — `router.ts`'s own `attachedServerName()`, handed down
 * for the identical reason `switchMode` is: `router.ts` already imports this
 * module, so importing it back would close a cycle. Defaults to a function
 * that always answers `null`, matching what a process with no `router.ts`
 * wrapping it (every existing test that calls this directly) actually is —
 * never attached to anything.
 *
 * @param attachedSnapshot What the attached socket's accept frame carried, or
 * `null` when this process is not attached (HIVE-144 review, I1) —
 * `router.ts`'s own `attachedSnapshot()`, handed down for the same reason
 * `attachedServerName` is. `applySetRemote` calls it either side of the
 * switch, which is how a mode change becomes something the renderer can act
 * on rather than a snapshot the server built and nobody read.
 *
 * @returns `buildAppInfo`, the exact closure this call bound to `CH.appInfo` —
 * over *this* call's own `hooks`, `remoteListener`, `sessions` and
 * `attachedServerName` (HIVE-144, Ruling 24). `router.ts`'s `registerIpc('local',
 * ...)` captures it and later hands it to `registerRemoteProxy` as
 * `localAppInfo`, so `CH.appInfo` answers locally rather than being proxied
 * once this process attaches — see `isProcessLocal`'s own doc comment
 * (`@shared/remote-contract`) for why that channel may never cross the
 * socket. Ignored by every test that calls this function directly for its
 * side effects alone, which is every test on this branch until this one.
 */
export function registerIpcHandlers(
  broadcaster: Broadcaster = createWindowBroadcaster(),
  switchMode: ModeSwitcher = noModeSwitcher,
  attachedServerName: () => string | null = () => null,
  attachedSnapshot: AttachedSnapshot = () => null,
): () => AppInfo {
  /*
    Both surfaces, always (HIVE-143). In local mode the socket half iterates an
    empty set and costs a function call per push; in server mode it is how an
    attached client gets its 22 events. One composition shape rather than a
    mode branch here, because the mode already has exactly one home —
    `registerIpc` in `./router.ts` — and a second one would be the thing that
    drifts.

    The set is resolved per emit rather than captured, which is the whole point:
    a client attaches long after this line has run.
  */
  const fanOut = createFanOutBroadcaster([
    broadcaster,
    createSocketBroadcaster(() => surfaces.sockets()),
  ]);

  const supervisor = registerPtyHost();

  /*
    Fresh per registration, because an `AbortController` aborts once: the one a
    previous registration hung up on would kill every child of the next before
    it had started.
  */
  slackChildren = new AbortController();

  /**
   * One push, every surface — a local window and every attached client alike.
   *
   * This said "one window by design (story 000)" until HIVE-145, and it was
   * true for long enough to be worth recording why it stopped being: a
   * broadcast reached exactly the renderer that owned every session, because
   * there was exactly one. Delivery is still resolved per send rather than
   * captured, for a reason that never changed — the window is created after
   * this runs, on macOS it can be closed and re-created while the app keeps
   * running, and a client attaches whenever it likes.
   *
   * HIVE-141 moved the loop itself into `Broadcaster.emit`. What stayed here is
   * the *tap*, because it is the tap that must not reach every push — see the
   * hub's `broadcast` below.
   *
   * HIVE-143 made the delivery `fanOut` rather than the injected `broadcaster`
   * alone, so the same push reaches attached sockets. The tap is untouched by
   * that: it still runs exactly once, here, before any surface.
   *
   * **Not everything main pushes comes through here.** Two things are targeted
   * at one surface rather than broadcast (HIVE-145): `fs:changed`, which
   * belongs to the surface whose explorer asked for the watch, and
   * `notifications:toast`, which belongs to whoever is not already looking at
   * the session it is about. Both go through `Surface.send`.
   */
  const send = (channel: string, payload: unknown): void => {
    // Story 106 taps the broadcast here rather than at each source, so an event
    // class added later cannot forget to notify. `observe` never throws — a
    // failed notification must not cost a `pty:data`.
    notifier.observe(channel, payload);

    fanOut.emit(channel, payload);
  };

  /**
   * OS notifications (story 106).
   *
   * Mutually recursive with `send` — `send` taps the notifier, and the
   * notifier's `activate` broadcasts through `send`. Both references resolve at
   * call time and nothing broadcasts during registration, so the ordering here
   * is a declaration detail rather than a cycle.
   */
  /**
   * What the rail calls each session (HIVE-110). Read by the hub when it
   * presents a toast; the inbox row needs none of it. See `notifications/names.ts`.
   */
  const sessionNames = createSessionNames();

  /**
   * Raise a toast on **this machine's** desktop.
   *
   * Named and lifted out of the hub's options in HIVE-145: it is no longer the
   * whole of what presenting means. The hub now hands its toasts to
   * `createToastRoute`, which decides which surfaces should be interrupted and
   * calls this only for a local window — an attached client raises its own,
   * because a served Mac's desktop is not where the user is.
   */
  const presentLocally = ({
    title,
    body,
    onClick,
  }: {
    title: string;
    body: string;
    onClick: () => void;
  }): void => {
      // False on a Linux box with no notification daemon. Checked per send
      // rather than once at boot: the daemon can arrive or go away while the
      // app is running, and constructing one when unsupported throws.
      if (!Notification.isSupported()) return;

      const notification = new Notification({ title, body });
      notification.on('click', onClick);
      /**
       * The failure that was being thrown away.
       *
       * `show()` is fire-and-forget and its refusal arrives here, on an event
       * nothing was listening to. Measured on macOS 15 / Electron 43.2.0:
       * `isSupported()` returns `true`, this event fires with `UNErrorDomain
       * error 1` — not authorized — and the app carried on reporting desktop
       * delivery as available. Every "System" notification since has been
       * dropped in silence.
       *
       * Recorded rather than merely logged, because the honest place for it is
       * the settings pane that offers the switch. Logged once per distinct
       * reason so a fleet of blocked sessions cannot fill a terminal with the
       * same line.
       */
      notification.on('failed', (_event, error) => {
        const reason = String(error);
        if (systemNotificationRefusal === reason) return;
        systemNotificationRefusal = reason;
        console.error(
          `[hive] the OS refused a desktop notification — the inbox still has it (${reason})`,
        );
      });
      notification.show();

      /**
       * The dock is what still works when the OS says no.
       *
       * Measured on the same machine that refuses notifications outright:
       * `app.dock.bounce('critical')` and `setBadge` both succeed, because
       * neither needs notification authorization. So the app is not out of ways
       * to reach someone in another window — it was only using the one that was
       * being rejected.
       *
       * Unconditional rather than only on a recorded refusal. A bounce is what
       * `both` already means — *interrupt me* — and gating it on a failure
       * would make the first interruption of every launch the one that gets
       * lost, since the refusal is not known until a send has already failed.
       * `dock` is undefined off macOS, where the badge and bounce have no
       * equivalent and the toast is expected to work.
       *
       * **`informational`, not `critical`.** `critical` maps to
       * `NSCriticalRequest`, which bounces *until the app is activated* — and
       * nothing here ever calls `cancelBounce`. A fleet left overnight would
       * start bouncing at the first session to go quiet and not stop until
       * somebody came back to it, which is not an interruption, it is a fault
       * light. `informational` bounces once, which is the whole of what a
       * notification is entitled to; the **badge** is the part that persists,
       * and it persists honestly because it is a count rather than an alarm.
       */
    app.dock?.bounce('informational');
  };

  /**
   * Open whatever a notification is about.
   *
   * Lifted out of the hub's options in HIVE-145 for the reason `presentLocally`
   * was: the toast queue's flush needs the same behaviour on a click, and a
   * held toast that activated differently from a live one would be a second
   * definition of what clicking a notification means.
   */
  const activateNotification = (action: NotificationAction): void => {
      /**
       * Main focuses the window; the renderer opens the session.
       *
       * Split that way because only main can raise a window and only the
       * renderer knows what opening a session means — and a minimised window
       * has to be restored first, or focusing it does nothing visible.
       */
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue;
        if (window.isMinimized()) window.restore();
        window.focus();
      }

      /**
       * A `url` action goes to the user's browser, through the same allowlist
       * every other outbound link uses (story 081).
       *
       * `isSafeExternalUrl` is not optional politeness here: `shell.openExternal`
       * will happily launch a `file:` URL or a custom scheme registered by some
       * other application, and a notification's URL is data rather than a
       * constant. A `none` action has nowhere to go and is satisfied by the
       * focus above.
       */
      if (action.type === 'url') {
        if (isSafeExternalUrl(action.url)) void shell.openExternal(action.url);
        return;
      }

      /**
       * The update actions carry no data at all, which is what makes them safe
       * to accept from a renderer without validating anything beyond the tag.
       * The updater already holds the version it found; these say only "do the
       * thing you offered", and a stale row clicked after the updater has moved
       * on is answered by whatever the updater's state actually is now.
       */
      if (action.type === 'update.download') {
        void downloadUpdate();
        return;
      }

      if (action.type === 'update.install') {
        void installUpdate();
        return;
      }

      /**
       * An `ask` answers nothing from here (HIVE-118) — it *reveals* the card.
       *
       * A desktop toast is a title, a body and one click; there is no room on
       * it for the options an ask card offers, so the only honest thing a
       * click on one can do is bring the user to where the card lives. That is
       * the whole reason an ask toast, alone among the kinds, does **not**
       * dismiss its row on click.
       *
       * The focus loop above is not enough to keep that promise. It restores
       * and focuses the window and stops there, and the card lives on one of
       * three right-rail tabs on a rail the user can collapse. A user sitting
       * on `explorer` clicked a question and got a file tree — the window
       * forward, and no card and no signal anywhere on it.
       *
       * Main cannot fix that itself: only the renderer may touch the rail. So
       * this says *what happened* and lets the other side decide where that
       * goes, the same split `session` and `agent` already use.
       */
      if (action.type === 'ask') {
        send(CH.notificationsActivate, {
          type: 'ask',
        } satisfies NotificationActivateEvent);
        return;
      }

      /**
       * An `agent` reaches the renderer exactly the way `session` does
       * (HIVE-118): same channel, same event shape, because only the renderer
       * knows what "open" means for either kind of row.
       *
       * `entityId` still means *terminal id* for a session — the reason
       * `useNotificationActivate` on the other end resolves it through
       * `currentRowFor`. An agent has no terminal, so there is no resolution
       * to apply here — but sending its name through unchanged is **not**
       * always the identity function on the other side: `hydrateAgents`
       * documents that an agent's name is a legal session id, so an agent can
       * come to share a name with some session's `terminalId`, and
       * `currentRowFor`'s search loop would then resolve straight past the
       * agent to that session. The renderer is what closes this — it checks
       * `isAgentId` before ever calling `currentRowFor`, so what this sends is
       * still what gets opened even on a colliding name.
       */
      if (action.type === 'agent') {
        send(CH.notificationsActivate, {
          type: 'entity',
          entityId: action.name,
        } satisfies NotificationActivateEvent);
        return;
      }

      if (action.type !== 'session') return;

      send(CH.notificationsActivate, {
        type: 'entity',
        entityId: action.entityId,
      } satisfies NotificationActivateEvent);
  };

  /**
   * Declared before the hub so the arrival flush below can reach it, and
   * before `presentLocally`'s consumer for the same reason: `createToastRoute`
   * closes over collaborators that are all already built by this line.
   */
  const routeToast = createToastRoute({
    surfaces: () => surfaces.all(),
    isForegroundFor,
    present: presentLocally,
    queue: (payload) => { toastQueue.push(payload); },
  });

  const hub = createNotificationHub({
    prefs: () => getConfig().notifications,
    /**
     * Who gets interrupted (HIVE-145).
     *
     * The hub decides *whether* a notification is worth a toast — prefs,
     * delivery, supersession — and that stays here. This decides *who*, which
     * is a question that did not exist while there was one surface: it
     * suppresses per surface rather than globally, sends an attached client the
     * toast to raise itself, and holds the interruption when nobody is looking
     * at all.
     */
    present: routeToast,
    /**
     * Straight to the surfaces, not through `send` (HIVE-75).
     *
     * `send` taps the notifier, and the notifier produces into the hub — so
     * broadcasting a notification through it would feed the hub's own output
     * back into its input. `observe` ignores the channel, so nothing would
     * actually loop today, but the cycle would be one `if` away from existing
     * and nobody would see it coming.
     *
     * `fanOut.emit` rather than a hand-rolled window loop (HIVE-141): the
     * bypass is of the *tap*, not of the fan-out. A remote client that never
     * received these three would show an empty inbox on a busy server, which is
     * exactly the bug a second copy of the loop invites.
     */
    broadcast: (notification) => {
      fanOut.emit(CH.notificationsNew, notification);
    },
    announceRead: (id, unread) => {
      fanOut.emit(CH.notificationsRead, {
        id,
        unread,
      } satisfies NotificationReadEvent);
    },
    announceDismissed: (id) => {
      fanOut.emit(CH.notificationsDismissed, {
        id,
      } satisfies NotificationDismissedEvent);
    },
    /**
     * The count on the dock icon.
     *
     * Empty string, not `'0'`, clears it — that is Electron's API, and a badge
     * reading `0` is a worse lie than no badge, because it says the app has
     * something to report and the something is nothing.
     *
     * Off macOS `app.dock` is undefined and this is a no-op. Windows has a
     * taskbar overlay that would serve the same purpose and needs an icon
     * rather than a string, so it is left for whoever ships a Windows build
     * rather than approximated here.
     */
    announceUnread: (count) => {
      app.dock?.setBadge(count > 0 ? String(count) : '');
    },
    activate: activateNotification,
    now: () => Date.now(),
    isForeground: (action) =>
      action.type === 'session' && isForeground(action.entityId),
    subjectName: (terminalId) => sessionNames.get(terminalId),
  });

  const notifier = createNotifier({ hub, isForeground });

  /**
   * Ledger entries into inbox cards (HIVE-118).
   *
   * Constructed here, alongside the hub, rather than down at `ledger.onChange`
   * — the ledger itself does not exist yet at this point in registration, but
   * the notifier needs none of it: it is pure policy over an entry, called
   * from inside the one listener below.
   *
   * `isAgent` reads `knownAgents`, the same cache `agents:list` fills and
   * `knowsParty` already consults a few lines below — a party id names an
   * agent if that cache has it, and nothing here keeps a second opinion about
   * who is an agent.
   */
  const notifyLedgerEntry = createLedgerNotifier({
    raise: (input) => hub.raise(input),
    markRead: (id) => hub.markRead(id),
    dismiss: (id) => hub.dismiss(id),
    isAgent: (id) => knownAgents.has(id),
  });

  // The re-arm (HIVE-81): whatever is still blocked when the user looks away
  // gets its row promoted back to unread. Through the exported subscriber
  // rather than the set it wraps — one way in, so the set stays private and
  // the function tests reach is the one production runs.
  onForegroundChange(() => {
    notifier.reevaluateForeground();
  });

  // The other half of the same signal: OS window focus, which no renderer can
  // report because a hidden window has stopped running. See
  // `scheduleForegroundChange`.
  watchWindowFocus();

  /**
   * Two property reads and no subprocess, which is the entire point.
   *
   * `integrationsStatus` carries the same two facts and **executes `gh`** to
   * build the rest of its answer. The Notifications pane has to re-ask this
   * while it is open — `systemNotificationRefusal` is only knowable once a
   * delivery has been attempted and turned down — and putting that on the
   * integrations handler would spawn a process every few seconds to read a
   * variable.
   */
  handle(
    CH.notificationsDelivery,
    (): NotificationDeliveryStatus => ({
      supported: Notification.isSupported(),
      refused: systemNotificationRefusal,
    }),
  );

  handle(CH.notificationsList, () => hub.list());
  handle(CH.notificationsMarkRead, (_event, payload) =>
    // Validated, never coerced — the rule every other handler in this file
    // follows. Coercing an accidental `undefined` to `null` would turn a single
    // dismissal into "mark all fifty read", silently and with no error anywhere.
    hub.markRead(parseMarkReadRequest(payload)),
  );
  // Same rule as above, one notch stricter: `parseDismissRequest` refuses
  // `null`, so a lost argument cannot be read as "drop everything".
  handle(CH.notificationsDismiss, (_event, payload) =>
    hub.dismiss(parseDismissRequest(payload)),
  );
  // No payload, so there is nothing to validate and nothing to lose on the way
  // in — which is the whole argument for this being its own verb rather than
  // `dismiss(null)`. See `CH.notificationsClear`.
  handle(CH.notificationsClear, () => {
    hub.clearInbox();
  });

  /**
   * Now the hub exists, the updater has somewhere to raise into.
   *
   * Registered here rather than in `updates/index.ts` because the hub is built
   * in this function and nothing outside it holds a reference. The updater is
   * constructed lazily and may exist before this runs; it drops notifications
   * raised into an empty sink, which can only happen in the moments before the
   * first check is even scheduled.
   */
  setUpdateNotificationSink((input) => {
    hub.raise(input);
  });

  /**
   * Route a clicked row's action, through the same `activate` a desktop toast
   * uses. `parseNotificationAction` is what keeps this from being a hole: the
   * payload is renderer-supplied, and an unrecognised shape is dropped rather
   * than passed along to a switch that might have a permissive default.
   */
  handle(CH.notificationsAct, (_event, payload) => {
    const action = parseNotificationAction(payload);
    if (action !== null) hub.activate(action);
  });

  handle(CH.updatesStatus, (): UpdateStatus => updateStatus());
  handle(CH.updatesCheck, () => checkForUpdatesInteractively());

  /**
   * The hook pipeline is constructed here and started by `createSessions`
   * (HIVE-62).
   *
   * Constructed rather than started, because starting it needs two things only
   * the session layer has: whether an entity is a live session, and where a
   * status event should go. Handing it over unstarted keeps that knowledge in
   * one place instead of duplicating a registry lookup here.
   *
   * `app.getPath('userData')` is the app's own directory. Nothing about this
   * touches `~/.claude`.
   */
  /**
   * The session history, beside `window-state.json` in the app's own directory
   * (HIVE-87).
   *
   * Constructed before the session layer because that layer takes it as an
   * option. Nothing about it touches `~/.claude` — it records what The Hive
   * knows about its own rows, not anything Claude wrote.
   */
  history = createSessionHistory(
    join(app.getPath('userData'), SESSION_HISTORY_FILE),
  );

  /**
   * The ledger lives beside the config, not in `userData` (HIVE-111).
   *
   * `~/.hive/` is the user's own directory — the one they can open, read and
   * back up. A correspondence log between their agents belongs there for the
   * same reason the config does, and `userData` belongs to the app.
   *
   * `knowsParty` closes over `sessions`, which is `null` at this point in
   * startup and assigned below — safe because the closure runs on every read
   * and write, always after registration, never at construction.
   *
   * The `history.resumable` arm is **not** what lets an ended session keep
   * writing, and today nothing reaches it. Every out-of-process caller arrives
   * through the receiver, whose `reject()` answers `404` off the *live* pty
   * registry before `knowsParty` is ever consulted — so an ended session's
   * writes are already refused a layer earlier, and the only caller that gets
   * this far is the overmind over IPC. What the arm does is state the rule
   * this predicate is meant to hold: a party is an *identity*, not a process,
   * so if the gate in front of it is ever widened (a background agent posting
   * for a session that has closed, HIVE-112 onward), the ledger will not be
   * the layer that refuses.
   */
  const ledger = createLedger({
    dir: join(dirname(configPath()), LEDGER_DIR),
    knowsParty: (id) =>
      id === OVERMIND ||
      (sessions?.entities().includes(id) ?? false) ||
      /*
        The widening the comment above anticipated (HIVE-115).

        `PartyKind` has named `'agent'` since HIVE-111 and nothing could be one:
        an agent is not a pty session and never will be, so the two arms above
        refused every ledger write a run makes — including the `run.started`
        and `run.ended` entries that are the *only* durable record that a wake
        happened. A party is an identity, not a process, and this is the arm
        that finally says so.

        It is a set of names read off `~/.hive/agents`, not a pattern: a name
        that is not a folder on this machine is still refused, so the rule is
        no looser than the two above it — it is the same rule applied to a
        second register of identities.
      */
      knownAgents.has(id) ||
      history?.resumable(id) !== undefined,
  });

  /**
   * Delivery — what happens to an entry after it is written (HIVE-113).
   *
   * Lazy accessors rather than the session layer itself, for the reason
   * `knowsParty` above reaches for it through `?.`: `sessions` is a
   * module-level binding initialised *after* this point.
   *
   * `write` reports whether the line landed, and that return value is load
   * bearing rather than defensive — `deliver` records a receipt only on a
   * successful write, and a receipt for a nudge that never reached a terminal
   * would suppress the retry forever.
   */
  const deliver = createDeliver({
    ledger,
    isLive: (id) => sessions?.entities().includes(id) ?? false,
    isIdle: (id) => sessions?.isIdle(id) ?? false,
    // `Sessions.write` reports whether the bytes reached a pty — it answers
    // false for an unknown id and for a session still bootstrapping, where the
    // input is queued and may never be sent. Passed straight through, because
    // `deliver` records a receipt on the strength of it.
    write: (id, text) => sessions?.write(id, text) ?? false,
  });

  /*
    A surface going away resets what it was holding (HIVE-135, HIVE-145).

    This was `watchReporter`: a `WeakSet` of senders, each wired to call
    `deliver.onRendererReset()` on reload, crash or close. The dedupe, the
    duck-typed `on` and the three lifetime events all moved into
    `createSurfaceRegistry`, which does the same job for one more reason —
    every other per-surface consumer needs the same announcement, and five
    private copies of this loop would be five chances to disagree about who is
    live.
  */
  /*
    Somebody is looking again, so raise what was held while nobody was
    (HIVE-145).

    On the empty-to-non-empty edge, not on every arrival: a second device
    attaching to a server the first is already watching has missed nothing, and
    replaying to it would interrupt about events the surface beside it was told
    of at the time. The queue is emptied by the flush, so the toasts route
    exactly once — through the same router, which means the arriving surface's
    own foreground state still suppresses what it is already looking at.
  */
  surfaces.onFirst(() => {
    for (const held of toastQueue.flush()) {
      routeToast({
        ...held,
        /*
          The same click behaviour a live toast has, built from the same two
          pieces (HIVE-81, HIVE-118): dismiss the row, except for an `ask`,
          whose click reveals the card rather than answering it and must not
          delete the thing it was meant to reveal.
        */
        onClick: () => {
          if (held.action.type !== 'ask') hub.dismiss(held.id);
          activateNotification(held.action);
        },
      });
    }
  });

  surfaces.onGone((surfaceId) => {
    deliver.onSurfaceGone(surfaceId);
    /*
      Release whatever this surface was holding of every session's flow-control
      window (HIVE-145). Without it a slow client could freeze a session for
      everyone else simply by disconnecting: its mark would sit at the bottom
      of the window forever, and nothing would ever release the bytes it was
      never going to acknowledge.
    */
    sessions?.releaseSurface(surfaceId);
    /*
      And its watcher, or the mini accumulates one recursive `FSEvents` stream
      over a whole repository per device that ever attached.
    */
    fsWatch?.release(surfaceId);
    /*
      A surface that has gone is looking at nothing, so its stage must not go
      on suppressing notifications for the session it last had (HIVE-145).
      Announced, because the hub's re-arm is what re-raises a row this surface's
      presence was holding down.
    */
    if (foreground.delete(surfaceId)) notifyForegroundChange();
  });

  /**
   * One entry landed, from any party — pushed the way `notifications:new` is
   * (HIVE-75): straight to every window rather than through `send`, because
   * there is nothing here for a tap to loop back into.
   *
   * One subscription, three jobs (HIVE-113, HIVE-118). The renderer's mirror,
   * the terminal nudge and the inbox notifier read the same entry in the same
   * order; separate subscribers could not be made to disagree about that order
   * today, but registration order is an accident and this states it in code
   * instead — the broadcast lands first, then delivery, then the notifier.
   */
  ledger.onChange((entry) => {
    // Not `send`: the notifier reads the ledger through its own subscription
    // below, and tapping here would show it every entry twice. HIVE-141 routes
    // the fan-out through the broadcaster all the same.
    fanOut.emit(CH.ledgerChanged, entry);
    /**
     * Neither delivery nor the notifier may fail the write that triggered them.
     *
     * This listener runs *inside* `Ledger.append`'s own try/catch, so a throw
     * from the pty on the way to a terminal would be reported to the party who
     * appended as `500 could not write the ledger` — for an entry that is
     * already safely on disk. The console would print a red failure and the
     * user would ask again, producing a duplicate of a question that was in
     * fact recorded. The append succeeded; only the telling failed.
     */
    try {
      deliver.onEntry(entry);
    } catch (cause) {
      console.warn(`[ledger] could not deliver ${entry.id}:`, cause);
    }
    /*
      The third and fourth consumers, sequenced against each other (HIVE-120,
      HIVE-119): an entry addressed to an agent is a wake, and an answer to a
      permission ask is also a grant that has to reach `AGENT.md` before that
      same wake reads the file.

      Every other entry — including an ordinary answer — schedules
      synchronously, exactly as `deliver` above did: there is nothing to write
      first, because an ordinary answer is only ever news arriving. A
      *permission* answer is the one exception, and the exception is
      load-bearing: `onAnswer` may still be writing the granted rule into
      `AGENT.md` when the wake it triggers would otherwise read that same
      file — race it, and a user's "allow for this agent" click retries into
      a second denial. It does not fail every time, because the write is
      fast; that is exactly what makes it easy to ship and hard to notice.
      `permissions.isPermissionAnswer` is what tells the two cases apart, so
      only the answer with a dependency waits for it. Reversing the order
      here — scheduling before the grant is written — silently breaks
      Allow-for-this-agent, and nothing in the types stops it; the live
      conformance suite's fence scenario (HIVE-119) is what would catch it.

      Both keep their own try/catch, for the same reason `deliver` above is
      guarded: a throw here runs inside `Ledger.append`'s own call stack and
      must not be reported to the party who appended, for an entry already
      safely on disk. `.finally`, not `.then`, on the permission path: a
      grant that failed to write must still wake the agent, so it can retry,
      be denied again, and report — not be stranded with no wake at all.
      `permissions` is read through the module binding rather than closed
      over, exactly as `scheduler` is: both are armed later, once `agents`
      and `ledger` exist, not at the point this listener is wired.
    */
    const schedule = () => {
      try {
        scheduler?.onEntry(entry);
      } catch (cause) {
        console.warn(`[ledger] could not schedule ${entry.id}:`, cause);
      }
    };

    if (entry.kind === 'answer' && permissions?.isPermissionAnswer(entry) === true) {
      permissions
        .onAnswer(entry)
        .catch((cause: unknown) => {
          console.warn(`[ledger] could not grant on ${entry.id}:`, cause);
        })
        .finally(schedule);
    } else {
      schedule();
    }
    try {
      notifyLedgerEntry(entry);
    } catch (cause) {
      console.warn(`[ledger] could not notify on ${entry.id}:`, cause);
    }
  });

  handle(CH.ledgerList, (_event, payload) => ledger.read(parseLedgerReadQuery(payload)));
  handle(CH.ledgerPost, (_event, payload) =>
    /*
      `from` is supplied here, never taken from the renderer — the same rule
      the receiver enforces with the session header. The renderer is the
      overmind's only mouth.
    */
    ledger.append({ ...parseLedgerPostBody(payload), from: OVERMIND }),
  );
  handle(CH.ledgerAnswer, (_event, payload) =>
    ledger.answer(parseLedgerAnswerRequest(payload), OVERMIND),
  );

  /*
    Constructed before the session layer, which takes it as an option and syncs
    it on every spawn (HIVE-96). `app.getVersion()` is read here rather than
    inside the runtime so that module's tests can run under plain Node — the
    same reason `userDataPath` is passed in rather than resolved there.
  */
  /*
    Hoisted out of the `createSessions` call it used to be an argument to,
    because the skills runtime now reads one value off it (HIVE-93). The two
    stay independent — `doneUrl` is passed as a getter, not as the runtime —
    and this is the only line where they meet.
  */
  const hooks = createHookRuntime({
    userDataPath: app.getPath('userData'),
    // Read per call, so a config reload is picked up (HIVE-79).
    sessionMetrics: () => getConfig().sessionMetrics,
    // The same, for the hostname a container reaches this machine by (HIVE-132).
    hostAlias: () => getConfig().receiver.hostAlias,
    // Every hostname the guard admits, not just the global one — see
    // `hostAliases`'s own doc comment above for why (HIVE-134 follow-up).
    hostAliases,
    /*
      Read once, not per call like `hostAlias` above it. A socket that is already
      listening cannot be moved, so a getter here would imply a rebind that never
      happens — Settings tells the user it takes effect at next launch, and this
      is why (HIVE-134).
    */
    bind: getConfig().receiver.bind,
    /*
      Resolved through the same `effectiveRuntime` the spawn path uses
      (HIVE-133), so `writeContainerSession` writes for exactly the project a
      session would actually launch under — a diagnostic-style helper that
      resolved its own runtime here would eventually diverge from the one a
      spawn uses. A `null` or unknown `projectId` finds no project, which
      `effectiveRuntime` already reads as "no container" for the top-level
      command.
    */
    containerFor: (projectId) =>
      effectiveRuntime(
        getConfig(),
        getConfig().projects.find((entry) => entry.id === projectId) ?? null,
      ).container,
    ledger,
  });

  /**
   * The server-mode socket (HIVE-142), constructed beside the receiver
   * above: same file, same composition pass, same reason for existing —
   * paired devices reach this Hive over the network the way Claude Code's
   * hooks reach the receiver.
   *
   * Built unconditionally, on every launch, but only `start()`-ed from
   * `index.ts` when this run is server mode — see {@link startRemoteListener}.
   * `bind` is read once, not through a getter, for the same reason `hooks`'s
   * `bind` above is: an already-listening socket cannot be moved, and
   * Settings says as much (HIVE-134's rule, restated for HIVE-142).
   */
  /*
    Captured once, not read again later through `getConfig()` — this is the
    exact `port` `createRemoteListener` below binds to, and it is what
    `remoteListenerBoundAddress()` (below `registerIpcHandlers`) composes the
    tray's displayed address from (HIVE-142 review, N3). Before that fix, the
    tray built its address from a *separate*, later `getConfig().server.bind.port`
    read — harmless while the config cache was frozen for the process's whole
    life, but no longer once reads elsewhere started calling `reloadConfig()`:
    a hand-edited port would then show in the tray while the socket, which
    cannot rebind without a restart, kept listening on the old one.
  */
  const serverBind = getConfig().server.bind;
  remoteListenerPort = serverBind.port;
  remoteListener = createRemoteListener({
    bind: serverBind,
    /*
      `readServerDevicesFromDisk()`, not `getConfig()`/`reloadConfig()`
      (HIVE-142 review, N1). `getConfig()` answers this process's cached
      `ConfigSnapshot`, permanently frozen at boot; `reloadConfig()` re-reads
      the file but also **installs the result as that same shared cache** —
      and this getter is called from `listener.ts`'s connection handler
      *before* `verifyDevice`, i.e. from an unauthenticated peer that has
      merely reached the socket. Swapping `projects`, `env`, `shell`, `jira`,
      `slack` and `receiver` for every subsystem in this process from a path
      nothing has vouched for yet is not a contract this story gets to
      change — and `reloadConfig()` skips the invalidations a real reload
      performs (`forgetProbedRoots()`, `slackBridge?.sync()`, below), so its
      result could visibly disagree with the rest of the process besides.
      `readServerDevicesFromDisk()` (`server/file-backed-io.ts`) reads the
      file itself and returns only `server.devices`, installing nothing.
    */
    devices: readServerDevicesFromDisk,
    // What a client's header indicator renders: "attached · <serverName>".
    // The machine's own hostname identifies *which* served Mac a client is
    // looking at, which matters once more than one exists.
    serverName: hostname(),
    /*
      The module-scope registry (HIVE-143) — the same one `handle` and `on`
      above record into, which is what makes a socket's `call` reach the
      handler a renderer's `invoke` would have reached. It is fully populated
      by the time any socket can attach: `registerIpcHandlers` fills it as it
      registers, and `startRemoteListener` is called later, from
      `electron/main/index.ts`. A registry built here instead would be empty
      forever and every call would answer `not-ready`.
    */
    dispatch: createRemoteDispatch(remoteRegistry),
    // What `AttachAccepted.snapshot` carries (HIVE-144) — built fresh per
    // attach, over the same `remoteRegistry` `dispatch` reads.
    buildSnapshot: buildAttachSnapshot,
    onAttach: (socket, resumeFrom) => {
      /*
        Added to the set **before** anything is replayed. A `pty:data` landing
        during the loop below is then delivered after the frames it follows —
        out of order would be worse than a gap, because the client's seq
        assertion would fire on a discontinuity that never happened.
      */
      surfaces.trackSocket(socket);
      if (resumeFrom === undefined) return;

      /*
        Captured into a local so it narrows to non-null across the whole loop
        below (HIVE-144 review). `sessions` is a mutable module-scope `let`;
        TypeScript will not carry a null check on it across the `.resume` call
        two lines down, so without this every later read would still be
        `Sessions | null` and need its own `?.` — which is exactly what
        produced the `?? point.gen` fallback this review flagged as
        disagreeing with its own comment. A server with no `sessions` at all
        has nothing to replay, which is the same outcome the old per-entity
        `?? null` produced, just decided once instead of on every entity.
      */
      const activeSessions = sessions;
      if (activeSessions === null) return;

      for (const [sessionId, point] of Object.entries(resumeFrom)) {
        /*
          Keyed by **entity** id, which is what a client's `pty:data` frames
          carry: `sessions/index.ts`'s `forward` rewrites the pty session id to
          the entity id on the way out, so the ids a client holds are the ones
          `Sessions.resume` maps back. `point` is `{ gen, seq }` (HIVE-144) —
          see `AttachRequest.resumeFrom` for why a bare seq was insufficient.
        */
        const result = activeSessions.resume(sessionId, point);
        /*
          `null` — no such live session on this server. The client is holding a
          session id from a previous run, or from one that has since exited;
          nothing to send, and its own exit handling already covers a session
          that never reappears.
        */
        if (result === null) continue;

        if (result.kind === 'replay') {
          for (const event of result.events) {
            socket.send({ kind: 'event', channel: CH.ptyData, payload: event });
          }
          continue;
        }

        /*
          `gap` — the ring no longer reaches back to `lastSeq`, so what this
          client missed cannot be handed to it. One **empty** `pty:data`,
          stamped at the session's current head seq, is what it gets instead
          (HIVE-143 review).

          That single frame does two things and nothing else. Its seq is not
          `lastSeq + 1`, so the client's existing discontinuity check fires the
          moment the frame lands and writes the gap notice into the transcript
          in the place the hole actually is (`src/lib/terminal/pty-transport.ts`);
          and its chunk is empty, so the write that follows the check puts
          nothing on screen. No new frame type, no protocol change — the client
          already handles exactly this shape.

          The alternative this replaces was to send nothing and let the next
          live batch raise the notice, which is right only while there *is* a
          next batch. Reattaching to a session that has gone idle — a build that
          finished while the client was away is the ordinary case — produced no
          frames at all, so the client redrew its cached transcript with an
          unmarked hole in it, and the notice arrived much later, if ever,
          reading as a new gap rather than as this reconnect's.

          The design sketched a different fallback — resend the whole
          transcript, stamped with the ring's head seq — and that is still
          deliberately **not** implemented, for two reasons that point the same
          way. Mechanically, there is no transcript in main to send:
          `PtyHostSupervisor` has no `replay`, the only `replay()` in the tree is
          `SessionManager`'s inside the pty-host **child process** with no
          protocol message to reach it, and the design is equally explicit that
          `pty-host-protocol.ts` does not change here. Adding one would also make
          this callback asynchronous and cost the ordering guarantee above.
          Behaviourally, it would be wrong even if it were free: this is a
          *reconnecting* client that already rendered everything up to `lastSeq`
          into its own terminal, so a whole transcript would duplicate hundreds
          of lines rather than fill a hole. A client with nothing on screen sends
          no `resumeFrom` at all.

          `gen` on this frame is the entity's **live** generation
          (`activeSessions.generationFor`), never `point.gen` — the client's
          own value is exactly the stale one a restart invalidated, whether
          the gap here came from a generation mismatch or from the ring simply
          not reaching back far enough within the same generation. Stamping
          anything else would hand a discontinuity check keyed on `gen` a
          value it will never see again: the very next live batch already
          carries the true live generation, and a mismatch between *that* and
          a wrong marker would read as a second, spurious gap on top of the
          real one (HIVE-144).

          The `!` is not a shortcut past a real "no generation" case: `result`
          is non-null here, which `activeSessions.resume` only answers once
          `registry.sessionFor(sessionId)` has already resolved — the same
          lookup `generationFor` reads its answer from (`registry.ts` keeps
          the two in step) — so this entity is provably live one line above.
          `generationFor`'s return type stays `number | undefined` because
          most of its callers *do* need to ask about an entity that might not
          be, and narrowing it to `number` just for this call site would only
          move the lie into the type instead of removing it.
        */
        socket.send({
          kind: 'event',
          channel: CH.ptyData,
          payload: { sessionId, chunk: '', seq: result.seq, gen: activeSessions.generationFor(sessionId)! },
        });
      }
    },
    /*
      One removal, two triggers (HIVE-145). The listener's `close` handler
      fires the socket's own `destroyed` listeners and then calls this, and
      both converge on `untrack`, which is idempotent — so `onGone` reaches
      every per-surface consumer exactly once however the socket went away.

      Both are kept rather than one, because they cover different holes: the
      `destroyed` path is what a surface with a lifetime announces for itself,
      and this is what removes a handle that never had one.
    */
    onDetach: (socket) => {
      surfaces.untrack(socket);
    },
  });
  /*
    Registered here, immediately, rather than folded into the large combined
    teardown hook below that finalizes every live run and calls `closeAll` —
    the ordering this file documents throughout (HIVE-120, HIVE-124):
    `runShutdown` invokes every hook body, in registration order, before
    awaiting any of them. Registering the socket's teardown first means its
    synchronous work — terminating every attached client — runs before that
    later hook's synchronous steps do, so nothing can arrive on this socket
    asking for something `closeAll` is already tearing down.

    That stopped being a precaution with HIVE-143 and became the thing keeping
    this safe. `dispatch` above is a real router now, and `DEVICE_GRANT` in
    `remote-dispatch.ts` is `'execute'` — so a paired device reaches `pty:spawn`
    and `agents:run` over this socket, and either can start a process. What
    makes the ordering sufficient rather than merely first: `listener.stop()`
    terminates every attached client synchronously, inside its own promise
    executor, so by the time `runShutdown` reaches the combined hook there is no
    socket left to deliver a frame; and `agents:run` awaits the memoised
    `mcp.start()`, so even a call already in flight cannot reach a spawn ahead
    of a teardown that has begun.
  */
  onShutdown(() => remoteListener?.stop());

  skills = createSkillsRuntime({
    userDataPath: app.getPath('userData'),
    version: app.getVersion(),
    /*
      Read at every regeneration rather than captured here: this runs before the
      receiver has bound, so a value read now would be `null` for the life of the
      app. `sync()` happens before every spawn, which is always afterwards.
    */
    doneUrl: () => hooks.doneUrl(),
  });

  /*
    HIVE-115. `agents.json` is opened a few dozen lines below, which is why the
    state is reached through a closure rather than handed over as a value: a
    delete or a rename can only happen once the app is up, by which time
    `agentState` is set.
  */
  agents = createAgentsRuntime({
    runFiles: createAgentRunFiles({
      state: () => agentState,
      workdir: agentWorkdir,
    }),
  });
  /*
    The same non-nullable alias `agentRunState` is, and for the same reason:
    `permissions` is composed well below this line and reads it from inside a
    closure, where TypeScript widens a captured `let` back to its declared
    type regardless of what was just assigned. `agents` is unconditionally set
    the line above, so the value this captures can never actually be `null`.
  */
  const agentRegistry = agents;

  /*
    The folder changed — on disk, or through the pane. Broadcast to every live
    window the way `ledger.onChange` above does, and with no payload: the
    renderer re-`list`s, which keeps this push incapable of carrying anything
    `agents:list` would not already return.
  */
  agents.onChange(() => {
    refreshKnownAgents();

    fanOut.emit(CH.agentsChanged, undefined);
  });

  refreshKnownAgents();

  /*
    The MCP config runtime (HIVE-112). Written once, its content depends only
    on where the app is installed and where its own bundle sits, and neither
    moves while the app runs.

    `import.meta.dirname` is `out/main/` in both dev and a packaged build, which
    is where `mcp-host.js` is emitted — the same resolution `pty-host` uses.

    Fired here, unawaited, so a slow write cannot delay the first window — the
    same reasoning `startLoginEnvImport` gives in `main/index.ts`. That leaves
    a window between construction and the write settling in which
    `configPathFor()` reads `null`; the `ptySpawn` and `ptyRestart` handlers
    close it by `await`-ing the same memoised promise (`mcp.start()`) before a
    session can be spawned, exactly as they already `await loginEnvStatus()`.
  */
  const mcp = createMcpRuntime({
    userDataPath: app.getPath('userData'),
    execPath: process.execPath,
    scriptPath: join(import.meta.dirname, 'mcp-host.js'),
  });
  void mcp.start();

  /**
   * The agent runtime (HIVE-115) — where the six modules under
   * `main/agents/` finally meet something real.
   *
   * It is composed here rather than inside `createAgentsRuntime()` because
   * every dependency it needs belongs to a *different* layer of this file:
   * the hook settings path and the hook environment come from `hooks`, the
   * `--mcp-config` path from `mcp`, the ledger from `ledger`, the binary from
   * `getConfig()`, and the pushes from `send`. A composition root is exactly
   * the place that is allowed to know all of them at once; `agents/index.ts`
   * is not, and would have had to grow five constructor arguments to become
   * one.
   *
   * The ordering is load-bearing in one place only: `mcp` is constructed a few
   * lines above, and this reads its path through a getter rather than a value,
   * because the config is written asynchronously and `configPathFor()` answers
   * `null` until it lands. The `agents:run` handler closes that window the same
   * way `ptySpawn` does — by `await`-ing the memoised `mcp.start()`.
   */
  agentState = createAgentState({ path: agentStateFile() });
  /*
    The same object under a non-nullable name, for the two composition sites
    below that need it as a value rather than as a maybe. The module binding
    stays because handlers registered here run long after this function has
    returned; a `const` is what lets the scheduler take it without a guard that
    could only ever be false.
  */
  const agentRunState = agentState;

  /*
    One generator, two readers. `createWakeCommand` mints the uuid a *first*
    wake starts under; `createRunTracker` mints the one a rotation's next
    session will start under. A second function here would be a second place to
    change if uuids ever stop being `randomUUID()`.
  */
  const newUuid = (): string => randomUUID();

  /**
   * Read per call, not captured: a `claudeCommand` edited in Settings must
   * reach the next run without a restart. There is no per-project override to
   * resolve — an agent belongs to no project, and neither does Slack's status
   * read (HIVE-123), which reuses this exact resolver rather than resolving
   * the binary a second time or hard-coding `'claude'`.
   */
  const claudeCommand = (): string => getConfig().claudeCommand;

  const buildWakeCommand = createWakeCommand({
    agentsRoot,
    workdir: agentWorkdir,
    promptFile: (name) => agentPromptFile(app.getPath('userData'), name),
    pluginDir: () => join(app.getPath('userData'), PLUGIN_DIR),
    // The agent-space file, never `hooks.settingsPathFor()`: that one carries
    // no `permissions.ask` rule, and a wake started against it would run with
    // no fence at all (HIVE-119).
    agentSettingsPath: () => hooks.agentSettingsPathFor(),
    mcpConfig: () => mcp.configPathFor(),
    hiveServer: () => mcp.hiveServerSpec(),
    agentMcpFile: (name) => agentMcpConfigFile(app.getPath('userData'), name),
    hookEnv: (name) => hooks.envFor(name),
    claudeCommand,
    subscriptionAuth: () => getConfig().subscriptionAuth,
    state: agentState,
    env: () => process.env,
    newUuid,
    // `permissions` is armed later, alongside `scheduler` — read through the
    // module binding for the same reason `hooks`/`mcp` are read through
    // getters here rather than closed over as values.
    pendingGrants: (name) => permissions?.grantsFor(name) ?? [],
    // HIVE-137. The container agent's settings file lives in the container
    // set `hooks` writes at start, and the alias is the receiver's global one,
    // read live so a config reload is honoured on the next wake.
    userDataPath: () => app.getPath('userData'),
    hostAlias: () => getConfig().receiver.hostAlias,
    agentContainerSettingsPath: (config) => hooks.agentContainerSettingsPathFor(config),
  });

  /**
   * Did this run leave an ask nobody has answered?
   *
   * By the run's own stamp (HIVE-128). The MCP host writes `meta.run` on every
   * entry a run posts, so this no longer has to guess from "at or after this
   * run's `run.started`" — which could not tell two concurrent runs apart. An
   * entry with no stamp predates the field and belongs to no live run.
   */
  const openAsksFor = (name: string, run: string): boolean => {
    const { openAsks } = ledger.read({ from: name });

    return openAsks.some((ask) => ask.from === name && ask.meta?.['run'] === run);
  };

  /**
   * Does this agent have any ask nobody has answered, from any run?
   *
   * The stamp-blind question, which is the one a *resting* status has to ask.
   * `openAsksFor` is per-run because a run's own outcome is per-run; but the
   * status belongs to the agent, and a task run that closes while a sibling is
   * still live leaves its question behind for whichever run closes last to
   * find. `agents:resume` recomputes from exactly this, for the same reason.
   */
  const hasOpenAsk = (name: string): boolean =>
    ledger.read({}).openAsks.some((ask) => ask.from === name);

  /** The handoff this run posted, if any — the last one wins (HIVE-122, HIVE-128). */
  const handoffFor = (name: string, run: string): string | undefined => {
    const { entries } = ledger.read({ from: name });

    return entries.findLast(
      (entry) => entry.kind === 'handoff' && entry.meta?.['run'] === run,
    )?.body;
  };

  /**
   * One agent's row changed. Pushed through `send`, so the notifier tap and the
   * destroyed-window guard apply here exactly as they do to a `pty:data`.
   *
   * Built from `agents.json` rather than from arguments: the tracker calls this
   * *after* it has written the state, so reading the file back is what keeps
   * the push and the next `agents:list` from being able to disagree.
   */
  const pushAgentStatus = (name: string): void => {
    const state = agentState?.read(name);

    if (state === undefined) return;

    const last = state.runs[state.runs.length - 1];
    const cost = formatRunCost(last?.costUsd);

    send(CH.agentsStatus, {
      name,
      status: state.status,
      // What is in flight right now, straight from the tracker (HIVE-128).
      live: runs?.liveRuns(name) ?? [],
      ...(state.lastRunAt === undefined ? {} : { lastRunAt: state.lastRunAt }),
      ...(state.nextRunAt === undefined ? {} : { nextRunAt: state.nextRunAt }),
      /*
        The history rides along (HIVE-116). The view's `Today` tile is a count
        and a sum over the day's runs, and it has to move the moment a run
        closes — the alternative was an `agents:changed` on every close, which
        re-reads and re-parses every definition on disk to learn one number
        this function already has in hand.
      */
      runs: state.runs,
      runsSinceRotate: state.runsSinceRotate,
      ...(state.sessionUuid === undefined ? {} : { sessionUuid: state.sessionUuid }),
      /*
        And the two numbers `runs` cannot answer (HIVE-121): the day's totals,
        which outlive the twenty-run history, and the skip count, which counts
        wakes that deliberately produced no run at all.
      */
      ...(state.today === undefined ? {} : { today: state.today }),
      ...(state.skipsSinceRun === undefined
        ? {}
        : { skipsSinceRun: state.skipsSinceRun }),
      ...(cost === undefined ? {} : { cost }),
    } satisfies AgentStatusPush);
  };

  runs = createRunTracker({
    /*
      `spawn` is injected rather than imported by `runs.ts`, which is what lets
      that module's tests drive a recording fake without a real process. The
      cast is the one place the real signature meets the structural one:
      `ChildProcess.stdout` is `Readable | null`, and it is `null` only for a
      stdio mode this call does not use — `runs.ts` passes
      `['ignore', 'pipe', 'pipe']`, which is what makes both pipes non-null.
    */
    spawn: (file, args, options) =>
      spawn(file, [...args], options as SpawnOptions) as unknown as ChildLike,
    /*
      Handed straight through. The tracker passes the trigger it was called
      with, so the wake prompt and the `run.started` ledger entry are spelled
      from one value rather than from two that could disagree.
    */
    command: (name, trigger, extra, options) => {
      const built = buildWakeCommand(name, trigger, extra, options);

      /*
        Proof of existence, taken at the strongest moment there is. Building a
        command meant reading this agent's definition off main's own disk, so
        the ledger may accept it as a party — which it must, or the
        `run.started` entry on the very next line is refused 404 and the log
        has no record that this run ever happened.
      */
      if (!('problem' in built)) knownAgents.add(name);

      return built;
    },
    // The watcher's cache, filled in the same pass as `agentSchedules` (HIVE-128).
    parallelFor: (name) => agentParallel.get(name) ?? AGENT_LIMIT_DEFAULTS.parallel,
    state: agentState,
    /*
      The receiver's per-run grants registry, for `approve` over HTTP
      (HIVE-137). Read through `hooks` on each call rather than captured,
      because the receiver binds after this composition runs — a value taken
      here would be `null` for the life of the app.
    */
    grants: {
      set: (run, owner, grants) => hooks.receiverGrants()?.set(run, owner, grants),
      delete: (run) => hooks.receiverGrants()?.delete(run),
    },
    /*
      A run's own entries are `from` the **agent**: a run is the agent's
      activity and the log is read back by name. That is the same rule
      `ledger:post` enforces from the other direction, where the renderer may
      only ever speak as the coordinator.

      The one exception is main's own verdict — the failed-rotation event
      (HIVE-122), which is `from` the overmind precisely because it is a claim
      *about* the agent that the agent must not be able to make about itself.
      The tracker picks the `from`; this only carries it.
    */
    appendLedger: (entry) => {
      const result = ledger.append(entry);

      /*
        Logged, never discarded. The only way this refuses is a party rule —
        an agent whose name is no longer in `knownAgents` — and the entry it
        drops is a `run.started` or a `run.ended`, so the symptom is a log with
        a beginning and no end and no visible cause. Loud here is cheap;
        silence here costs whoever reads that log an afternoon.
      */
      if (!result.ok) {
        console.warn(
          `[hive] ledger refused ${entry.body} for ${entry.from} (${result.status}):`,
          result.reason,
        );
      }
    },
    openAsksFor,
    hasOpenAsk,
    handoffFor,
    newUuid,
    pushStatus: pushAgentStatus,
    pushLines: (name, lines) => {
      /*
        Sent as they are folded, with no second layer of batching.

        `pty:data` batches because a pty emits bytes at keystroke granularity
        and thirteen of them can be live at once. This is one headless process
        writing whole `stream-json` events, and `foldRunLog` has already
        collapsed each one into at most a few lines — so a batching timer here
        would add latency and a shutdown-flush obligation to buy nothing.
      */
      send(CH.agentsLines, { name, lines } satisfies AgentLinesPush);
    },
    /*
      The queue's other end (HIVE-120). Reached through the binding because the
      scheduler is built from `runs`, three lines below — and it must be told
      *after* the status is written, which is where `finalizeRun` calls this.
    */
    onRunClosed: (name) => scheduler?.onRunClosed(name),
    now: () => Date.now(),
    newRunId: () => randomUUID(),
  });

  /**
   * Ledger-addressed wakes (HIVE-120).
   *
   * Built after the tracker because it drives it, and handed `knownAgents` —
   * the same register the ledger authenticates a party against and the notifier
   * asks about — rather than a second opinion on who is an agent.
   *
   * `run` goes to the tracker rather than the waker deliberately: that method
   * is the one door every trigger passes through, and it is where a paused
   * agent is refused. A wake reaching the command builder directly would let a
   * ledger entry start an agent the user had just stopped.
   */
  scheduler = createScheduler({
    /*
      No tracker means no runtime, which `manualWake` has to be able to tell
      apart from a wait: `invalid` sends it back to the caller rather than onto
      the queue, and the `agents:run` handler turns a missing scheduler into
      `unknown` before it ever reaches here.
    */
    run: (name, trigger, extra, options) =>
      runs?.run(name, trigger, extra, options) ?? {
        started: false,
        refused: 'invalid',
        reason: 'The agent runtime is not running.',
      },
    state: agentRunState,
    isAgent: (id) => knownAgents.has(id),
    wakesOnLedger: (id) => ledgerAgents.has(id),
    // The watcher's cache, filled in the same pass as `agentSchedules` (HIVE-128).
    parallelFor: (name) => agentParallel.get(name) ?? AGENT_LIMIT_DEFAULTS.parallel,
    /*
      The schedule, from the cache the folder watcher rebuilds (HIVE-121).

      Not `agents.list()`: that is a promise which re-reads and re-parses every
      definition on disk, and the tick is synchronous and runs every sixty
      seconds. `agentSchedules` is refreshed by the same pass that maintains
      `knownAgents`, so an edit in Settings or in a text editor reaches the
      scheduler by the same route it already reaches the party register.

      An agent missing from the map once the listing *has* resolved is one with
      no usable definition — a file that stopped parsing mid-edit — and takes
      no scheduled wake. Before it resolves the answer is `undefined`, which
      the tick reads as "ask me again", not as "nobody is scheduled": the two
      are indistinguishable in an empty map and only one of them licenses
      clearing a `nextRunAt`.
    */
    schedules: () => (agentsListed ? agentSchedules : undefined),
    /*
      The same push `RunTracker` uses. The tick changes rows with no run
      attached — a new `nextRunAt`, a skip, a day that hit its ceiling — and
      those are the changes a person watching the row is waiting to see.
    */
    pushStatus: pushAgentStatus,
    ledger: {
      // The whole log, unfiltered: `expiredAsks` needs the closing entries and
      // the expiry events as well as the asks to decide which asks are new.
      read: () => ledger.read({}),
      append: (request) => ledger.append(request),
    },
    now: () => Date.now(),
  });

  /**
   * Answers become grants (HIVE-119).
   *
   * Composed here, next to `scheduler`, not up where `ledger` and `agents`
   * first came into scope. Both are ready well before this point — the
   * ordering constraint isn't about *availability*, it's about matching the
   * one other place in this file that arms something off `ledger.onChange`:
   * `scheduler` is armed here too, so a reader looking for "what fires on a
   * ledger entry" finds both in one place, rather than one at construction
   * and one fifty lines earlier.
   *
   * `entries`/`append` mirror the shape handed to the scheduler's own ledger
   * dep just above; `read`/`write` are the registry's, unmodified — its
   * `AgentRegistry.read`/`write` already match `PermissionDeps` exactly.
   */
  permissions = createPermissions({
    entries: () => ledger.read({}).entries,
    append: (request) => {
      ledger.append(request);
    },
    read: (name) => agentRegistry.read(name),
    write: (name, source) => agentRegistry.write(name, source),
  });

  /**
   * The two Hive-owned Slack tokens (HIVE-124).
   *
   * Composed exactly as Jira's credential is, a few hundred lines below —
   * `safeStorage` and a file under `userData`, both injected, so `tokens.ts`
   * can be answered by a unit test without a keyring. Built *here* rather than
   * beside `jira` for one reason: the bridge below takes it as a value, and the
   * bridge has to be built after `scheduler`.
   *
   * `read()` is main-internal and nothing below reaches it but the bridge. No
   * IPC verb returns a token.
   */
  const slackTokens = createSlackTokens({
    store: safeStorage,
    file: credentialFile(join(app.getPath('userData'), SLACK_TOKENS_FILE)),
  });

  /**
   * Slack Socket Mode, as a wake source (HIVE-124).
   *
   * Built after `scheduler` for the reason `permissions` is built here: it is
   * the **producer** of what the scheduler consumes, and a producer composed
   * before its consumer would have to be told about it afterwards. `onWake`
   * reads the module binding at call time rather than closing over a value, the
   * same way `buildWakeCommand` reads `permissions` above and `createRunTracker`
   * reads `scheduler` — which is what lets the two be mutually referenced
   * without either one taking the other as a constructor argument.
   *
   * Constructing it opens nothing. `sync()` is the only thing that connects,
   * and the one this composition schedules is fired behind `mcp.start()` below,
   * with `scheduler.start()` — because this can spawn a run, and a wake needs
   * an argv `buildWakeCommand` refuses to build until the MCP config file is on
   * disk.
   *
   * ## That is a preference, not a guarantee, and the difference matters
   *
   * `registerIpcHandlers` also calls `refreshKnownAgents()` above, and *that*
   * pass syncs too — the folder walk and the MCP config write are two unrelated
   * promises, so whichever settles first fires the first `sync()`. Ordering
   * them would be a false comfort anyway: the config file is read at boot, so a
   * socket can be live before either resolves.
   *
   * The composition is safe without the ordering, which is why it is left as a
   * race rather than gated. A wake arriving early reaches `RunTracker.run`
   * through `Scheduler.onEvent` like every other; the command builder refuses
   * it for want of an argv, `onEvent` enqueues it in `agents.json` rather than
   * dropping it, and `scheduler.start()` — which runs *after* `mcp.start()`
   * precisely so this holds — flushes the queue. The `.finally()` below is
   * therefore the cheapest arm, not the load-bearing one.
   */
  slackBridge = createSlackBridge({
    tokens: slackTokens,
    // Read per call, like every other consumer of the config in this file: a
    // switch flipped in Settings reaches the next `sync()` without a restart.
    config: () => getConfig().slack,
    subscriptions: () => readSubscriptions(subscribableAgents()),
    openSocket: openSlackSocket,
    openWeb: openSlackWeb,
    /*
      Through the queue, not around it (HIVE-124). `onEvent` is where a wake for
      a busy or paused agent is remembered rather than dropped, and it is the
      same door the ledger's own wakes go through.
    */
    onWake: (name, entry, options) => scheduler?.onEvent(name, entry, options),
    // The pane's own channel, deliberately not `integrations:status` — see
    // `CH.slackSocketStatus`. `send` applies the notifier tap and the
    // destroyed-window guard, as it does to every other push.
    onStatus: (status: SlackSocketStatus) => send(CH.slackSocketStatus, status),
    now: () => Date.now(),
  });

  /*
    Started behind `mcp.start()`, not beside it.

    `start()` flushes whatever a crash left queued, and a wake needs an argv —
    which `buildWakeCommand` refuses to build until the MCP config file is on
    disk, because an agent reads its inbox before anything else. That write is
    in flight from the `void mcp.start()` above, so arming this synchronously
    would put every restored queue through a refusal at the one moment it is
    guaranteed to happen. The call is memoised, so this awaits the same write
    rather than starting a second one.

    A failure still arms the sweep: expiry does not spawn anything, and a queue
    that cannot flush yet is safer standing than dropped.

    A bridge `sync()` rides along, for the same reason and with a weaker claim
    (HIVE-124): a socket opened before that write lands can deliver a Slack
    message into a wake whose argv cannot be built yet. This is not the *only*
    sync at boot — `refreshKnownAgents()` above syncs from its own promise — so
    it makes an early connection less likely rather than impossible. See the
    note on `slackBridge` for why the composition does not need it to be
    impossible: an early wake is enqueued and flushed by the `start()` on the
    line above, not lost.
  */
  void mcp
    .start()
    .catch(() => {
      // Reported where it happens; a wake that cannot be built refuses itself.
    })
    .finally(() => {
      scheduler?.start();
      slackBridge?.sync();
    });

  sessions = createSessions({
    supervisor,
    config: getConfig,
    send,
    /*
      The flow-control window follows the slowest surface watching (HIVE-145).
      Resolved per call rather than captured: a client attaches long after this
      line has run, and a captured list would gate forever on a set that never
      changes.
    */
    liveSurfaces: () => surfaces.all().map((surface) => surface.id),
    // Where the generated sets live (HIVE-133) — the same value `hooks`,
    // `skills` and `mcp` are each handed below, so a container project's
    // per-session directory and its host counterpart resolve against the
    // same root.
    userDataPath: app.getPath('userData'),
    skills,
    mcp,
    hooks,
    history,
    /*
      The two moments a held nudge can finally be written (HIVE-113): a prompt
      coming free mid-life, and a session coming back at all.
    */
    onIdle: (entityId) => deliver.onIdle(entityId),
    onReady: (entityId) => deliver.onReady(entityId),
    /*
      The same register the ledger authenticates a party against (HIVE-115),
      and deliberately not a second one: an agent that may write to the log is
      exactly an agent whose hooks the receiver should answer, and two lists
      that could disagree about that would be a bug nobody sees until one of
      them is stale. Passed as the live set rather than a copy, so a name
      `refreshKnownAgents` or `command()` adds is visible on the next hook
      without anything re-registering.
    */
    agentNames: () => knownAgents,
    /*
      The peer directory (HIVE-127). Read through `agents.list()` rather than
      from `knownAgents` above, and the difference is the point: that set is
      the party register and deliberately **drops invalid definitions**,
      because a folder that does not parse cannot be woken and must not be able
      to write to the ledger as that name. A directory that dropped them too
      would make a broken peer indistinguishable from an absent one — which is
      the case where being told is most useful, since the fix is usually a
      one-line edit to a file the reader will only go and open if something
      says it is broken.

      Composed here because this is the only place both halves are in scope:
      `agents` reads the definitions and knows nothing about runs, `agentState`
      holds the runs and knows nothing about definitions.
    */
    onAgentsList: async (caller) => {
      /*
        Thrown rather than answered empty, and the distinction is the same one
        the route's 500 exists for: `{ agents: [] }` renders to the model as
        "you are the only agent on this machine — do the work yourself", which
        is a load-bearing instruction. A registry that is missing because the
        app is tearing down has not established that. The narrow window is
        real — a wake racing shutdown — and narrow is not the same as absent.

        Distinct from `SessionsOptions.onAgentsList`'s default, which *is* an
        empty directory: there, no runtime was ever composed, so "this build
        has no agents" is the truth rather than a failure to find out.
      */
      const snapshot = await agents?.list();

      if (snapshot === undefined) {
        throw new Error('the agent registry is not available');
      }

      return agentsDirectoryFor(caller, snapshot, agentState?.all() ?? {});
    },
    /*
      The uuid is forwarded, not dropped: `noteTurnEnded` ignores a `Stop`
      whose uuid does not match the run it is holding, which is what keeps a
      late Stop from arming the watchdog on the next run under the same name.
    */
    onAgentTurnEnded: (name, sessionUuid) => runs?.noteTurnEnded(name, sessionUuid),
  });

  /**
   * The explorer may follow a session into a worktree kept outside the mapped
   * project — but only on main's own observation of where that session is.
   *
   * Injected rather than imported, because `fs/` must not depend on
   * `sessions/`: the session layer already reaches the filesystem, so the
   * import would close a cycle. `fs/session-roots.ts` holds the rules that make
   * the widened root safe; this only supplies the fact.
   */
  setSessionCwdLookup((entityId) => sessions?.observedCwd(entityId));

  cloneFlow = createCloneFlow({
    sessions,
    emit: (event) => send(CH.configCloneDone, event),
  });

  /**
   * The project watchers, one per surface (HIVE-145).
   *
   * Constructed here for the same reason the clone flow is: it needs a way to
   * push, and that has to be resolved per call rather than captured. A watcher
   * holding a stale `webContents` would emit into a destroyed renderer after a
   * window reload.
   *
   * **Targeted, not broadcast.** This went through `send` — the fan-out — so
   * every surface received every surface's tree churn and an explorer reacted
   * to a project it was not showing. With two clients on different projects
   * that is not merely wasteful: each one's tree re-reads its expanded
   * directories on a flush about the other's repository. A surface whose
   * watcher fired is the only one that asked, so it is the only one told.
   *
   * A dropped surface's own release closes its watcher; the lookup returning
   * `undefined` here is the harmless race where a flush lands in the same tick.
   */
  fsWatch = createFsWatchLayer((surfaceId, event: FsChangedEvent) => {
    surfaces.get(surfaceId)?.send(CH.fsChanged, event);
  });

  /**
   * Drop this layer's timers on quit.
   *
   * The *processes* are not killed here, and that is deliberate rather than an
   * omission: `pty-host/index.ts` already registers a hook that asks the host to
   * hang up every session's process group, waits, and force-kills what is left
   * — including descendants job control moved into their own groups (HIVE-72).
   * Signalling them twice from two hooks would race, and the second
   * kill would target pids that no longer exist. This hook exists so that the
   * batching and debounce timers cannot outlive the app and hold `before-quit`
   * open after the processes are already gone.
   */
  onShutdown(() => {
    sessions?.dispose();
    /**
     * A clone in flight when the app quits is the likeliest way to strand a
     * half-clone: `git` cleans up after its own failures, but not after the
     * process tree is torn down underneath it.
     */
    cloneFlow?.dispose();
    /**
     * The watcher holds an `FSEvents` stream and a pending debounce timer, and
     * this hook exists precisely so neither outlives the app. `resetIpcHandlers`
     * disposes it too, but that is the test path — leaving it out here meant
     * only production leaked.
     */
    fsWatch?.dispose();
    /**
     * A best-effort flush of anything still inside the debounce (HIVE-87).
     *
     * **Correctness does not depend on this running, and it must not.**
     * `runShutdown` invokes every hook body synchronously and then awaits them
     * together, so this races the pty teardown above rather than following it;
     * and a crash, a SIGKILL or a power cut runs no hook at all. Every fact
     * worth keeping was already written at the moment it was known — this only
     * saves the last few hundred milliseconds of a quiet quit.
     */
    history?.flush();
    /**
     * Agent runs, which — unlike the ptys above — nothing else signals.
     *
     * `pty-host/index.ts` owns the teardown of every *session's* process group,
     * which is why this hook deliberately does not touch those. A headless
     * agent is not in that registry: it was spawned from this process with
     * `child_process.spawn`, and if nobody kills it here it outlives the app
     * that started it, still writing to a ledger nobody is reading.
     *
     * `closeAll` rather than `killAll`, because this hook is synchronous and
     * the run's own finalizer is not reachable from it. A run closes on the
     * child's `'close'` event, which cannot arrive before this process is
     * gone — so signalling alone would leave `agents.json` saying `working`
     * about a process that no longer exists, a `run.started` with no matching
     * `run.ended` in the log forever, no summary in `runs[]`, and a
     * `runsSinceRotate` that under-counts until session rotation drifts.
     * `closeAll` records each live run `failed (app-closed)` on the spot, which
     * is what `flush()` on the next line then writes. Their `sessionUuid` is
     * untouched, so the next wake resumes the conversation.
     */
    /*
      Before `closeAll`, and that order is the whole point (HIVE-120).

      `closeAll` finalizes each live run synchronously, and `finalizeRun` ends by
      telling the scheduler the run closed — which would flush that agent's queue
      into a brand-new `claude`, spawned after `closeAll` had finished iterating
      the runs it knew about. Nothing would be left to signal it: the exact
      orphan this hook exists to prevent.
    */
    /*
      And before `scheduler.stop()`, for the same shape of reason (HIVE-124).

      The bridge is a *producer* of wakes and the scheduler is what consumes
      them: a live socket outliving its scheduler delivers a Slack message into
      `onEvent`, which reaches an `agentState` this hook is three lines from
      flushing and disposing. Stopping the producer first is what makes the rest
      of this sequence's ordering hold — the same class of bug `slackChildren`
      below was created to fix, arriving through a different door.
    */
    slackBridge?.stop();
    scheduler?.stop();
    runs?.closeAll('app-closed');
    agentState?.flush();
    /**
     * The Slack children, which are in neither registry above (HIVE-123).
     *
     * `pty-host` owns the sessions and `closeAll` owns the agent runs; a
     * `claude mcp login` spawned from the settings pane belongs to neither, and
     * it survives for the rest of its ten-minute budget **holding Slack's
     * single registered callback port 3118**. The next launch's sign-in then
     * fails on a port conflict, with nothing on screen that could explain it.
     *
     * Nothing is recorded on the way out, unlike a run: the only consumer of a
     * Slack verb's answer is a settings pane inside the window that is closing.
     */
    slackChildren?.abort();
  });

  /**
   * The fleet as it was when the app last closed (HIVE-87).
   *
   * Answers from memory rather than re-reading the file: the history loaded it
   * at construction and is the only thing that writes to it, so a second read
   * could only ever return something staler than what is already held.
   *
   * `?? []` is not a fallback so much as the browser-shaped case in main's
   * clothing — a renderer that asks before registration completed gets "no
   * history", which is exactly what it would get from an empty file.
   */
  handle(CH.sessionHistory, (): SessionHistoryEntry[] => {
    /**
     * Marked live against the registry, not against `startedThisRun`
     * (HIVE-88).
     *
     * The renderer asking may not be the first of this run: on macOS the
     * window closes and the app lives on, and a reload or a renderer crash
     * gives the same fresh store in front of the same running ptys. The
     * history holds those sessions as `working` — true, and exactly the
     * problem — so the renderer would restore them as last run's fleet and
     * their own hooks would then prove otherwise. The registry is the one
     * authority on "has a process now": a session this run began and already
     * lost is history too.
     */
    const live = new Set(sessions?.entities() ?? []);
    return (history?.all() ?? []).map((record) => {
      /*
        Both marks are computed here rather than stored, because both are only
        true of this moment (HIVE-93). `resumable` asks the history rather than
        reading `sessionUuid` off the record: a session *this run* started holds
        a uuid naming a conversation that is already open, and offering Resume
        for it would start a second `claude` against one transcript.
      */
      const marked = live.has(record.id)
        ? { ...record, live: true as const }
        : record;
      return history?.resumable(record.id) === undefined
        ? marked
        : { ...marked, resumable: true as const };
    });
  });

  /**
   * The renderer naming a ticket for a session (HIVE-87).
   *
   * Guarded like every other payload that crosses the bridge. It cannot create
   * a record — `record` merges into whatever is already there, and a note for
   * an entity main never spawned would create a row for a session that never
   * existed. Hence the `all()` check: main writes only what it already knows
   * about.
   *
   * A name on the note is **pinned by arriving** (HIVE-107). The store sends
   * one only where it renamed the row itself — the mid-session association,
   * which Claude is never told about and which therefore never comes back on
   * the title stream `readTitle` reads. So this is main's only chance to learn
   * that name, and the flag is what stops `readTitle` overwriting it a moment
   * later with the id the agent still thinks the session is called.
   */
  handle(CH.sessionNote, (_event, raw: unknown): void => {
    const request = parseSessionNoteRequest(raw);
    if (!history?.all().some((record) => record.id === request.entityId)) return;
    history.record(request.entityId, {
      ticket: request.ticket,
      ...(request.name === undefined
        ? {}
        : { name: request.name, namePinned: true }),
    });
  });

  /**
   * The renderer naming the pull request a session produced.
   *
   * The same two rules as `session:note` above, and for the same reasons: the
   * payload is guarded, and it may not *create* a record. A sweep answers about
   * every branch the user has open, including branches belonging to sessions
   * this app never ran, so without the `all()` check one poll tick could invent
   * fleet rows out of GitHub's answer.
   */
  handle(CH.sessionPr, (_event, raw: unknown): void => {
    const request = parseSessionPrRequest(raw);
    if (!history?.all().some((record) => record.id === request.entityId)) return;
    history.record(request.entityId, { pr: request.pr });
  });

  /*
    A named function rather than an inline `handle(CH.appInfo, () => {...})`
    (HIVE-144, Ruling 24): `registerIpcHandlers` returns it, below, so
    `router.ts` can hand the *exact same* closure to `registerRemoteProxy` as
    `localAppInfo` — the answer `CH.appInfo` gets while attached, computed
    locally rather than proxied to the far end. See `isProcessLocal`'s own doc
    comment (`@shared/remote-contract`) for why this channel, alone among the
    ones this file answers, must never be forwarded: every field below
    describes *this* process, not the fleet it may be attached to.
  */
  function buildAppInfo(): AppInfo {
    const { electron, chrome, node } = process.versions;
    const diagnostics = sessions?.diagnostics() ?? [];
    return {
      version: app.getVersion(),
      electron: electron ?? 'unknown',
      chrome: chrome ?? 'unknown',
      node: node ?? 'unknown',
      platform: process.platform,
      // Reported, never written to — this app logs to stdout. See `AppInfo`.
      logPath: app.getPath('logs'),
      // `hooks?.` rather than `hooks.`, matching every other read through this
      // runtime on this file: `null` is the correct answer for a receiver that
      // never bound, exactly as `boundHost()` itself already returns for that
      // case, so there is nothing here to distinguish "no runtime" from "no
      // bind" — both mean the same thing to a caller asking whether the
      // process is reachable off loopback right now.
      receiverBoundHost: hooks?.boundHost() ?? null,
      // Same shape, same reason: `remoteListener` exists on every launch
      // (constructed unconditionally), but only ever bound in server mode —
      // `?.boundHost` is `null` on every other launch, which is the correct
      // answer for "is anything reachable off this socket right now."
      serverBoundHost: remoteListener?.boundHost ?? null,
      // Read fresh on every call, from disk, not from `getConfig()` — the
      // same `readServerDevicesFromDisk()` `remoteListener`'s own `devices`
      // getter uses, so a `--pair` run in another process is reflected
      // without a restart. Not gated on `remoteListener?.boundHost`: paired
      // devices exist whether or not the socket happens to be listening this
      // instant, and the header's serving chip already gates its own
      // rendering on `serverBoundHost`, so nothing here needs to duplicate
      // that check.
      servingDeviceCount: readServerDevicesFromDisk().length,
      // `router.ts`'s own runtime fact, handed down rather than imported —
      // see `registerIpcHandlers`'s own doc comment on this parameter, and
      // `AppInfo.attachedServerName`'s for the config-versus-runtime split
      // this answers the runtime half of.
      attachedServerName: attachedServerName(),
      // Intent, not a bound socket — see `AppInfo.serving`. Imported rather
      // than handed down like the two above, because `server-mode.ts` is a
      // leaf that imports nothing and closes no cycle, and because the fact
      // it holds is the *process's*, not any one registration's.
      serving: isServerMode(),
      // Omitted rather than empty when nothing has run, so the field's presence
      // means something.
      ...(diagnostics.length > 0 ? { pty: diagnostics } : {}),
    };
  }

  handle(CH.appInfo, buildAppInfo);

  /**
   * The workspace config (story 090).
   *
   * Both channels take no payload, so there is no guard to run — the sender
   * check `handle` applies is the whole validation. The snapshot they return
   * is already validated: every path in it was resolved and checked in the
   * main process, and the renderer is trusted with the *verdict* precisely
   * because it was never trusted with the input.
   */
  handle(CH.configGet, (): ConfigSnapshot => getConfig());
  handle(CH.configReload, (): ConfigSnapshot => {
    /*
      A reload can repoint, add or remove a project, which changes which
      repository a directory should be measured against. `session-roots` caches
      git's answer per directory *including refusals*, so without this a project
      fixed in Settings would keep answering from the setup that caused the
      refusal for the rest of the app's life.

      Here rather than inside `reloadConfig`, so the config layer does not have
      to know that a filesystem cache exists. This handler already owns both.
    */
    forgetProbedRoots();
    const snapshot = reloadConfig();

    /*
      And the socket, for the same shape of reason (HIVE-124).

      The config file is meant to be hand-editable — `CH.configSetJira` says so
      of its own block — so `slack.socketMode` can change without any verb in
      this file having written it, and Reload is the moment the app learns that
      happened. Without this, turning socket mode on by hand and pressing Reload
      connects nothing until some unrelated agent edit happens to sync.
    */
    slackBridge?.sync();

    return snapshot;
  });

  /**
   * Config mutation (story 101).
   *
   * `chooseDirectory` takes no payload, so — like `get` and `reload` — the
   * sender check `handle` applies is its whole validation. The other two carry
   * a payload, are guarded here, and are then re-validated inside `addProject`
   * from scratch: the guard proves the *shape*, main proves the *path*.
   */
  handle(CH.configChooseDirectory, async (event): Promise<string | null> => {
    /**
     * The parent window is resolved from the event rather than captured.
     *
     * There is no `mainWindow` singleton in this process, deliberately: on
     * macOS the window can be closed and re-created while the app keeps
     * running, so a held reference goes stale. `send` above resolves windows
     * per call for the same reason. `assertSender` has already proven this
     * sender is the main frame, so its window is the one that asked.
     */
    const window = BrowserWindow.fromWebContents(event.sender);
    // Destroyed between the invoke and here. Nothing to attach a sheet to, and
    // treating it as a cancelled dialog is what the caller already handles.
    if (!window) return null;

    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  handle(
    CH.configAddProject,
    (_event, payload): ConfigSnapshot => addProject(parseAddProjectRequest(payload)),
  );

  handle(
    CH.configRemoveProject,
    (_event, payload): ConfigSnapshot =>
      removeProject(parseRemoveProjectRequest(payload)),
  );

  /**
   * Managing projects (story 103).
   *
   * Same contract as story 101's mutating verbs: the guard proves the *shape*,
   * and main proves the *value*. `repointProject` re-runs the full path
   * resolution, and `reorderProjects` re-reads the file before deciding whether
   * the ordering it was handed still describes it.
   */
  handle(
    CH.configRenameProject,
    (_event, payload): ConfigSnapshot =>
      renameProject(parseRenameProjectRequest(payload)),
  );

  handle(
    CH.configRepointProject,
    (_event, payload): ConfigSnapshot =>
      repointProject(parseRepointProjectRequest(payload)),
  );

  /*
    HIVE-94's key editor. The guard proves the shape — 2–4 lowercase letters —
    and main proves the value, because whether a key is free is a fact about the
    file rather than about the payload.
  */
  handle(
    CH.configSetProjectKey,
    (_event, payload): ConfigSnapshot =>
      setProjectKey(parseSetProjectKeyRequest(payload)),
  );

  handle(
    CH.configReorderProjects,
    (_event, payload): ConfigSnapshot =>
      reorderProjects(parseReorderProjectsRequest(payload)),
  );

  /**
   * Runtime settings (story 104).
   *
   * The two mutating verbs follow every other config channel exactly — guard
   * first, verb second, fresh `ConfigSnapshot` back.
   */
  handle(
    CH.configSetRuntime,
    (_event, payload): ConfigSnapshot => setRuntime(parseSetRuntimeRequest(payload)),
  );

  handle(
    CH.configSetProjectRuntime,
    (_event, payload): ConfigSnapshot =>
      setProjectRuntime(parseSetProjectRuntimeRequest(payload)),
  );

  /**
   * The PATH diagnostic (story 104) — read-only, so no write path.
   *
   * Resolved through the *same* `effectiveRuntime` the spawn path uses, which
   * is the whole point: a diagnostic that computed its own answer would
   * eventually describe an environment no session runs in.
   *
   * An unknown id is not an error. The renderer can ask about a project that a
   * concurrent hand-edit has since removed, and answering for the top-level
   * command is more useful than throwing at a user who only pressed a button.
   */
  handle(
    CH.configDiagnoseCommand,
    async (_event, payload): Promise<CommandDiagnostic> => {
      const request = parseDiagnoseCommandRequest(payload);
      // The same wait `integrations:status` makes, for the same reason: a
      // diagnostic whose whole job is to report the `PATH` that was searched
      // must not report the one that was about to be replaced (HIVE-84).
      await loginEnvStatus();
      const snapshot = getConfig();
      const project =
        request.id === undefined
          ? null
          : (snapshot.projects.find((entry) => entry.id === request.id) ?? null);

      return await diagnoseCommand(
        effectiveRuntime(snapshot, project),
        project?.id ?? null,
      );
    },
  );

  /**
   * The environment diagnostic (story 108) — read-only, so no write path.
   *
   * Resolved through the same `effectiveRuntime` as `configDiagnoseCommand`,
   * for the identical reason: the shell probed must be the shell that
   * project's sessions would actually spawn, or the diagnostic answers for an
   * environment nobody is running in. An unknown id falls back to the
   * top-level env rather than throwing, matching `configDiagnoseCommand`.
   *
   * **`cwd`** (story 108's second fix round): a real session for this project
   * runs in `project.path` (`sessions/index.ts`), so the probe must too, or
   * anything an rc file keys on the directory — direnv's `.envrc`,
   * `asdf`/`nodenv`/`pyenv` version files — diverges from what a real session
   * would see. When there is no such directory — no project selected
   * (`project` is `null`), or a selected project whose `path` is `null`
   * (broken: missing, not a directory, …) — a session could never actually
   * spawn there either (`sessions/index.ts` refuses unless `status === 'ok'
   * && path !== null`), so there is no "real session" to match. `homedir()`
   * is the fallback: it is where a login shell opened outside this app would
   * normally find itself, and it is a fixed, meaningful location rather than
   * main's own `cwd` (unrelated to any project — `/` in a packaged build,
   * the app bundle in dev).
   */
  handle(CH.configDiagnoseEnv, (_event, payload): Promise<EnvDiagnostic> => {
    const request = parseDiagnoseEnvRequest(payload);
    const snapshot = getConfig();
    const project =
      request.id === undefined
        ? null
        : (snapshot.projects.find((entry) => entry.id === request.id) ?? null);
    const projectId = project?.id ?? null;
    const runtime = effectiveRuntime(snapshot, project);
    const cwd = project?.path ?? homedir();

    if (envDiagnosticInFlight) {
      return Promise.resolve({
        projectId,
        shell: runtime.shell,
        error:
          'another environment check is already running — wait for it to finish and try again',
        vars: [],
      });
    }

    envDiagnosticInFlight = true;
    /**
     * The same `stripEnv` a real session for this project would get
     * (`sessions/index.ts`). Without it the probe reports `ANTHROPIC_API_KEY`
     * as present in an environment every real session has it removed from —
     * the divergence class story 108's fix round exists to close, one level up
     * from `buildSessionEnv`.
     */
    const stripEnv = snapshot.subscriptionAuth ? AUTH_ENV_KEYS : [];
    return diagnoseEnv(
      runtime,
      projectId,
      cwd,
      process.env,
      stripEnv,
    ).finally(() => {
      envDiagnosticInFlight = false;
    });
  });

  /**
   * Notification preferences (story 106).
   *
   * A mutating verb like every other: guard first, verb second, fresh
   * `ConfigSnapshot` back.
   */
  handle(
    CH.configSetNotifications,
    (_event, payload): ConfigSnapshot =>
      setNotifications(parseSetNotificationsRequest(payload)),
  );

  /**
   * Story 107's two verbs. **Neither takes a payload**, so — exactly like
   * `config:get` and `config:reload` — the sender check `handle` applies is
   * their whole validation. There is no guard to write because there is no
   * input: main reveals and rewrites the file *it* resolved from
   * `configPath()`, which is what keeps the epic's "no verb takes a destination
   * path" rule true by construction rather than by a check that could be
   * forgotten.
   *
   * `showItemInFolder` rather than `openPath`: it selects the file in a folder
   * window instead of handing it to whatever application claims `.json`, and
   * it is the one of the two that cannot launch a program.
   */
  handle(CH.configReveal, (): void => {
    shell.showItemInFolder(configPath());
  });

  /**
   * Reset writes {@link DEFAULT_SLACK} over whatever was there, which turns
   * socket mode **off** — so it is a change to the switch like any other, and
   * the one with the worst failure if it is missed (HIVE-124). Without the
   * `sync()`, a live socket survives the reset and keeps waking agents from a
   * setting the user has just erased.
   */
  handle(CH.configReset, (): ConfigSnapshot => {
    const snapshot = resetConfig();

    slackBridge?.sync();

    return snapshot;
  });

  /**
   * Integrations status (story 106) — read-only, and **takes no payload**.
   *
   * The absent parameter list is the security design rather than an omission.
   * This is the first handler in main that executes another program, and the
   * reason it is safe to is that nothing from the renderer reaches the argv:
   * there is no path, no flag and no name to guard, so there is nothing to
   * inject into. See `integrations/gh.ts` for the rest of the execution rules.
   *
   * The `PATH` searched is the one the *spawn* path would use, not this
   * process's raw environment — the same discipline story 104's diagnostic
   * applies, so what is reported is what would actually run.
   */
  handle(CH.integrationsStatus, async (): Promise<IntegrationsStatus> => {
    /**
     * Wait for the login-shell import before looking for `gh` (HIVE-84).
     *
     * This is the whole point of the memoised promise: the probe was started
     * at boot, so by the time a settings pane is open it has almost always
     * resolved and this `await` costs nothing. What it buys is that the answer
     * can never be the *pre-import* `PATH` — a race that would report "gh was
     * not found" on a machine where it is about to be found, which is exactly
     * the confusing half-truth this story exists to remove.
     */
    const loginEnv = await loginEnvStatus();

    // Merged the way `diagnoseCommand` merges: the config's env wins, and
    // `process.env` supplies the `PATH` when it names none. `gh` is a
    // workspace-level tool, so the top-level runtime is the right scope — there
    // is no project selected when the section opens.
    const env = { ...process.env, ...effectiveRuntime(getConfig(), null).env };

    return {
      gh: readGhStatus(env, runCommand),
      loginEnv,
      notificationsSupported: Notification.isSupported(),
    };
  });

  /**
   * The environment half, without the binary.
   *
   * `integrations:status` above waits on the same memoised promise and then
   * spends two `spawnSync` calls looking for `gh`. Settings → Runtime wants the
   * `PATH` this app searched and has no interest in `gh`, so it gets the wait
   * and none of the subprocesses — which, since the promise was started at
   * boot, makes this handler a variable read that cannot block main.
   */
  handle(CH.integrationsLoginEnv, async (): Promise<LoginEnvStatus> => {
    return await loginEnvStatus();
  });

  /**
   * Jira (HIVE-67) — the app's first stored credential, and its first outbound
   * HTTP request.
   *
   * Built once, here, because this is the composition root: `auth.ts` and
   * `client.ts` take every dependency by injection so their unit tests can
   * answer without a keychain or a network, which means somebody has to supply
   * the real ones exactly once, and that somebody is this file.
   *
   * `safeStorage` is passed rather than imported inside `auth.ts` for the same
   * reason `gh.ts` takes its `RunCommand`: a module that reaches for an Electron
   * global is a module no unit test can answer for.
   *
   * `globalThis.fetch` rather than a dependency — Node is pinned `>=22` and
   * Electron is 43, so it is there. Wrapped rather than passed by reference so
   * `this` cannot matter and the seam stays a plain function.
   */
  const jira = createJira({
    store: safeStorage,
    file: credentialFile(join(app.getPath('userData'), 'jira-credential.bin')),
    env: process.env,
    config: getConfig,
    fetch: (url, init) => globalThis.fetch(url, init),
  });

  /**
   * The device credential this machine was handed when it attached to
   * someone else's Hive (HIVE-144).
   *
   * {@link remoteCredentialStore} rather than a `createTokenStore` call here,
   * so the filename exists in one place: the mode switch reads this same
   * credential through `readRemoteCredential`, and a second spelling of that
   * path would be a credential written by `remote:pair` and looked for
   * somewhere else at attach time.
   *
   * `read()` is main-internal — see `electron/remote-client/token-store.ts`'s
   * own doc comment for why this is a distinct module from `jira/auth.ts`
   * rather than a shared helper. No IPC verb returns the token; `remote:pair`
   * below only ever writes it, and `remote:forget` only ever clears it.
   */
  const remoteTokenStore = remoteCredentialStore();

  /**
   * The PR poller's read — the app's second handler that executes a binary,
   * and the first that does so on a timer.
   *
   * Same security design as `integrations:status`: **no payload**, so there is
   * no argv to inject into. What it adds is a cwd and a set of GraphQL
   * variables, and both come from the config file rather than the renderer —
   * see `integrations/github/query.ts` for why the repository names are bound
   * variables and never concatenated into the document.
   *
   * Asynchronous, unlike `integrations:status`. That one runs when a settings
   * pane opens; this one runs every minute for as long as the app is open, and
   * a `spawnSync` on that schedule would stall every pty chunk and every window
   * event behind it.
   */
  const github = createGithub({
    config: getConfig,
    // The same merge `integrations:status` makes, for the same reason: what is
    // reported has to be what would actually run.
    env: () => ({ ...process.env, ...effectiveRuntime(getConfig(), null).env }),
    run: runAsync,
    now: () => Date.now(),
  });

  handle(CH.githubPrs, async (): Promise<GhResult<PrsSnapshot>> => {
    // The poller's first tick can land before the boot-time import resolves,
    // and a `gh` "not found" cached from that tick would outlive the race
    // (HIVE-84). The `env` thunk above is lazy precisely so this await is all
    // that is needed.
    await loginEnvStatus();
    return github.prs();
  });

  handle(
    CH.githubSearchPrs,
    async (_event, payload): Promise<GhResult<PrRecord[]>> => {
      const request = parseSearchPrsRequest(payload);
      // Same race as `github:prs` — see the note there.
      await loginEnvStatus();
      return github.searchPrs(request.term, request.projectId);
    },
  );

  handle(CH.jiraStatus, (): JiraStatus => jira.status());
  handle(CH.jiraSetToken, (_event, payload): JiraStatus =>
    jira.setToken(parseSetJiraTokenRequest(payload)),
  );
  handle(CH.jiraClearToken, (): JiraStatus => jira.clearToken());
  handle(CH.jiraTest, (): Promise<JiraResult<JiraIdentity>> => jira.test());
  handle(
    CH.jiraSearch,
    (_event, payload): Promise<JiraResult<JiraSearchResult>> =>
      jira.search(parseJiraSearchRequest(payload)),
  );
  handle(
    CH.jiraIssue,
    (_event, payload): Promise<JiraResult<JiraIssue>> =>
      jira.issue(parseJiraIssueRequest(payload)),
  );
  handle(
    CH.jiraTransitions,
    (_event, payload): Promise<JiraResult<JiraTransition[]>> =>
      jira.transitions(parseJiraTransitionsRequest(payload)),
  );
  handle(
    CH.jiraApplyTransition,
    (_event, payload): Promise<JiraResult<JiraIssue>> =>
      jira.applyTransition(parseApplyJiraTransitionRequest(payload)),
  );
  handle(
    CH.jiraComments,
    (_event, payload): Promise<JiraResult<JiraComment[]>> =>
      jira.comments(parseJiraConversationRequest(payload)),
  );
  handle(
    CH.jiraLinks,
    (_event, payload): Promise<JiraResult<JiraLink[]>> =>
      jira.links(parseJiraConversationRequest(payload)),
  );
  handle(
    CH.jiraAddComment,
    (_event, payload): Promise<JiraResult<JiraComment>> =>
      jira.addComment(parseAddJiraCommentRequest(payload)),
  );
  handle(CH.configSetJira, (_event, payload): ConfigSnapshot =>
    setJira(parseSetJiraRequest(payload)),
  );
  /**
   * The socket-mode switch and the commander allow-list (HIVE-124).
   *
   * An ordinary settings write, and then a `sync()` — because the switch is one
   * of the three things `SlackBridge.sync` reads, and this is the only moment
   * the app learns it changed. Without the second line, turning Slack on in
   * Settings would do nothing until an agent happened to be edited.
   */
  handle(CH.configSetSlack, (_event, payload): ConfigSnapshot => {
    const snapshot = setSlack(parseSetSlackRequest(payload));

    slackBridge?.sync();

    return snapshot;
  });
  // HIVE-131. The container host alias — an ordinary settings write.
  handle(CH.configSetReceiver, (_event, payload): ConfigSnapshot =>
    setReceiver(parseSetReceiverRequest(payload)),
  );
  /**
   * HIVE-142. Whether server mode is on, and where it listens — an ordinary
   * settings write, exactly like `config:set-receiver` above. There is no
   * credential in this payload: `parseSetServerRequest` refuses one, and
   * pairing is `server:pair`'s job below.
   */
  handle(CH.configSetServer, (_event, payload): ConfigSnapshot =>
    setServer(parseSetServerRequest(payload)),
  );
  /**
   * Mint a device credential, and answer its plaintext once (HIVE-142).
   *
   * Goes through `pairDevice` — the same implementation `--pair` and the
   * server-mode tray's "Pair a device…" call (`server/devices.ts`) — so the
   * duplicate-name refusal, the collision-safe retry and "persist against
   * the roster just read" are proven once, not reimplemented a third time
   * here. The plaintext is the return value and nothing else: it is never
   * written into the config, a store, or a log line — the server keeps only
   * the digest `pairDevice` computed.
   *
   * `deviceId` rides alongside the token (HIVE-142 review, I5): `AttachRequest`
   * needs both, and until now the id was readable only inside `config.json`.
   * A write failure (C1) is reported through the same `{ error }` shape a
   * duplicate name or a minting collision already uses — the pane shows the
   * reason instead of the token panel either way.
   */
  handle(
    CH.serverPair,
    (_event, payload): { token: string; deviceId: string } | { error: string } => {
      const { name } = parsePairDeviceRequest(payload);
      const outcome = pairDevice(name, serverDeviceStore());
      if (outcome.ok) return { token: outcome.token, deviceId: outcome.device.id };
      return { error: pairOutcomeMessage(outcome, name) };
    },
  );
  /**
   * Revoke a paired device by name (HIVE-142). A no-op, not a refusal, if no
   * device holds that name — the same `revokeDevice` implementation `--revoke`
   * and the tray's "Revoke" both call.
   *
   * Reports the outcome rather than answering `void` (HIVE-142 review, I7,
   * same family as C1): a hand-edit or a rename since boot can mean this
   * name matches nothing, or the write itself can fail, and either way the
   * renderer's `revokeDevice` (`project-config.ts`) must not tell the pane
   * "done" for a revoke that changed nothing on disk.
   */
  handle(
    CH.serverRevoke,
    (_event, payload): { revoked: true } | { error: string } => {
      const { name } = parseRevokeDeviceRequest(payload);
      const outcome = revokeDevice(name, serverDeviceStore());
      if (outcome.revoked) return { revoked: true };
      return { error: revokeOutcomeMessage(outcome, name) };
    },
  );
  /**
   * HIVE-144. Whether this window is a client and where it attaches — and,
   * unlike `config:set-server` above, a verb that *acts* as well as writes:
   * attaching applies immediately, where a listening socket cannot be moved
   * without a relaunch.
   *
   * ## Validate, then switch, then write only on success (Ruling 19)
   *
   * `parseSetRemoteRequest` checks the payload's shape. `switchMode` checks
   * the target — a plaintext socket carries this machine's device credential,
   * so an unvalidated host is a credential handed to whoever answers — and
   * only then dials. `setRemote` runs last, and only when the switch
   * succeeded.
   *
   * The order is the whole point. Writing first and being refused would leave
   * `config.json` saying `remote` while this process is bound local, and the
   * *next launch* would attach to a server the user was just told it could not
   * attach to. There is no revert path here because there is nothing to
   * revert: a refused or failed switch never reaches `setRemote`, so the file
   * is untouched and disk and runtime never disagree.
   *
   * ## The merge, and why the switch is told a target
   *
   * All three fields are optional and merged into the stored block, so the
   * *effective* mode and address are what this handler acts on — not whatever
   * subset this one call carried. The merged target is passed to the switch
   * explicitly rather than left to its own default, precisely because the
   * config file must not yet contain it.
   *
   * A request that changes nothing about the effective mode or target still
   * reaches the switch, and `switchIpcMode` answers it without touching a
   * binding — see its own local-when-already-local guard. That is what keeps
   * a user typing in the address field while in local mode from tearing down
   * and rebuilding every session layer on each committed keystroke.
   *
   * ## Answering after tearing down the surface this handler is bound to
   *
   * A successful switch unbinds this very channel before this function
   * returns. That is safe rather than lucky: `ipcMain` has already captured
   * the reply for the invocation in flight, and everything after the `await`
   * is a module import rather than a closure over the registration that has
   * gone — so the renderer gets its answer even though nothing would answer a
   * *second* call on this channel.
   *
   * `parseSetRemoteRequest` never lets a token through this payload, so this
   * handler never touches `remoteTokenStore` — writing the credential is
   * `remote:pair`'s job below, not this one's.
   */
  /*
    The body lives in `./set-remote` since Ruling 28, not here, because
    `registerRemoteProxy` has to answer this same channel from a process whose
    local handlers have already been torn down — see {@link applySetRemote}
    for why that is the one verb with two answering surfaces, and why copying
    it into the proxy instead would have been a client that detaches
    differently depending on the mode it asked from.
  */
  handle(CH.configSetRemote, (_event, payload): Promise<SetRemoteResult> =>
    applySetRemote(payload, switchMode, attachedSnapshot),
  );
  /**
   * Store the device credential a `server:pair` mint on some *other* Hive
   * handed back (HIVE-144) — the opposite direction from `server:pair` above,
   * see `CH.remotePair`'s own doc comment for why the two are not one verb.
   *
   * Answers `{ paired: true } | { error }` rather than a bare `void`
   * (fix-round review, Important-2): unlike `server:pair` there is no
   * plaintext to hand back — it arrived *in* this payload rather than being
   * minted by this call — but `remoteTokenStore.write` can still no-op on a
   * locked keychain, and `read()` is main-internal, so this handler is the
   * renderer's only way to learn that. A bare `void` return let a pairing
   * dialog report success over a credential that was never written.
   */
  handle(
    CH.remotePair,
    (_event, payload): { paired: true } | { error: string } => {
      const { deviceId, token } = parseRemotePairRequest(payload);
      const stored = remoteTokenStore.write(deviceId, token);
      if (stored) return { paired: true };
      return { error: NO_ENCRYPTION_REASON };
    },
  );
  /**
   * Discard the credential `remote:pair` stored (HIVE-144). Idempotent, and
   * takes no payload — there is exactly one credential on this machine to
   * forget, never a name to disambiguate by, which is what separates this
   * from `server:revoke` above.
   */
  handle(CH.remoteForget, (): void => {
    remoteTokenStore.clear();
  });

  /**
   * Slack's MCP server (HIVE-123) — four verbs, none taking a payload.
   *
   * The same no-payload design `integrations:status` and `jira:status` use:
   * with nothing arriving from the renderer, there is no argv to guard and
   * nothing for a compromised renderer to widen. Each handler's own signature
   * takes no `payload` parameter at all, so a caller that tries to smuggle one
   * in has it silently ignored rather than acted on — the same shape every
   * other no-payload verb in this file already has.
   *
   * `claudeCommand` is the same resolver `buildWakeCommand` above reads —
   * `getConfig().claudeCommand`, read fresh on every call so a binary edited
   * in Settings reaches the next status read without a restart — and it goes
   * through the same {@link resolveClaude} every agent wake does. `gh.ts` wrote
   * the rule these four had been the only callers to skip: "the resolved
   * absolute path is what runs, never the bare name". A `claudeCommand` that is
   * a shell function, or that carries arguments, is unreachable from a child
   * spawned with no shell — and the resolver's refusal *says which*, where the
   * bare name gave the pane a raw `spawn ENOENT`.
   *
   * ## Two runners, and which verb gets which
   *
   * `runCommand` is `gh.ts`'s **synchronous** five-second one, and exactly one
   * verb still wants it: `claude mcp remove` edits a local JSON file with no
   * network and no model in it, and answers in a millisecond.
   *
   * `runSlack` wraps the shared async runner the PR poller and
   * `sessions/git.ts` already use, and takes the other three. `mcp login`
   * blocks on a browser OAuth round-trip, the probe blocks on model turns, and
   * `mcp get` — despite being a "read" — **health-checks the server over
   * HTTP**, measured at about 1.7 s. On the sync runner the first two could
   * never succeed and all three froze IPC, PTY routing and the agent scheduler
   * for the duration. The per-verb timeouts live with the verbs, in
   * `slack/status.ts`, `slack/login.ts` and `slack/probe.ts`.
   *
   * The wrapper's one addition is {@link slackChildren}'s signal, so a quit
   * hangs up on whatever is still running.
   */
  const runSlack: RunAsync = (file, args, options) =>
    runAsync(file, args, { ...options, signal: slackChildren?.signal });

  /**
   * One Slack verb, resolved and deduped.
   *
   * The resolution happens **before** the in-flight check is stored rather than
   * inside the verb, so a misconfigured `claudeCommand` is a refusal with a
   * sentence in it rather than a promise nothing can join. A refusal is not
   * cached: it costs nothing to re-derive, and caching it would outlive the
   * Settings edit that fixed it.
   */
  const slackVerb = (
    channel: string,
    start: (claude: string) => Promise<SlackStatus>,
  ): Promise<SlackStatus> => {
    const running = slackInFlight.get(channel);

    if (running !== undefined) return running;

    const claude = resolveClaude(claudeCommand(), process.env['PATH']);

    if ('problem' in claude) {
      return Promise.resolve({ kind: 'error', message: claude.problem });
    }

    const started = start(claude.path).finally(() => {
      slackInFlight.delete(channel);
    });

    slackInFlight.set(channel, started);

    return started;
  };

  handle(CH.slackStatus, (): Promise<SlackStatus> =>
    slackVerb(CH.slackStatus, (claude) => readSlackStatus(claude, runSlack)),
  );
  handle(CH.slackSignIn, (): Promise<SlackStatus> =>
    slackVerb(CH.slackSignIn, async (claude) => {
      const result = await signInToSlack(claude, runSlack);

      /*
        A sign-in that worked retires every stale `needs-auth` marker
        (HIVE-123).

        The scheduler skips a clock wake while the agent's *last run* reported
        Slack signed out — and only a new run can rewrite that field, which the
        skip is what prevents. For the shipped `slack-watcher` (`every: 5m`,
        rare ledger traffic) that is not a delay, it is a permanent stall, and
        the pane's own caption promises the opposite. Nothing else can break the
        livelock: this is the one moment the app learns the fact changed.
      */
      if (result.kind === 'connected' || result.kind === 'pending-approval') {
        for (const name of agentState?.clearSlackNeedsAuth() ?? []) {
          pushAgentStatus(name);
        }
      }

      return result;
    }),
  );
  handle(CH.slackSignOut, (): SlackStatus => {
    const claude = resolveClaude(claudeCommand(), process.env['PATH']);

    if ('problem' in claude) return { kind: 'error', message: claude.problem };

    return signOutOfSlack(claude.path, runCommand);
  });
  handle(CH.slackTest, (): Promise<SlackStatus> =>
    slackVerb(CH.slackTest, (claude) => probeSlack(claude, runSlack)),
  );

  /**
   * Socket mode's own verbs (HIVE-124) — and the invariant they must not break.
   *
   * Two writes and one test, and **none of them returns a token**. Both writes
   * answer with `SlackTokens.state()`, which is assembled from presence alone;
   * `read()` is main-internal and has no channel. That is Jira's design applied
   * to a second credential, and `slack-channels.test.ts` asserts it by
   * enumerating every `slack:` channel in the contract rather than a list.
   *
   * Each write is followed by a `sync()`, because the tokens are one of the
   * three things `SlackBridge.sync` reads: pasting the pair is what makes a
   * connection possible, and clearing them is what must close one.
   */
  handle(CH.slackSetTokens, (_event, payload): SlackTokensState => {
    const state = slackTokens.save(parseSetSlackTokensRequest(payload));

    slackBridge?.sync();

    return state;
  });
  handle(CH.slackClearTokens, (): SlackTokensState => {
    const state = slackTokens.clear();

    slackBridge?.sync();

    return state;
  });
  /**
   * One `auth.test`, and no socket.
   *
   * Not deduped through {@link slackVerb}: that map guards verbs that spawn a
   * `claude`, where a second click costs a second OAuth callback port or a
   * second set of model turns. This is a single HTTPS request against a token
   * already on disk.
   */
  handle(CH.slackSocketTest, async (): Promise<SlackSocketTestResult> => {
    const result = await slackBridge?.test();

    return (
      result ?? { kind: 'error', message: 'The Slack bridge is not running.' }
    );
  });

  /**
   * What the pane cannot learn by subscribing (HIVE-124).
   *
   * `CH.slackSocketStatus` is a push, `send` buffers nothing and the bridge
   * suppresses a repeat of the last status — so a status emitted at boot is
   * gone before Settings is ever opened, and after a restart a connected
   * bridge renders as `off` with the `unresolved` list unreachable. Token
   * presence is worse: both writes answer with it and nothing answers on
   * mount.
   *
   * So one no-payload verb for the pair, the shape `CH.jiraStatus` already
   * uses. It reads `state()`, never `read()`: the invariant above is that no
   * `slack:` channel returns a token, and this is a channel.
   *
   * `unresolved` is read **live** rather than taken from the stored status
   * (fix-round-3, HIVE-124). `status()` answers with the last value pushed, and
   * that list can be older than the subscriptions it describes — an agent
   * paused, or a `slack.channel:` line deleted, changes what is unresolved
   * without changing anything the bridge pushes. Serving the stale copy meant a
   * chip for a room nobody watches survived even a remount.
   */
  handle(CH.slackSocketState, (): SlackSocketState => {
    const socket = slackBridge?.status() ?? { kind: 'off' };

    return {
      tokens: slackTokens.state(),
      socket:
        socket.kind === 'connected'
          ? { ...socket, unresolved: slackBridge?.unresolved() ?? [] }
          : socket,
    };
  });

  /**
   * Cloning a repository (story 102).
   *
   * `startClone` returns a **refusal**, it does not throw: a mistyped URL or a
   * folder that already exists is something the user fixes in a text field, not
   * an exception the renderer has to catch. Guard failures still throw — those
   * are malformed payloads, which are a bug or an attack, not a user mistake.
   */
  handle(CH.configCloneStart, (_event, payload): CloneStartResult => {
    const request = parseCloneRequest(payload);
    return (
      cloneFlow?.start(request) ?? {
        ok: false,
        reason: 'the clone service is not available',
      }
    );
  });

  handle(CH.configCloneCancel, (): void => {
    cloneFlow?.cancel();
  });

  /**
   * The project filesystem (the explorer and the editor).
   *
   * Every one of these validates twice, and the two checks are not redundant.
   * The guard settles what a legal *string* is — relative, no `..` segment, no
   * control bytes — and `electron/main/fs/paths.ts` settles where that string
   * actually lands once symlinks are resolved. Neither can do the other's job:
   * a string check cannot see a symlink, and `realpath` cannot see a `..` on a
   * path that does not exist yet.
   *
   * None of them throws across IPC. Each answers with a result the panel can
   * render, on the same rule the Jira verbs follow — a tree that throws because
   * one directory is unreadable says the app is broken, when one directory is
   * unreadable.
   */
  handle(
    CH.fsReadDir,
    (_event, payload): Promise<FsResult<DirEntry[]>> =>
      readDirectory(parseReadDirRequest(payload)),
  );

  handle(
    CH.fsRoot,
    (_event, payload): Promise<FsResult<RootInfo>> =>
      readRoot(parseRootRequest(payload)),
  );

  handle(
    CH.fsReadFile,
    (_event, payload): Promise<FsResult<FileContent | FsRefusal>> =>
      readFileContent(parseReadFileRequest(payload)),
  );

  handle(
    CH.fsWriteFile,
    (_event, payload): Promise<WriteFileResult> =>
      writeFileContent(parseWriteFileRequest(payload)),
  );

  /**
   * The recursing verb. Answers `FsResult` like every read here —
   * a search that failed must render as a failed search, not as a broken app.
   * Every bound it obeys lives in `fs-contract.ts`, not at this call site.
   */
  handle(
    CH.fsSearch,
    (_event, payload): Promise<FsResult<SearchResults>> =>
      searchProject(parseSearchRequest(payload)),
  );

  /**
   * `watch` resolves once the watcher is up, and rejects if the project cannot
   * be watched — the one fs verb that does throw, because there is no view to
   * render its failure into. The explorer treats a rejection as "no live
   * updates" and keeps its manual refresh, which is the honest degradation.
   */
  handle(CH.fsWatch, async (event, payload): Promise<void> => {
    const request = parseWatchRequest(payload);
    await fsWatch?.watchProject(surfaceFor(event.sender), request.projectId, request.sessionId);
  });

  handle(CH.fsUnwatch, (event): void => {
    fsWatch?.unwatch(surfaceFor(event.sender));
  });

  /**
   * Custom skills (HIVE-96, HIVE-99, HIVE-148).
   *
   * The `fs` block above validates twice — a string-shape guard here, then real
   * containment in `fs/paths.ts` — because it accepts a path. These five
   * validate once, and that is not a weaker design: `assertSkillName` admits
   * only `[a-z0-9-]+`, which cannot name a directory other than the one main
   * chooses, so there is no second question to ask. See `skills-contract.ts`.
   *
   * The seven bundle verbs below (HIVE-148) validate twice, the same way `fs`
   * does — see the docblock just above `CH.skillsFileRead` — because a skill
   * became a folder and a path is exactly how something inside one is named.
   *
   * `skills` is non-null from registration onward; the optional chaining is for
   * the window between module load and `registerIpc`, which is the same reason
   * every `sessions?.` call in this file has it.
   */
  handle(CH.skillsList, () => skills?.list());

  handle(CH.skillsRead, (_event, payload) =>
    skills?.readOne(parseSkillNameRequest(payload).name),
  );

  handle(CH.skillsWrite, (_event, payload) => {
    const request = parseSkillWriteRequest(payload);
    return skills?.write(request.name, request.body);
  });

  handle(CH.skillsRemove, (_event, payload) =>
    skills?.remove(parseSkillNameRequest(payload).name),
  );

  handle(CH.skillsRename, (_event, payload) => {
    const request = parseSkillRenameRequest(payload);
    return skills?.rename(request.from, request.to);
  });

  /**
   * The bundle verbs (HIVE-148).
   *
   * `skills:read`/`write`/`remove`/`rename` above validate once, because
   * `assertSkillName` cannot express anything but the one directory main
   * chose. These seven cannot make that claim — a path is exactly the thing a
   * bundle's own SKILL.md, scripts and references are addressed by — so each
   * validates the request's *shape* here and then leans on
   * `resolveInSkill`'s `realpath` containment check inside `SkillsRuntime`
   * for the *disk*. Neither layer substitutes for the other; see
   * `electron/main/skills/paths.ts`.
   */
  handle(CH.skillsFileRead, (_event, payload) => {
    const request = parseSkillPathRequest(payload);
    return skills?.readFile(request.name, request.path);
  });

  handle(CH.skillsFileWrite, (_event, payload) => {
    const request = parseSkillFileWriteRequest(payload);
    return skills?.writeFile(request.name, request.path, request.body);
  });

  handle(CH.skillsFileMkdir, (_event, payload) => {
    const request = parseSkillPathRequest(payload);
    return skills?.makeDir(request.name, request.path);
  });

  handle(CH.skillsFileRemove, (_event, payload) => {
    const request = parseSkillPathRequest(payload);
    return skills?.removeFile(request.name, request.path);
  });

  handle(CH.skillsFileMove, (_event, payload) => {
    const request = parseSkillMoveRequest(payload);
    return skills?.moveFile(request.name, request.from, request.to);
  });

  handle(CH.skillsFileImport, (event, payload) => {
    const request = parseSkillImportRequest(payload);
    return skills?.importFiles(request.name, request.dir, async () => {
      /*
        Main opens the picker, so no source path crosses IPC inward. The same
        arrangement `pickTheme()` uses, and the reason `import` is a verb of its
        own rather than a second shape of `drop`.
      */
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window === null) return [];
      const result = await dialog.showOpenDialog(window, {
        properties: ['openFile', 'openDirectory', 'multiSelections'],
      });
      return result.canceled ? [] : result.filePaths;
    });
  });

  handle(CH.skillsFileDrop, (_event, payload) => {
    const request = parseSkillDropRequest(payload);
    return skills?.dropFiles(request.name, request.dir, request.sources);
  });

  /**
   * Agent definitions (HIVE-114).
   *
   * `agents` is non-null from registration onward; the optional chaining
   * matches every other runtime in this file, for the window between module
   * load and `registerIpc`.
   *
   * `write` and `rename` answer with an `AgentWriteResult` rather than a fresh
   * snapshot, unlike their skills counterparts. A refusal here has structure —
   * problems, each naming its field — and the editor renders them beside the
   * controls they name; the change push is what refreshes the list.
   */
  /*
    The definitions the registry read, joined to what has since happened to
    them (HIVE-115).

    `AgentSummary` gained `sessionUuid`, `runsSinceRotate` and `cost` with the
    run tracker, and the registry cannot fill any of them in — it reads
    `AGENT.md` files and has never seen a process. Merging here rather than in
    the registry keeps that module ignorant of runs, and keeps `agents.json`
    read in exactly one place. Without this the three fields would be part of
    the contract and permanently `undefined`.
  */
  handle(CH.agentsList, async () => {
    const snapshot = await agents?.list();

    if (snapshot === undefined) return undefined;

    const merged = mergeRunState(snapshot, agentState?.all() ?? {});

    // What is in flight lives in the tracker, not in `agents.json` (HIVE-128).
    return {
      ...merged,
      agents: merged.agents.map((agent) => ({
        ...agent,
        live: runs?.liveRuns(agent.name) ?? [],
      })),
    };
  });

  handle(CH.agentsRead, (_event, payload) =>
    agents?.read(parseAgentNameRequest(payload).name),
  );

  handle(CH.agentsWrite, (_event, payload) => {
    const request = parseAgentWriteRequest(payload);
    return agents?.write(request.name, request.source);
  });

  handle(CH.agentsRemove, (_event, payload) =>
    agents?.remove(parseAgentNameRequest(payload).name),
  );

  handle(CH.agentsRename, (_event, payload) => {
    const request = parseAgentRenameRequest(payload);
    return agents?.rename(request.from, request.to, request.source);
  });

  /**
   * Wake an agent now (HIVE-115).
   *
   * The trigger is `'manual'` and is written **here**, not taken from the
   * payload — see `parseAgentRunRequest` and `BRIDGE_AGENTS_KEYS`. It is the
   * only trigger this channel could report honestly, and it goes into the
   * ledger entry and the wake prompt, so accepting a renderer's word for it
   * would let the page write history.
   *
   * `request.extra` is the exception that shows the rule (HIVE-126): the
   * payload may carry the words a person typed after the agent's name, and the
   * trigger is still this line's to write. One says *why*, the other says what
   * **kind** — and only the second would be history the page had authored.
   *
   * Two awaits before the spawn, and each closes a window this file already
   * knows about from the pty path:
   *
   * - `loginEnvStatus()` — `claude` is resolved by walking `PATH`, and HIVE-84
   *   replaces this process's `PATH` shortly after launch. Resolving against
   *   the pre-repair value would fail on exactly the machines that import fixed
   *   it for, and the refusal would read as "claude is not installed".
   * - `mcp.start()` — the memoised write of `hive.mcp.json`. Without it, a run
   *   launched in the first moments of the app would be refused for want of a
   *   config path that was about to exist.
   */
  handle(CH.agentsRun, async (_event, payload): Promise<AgentRunResult> => {
    const request = parseAgentRunRequest(payload);

    await loginEnvStatus();
    await mcp.start();

    /*
      Through the scheduler rather than the tracker (HIVE-126).

      `RunTracker.run` is still the one door every trigger passes through — this
      calls it, one frame further in. What the detour buys is the queue: a run
      refused because the agent is working or paused is remembered and delivered
      at the next opportunity, exactly as a ledger-addressed wake has been since
      HIVE-120. Calling the tracker directly is what made the same intent
      durable or disposable depending on which verb the user happened to type.
    */
    return (
      scheduler?.manualWake(request.name, request.extra) ?? {
        started: false,
        refused: 'unknown',
        reason: 'The agent runtime is not running.',
      }
    );
  });

  /**
   * Stop the run in progress, if there is one.
   *
   * Takes the same name guard as `read` and `remove`, and can only ever reach a
   * child this app spawned and still holds: the tracker looks the name up in
   * its own map and answers `false` for anything it does not find. There is no
   * pid on this channel and no way to reach a process The Hive did not start.
   *
   * `false` is not an error. A run can end between the row rendering its stop
   * button and the click arriving, and reporting that as a failure would teach
   * the user to distrust a button that did exactly what they wanted.
   */
  handle(CH.agentsKill, (_event, payload): boolean =>
    // `?? false`, because the channel's declared answer is a boolean and "the
    // runtime is not running" is the same news to the renderer as "there was
    // nothing to stop" — an `undefined` on a `Promise<boolean>` is neither.
    runs?.kill(parseAgentNameRequest(payload).name) ?? false,
  );

  /**
   * Write one status and say what it now is (HIVE-117).
   *
   * Both verbs are this short because neither owns the *consequence*: pausing
   * does not stop anything here, it makes `RunTracker.run` refuse — which is
   * the one door every trigger passes through, today's `agents:run` and the
   * wakes HIVE-120 and HIVE-121 will add alike.
   *
   * `agentState` rather than `runs` is what they need, so both keep working
   * when an agent has never run: there is no tracker entry to pause.
   *
   * The answer is **read back** from the state rather than echoed from the
   * argument, for `pushAgentStatus`'s own reason: a reply and the next
   * `agents:list` must not be able to disagree.
   *
   * A missing state throws rather than answering. `run` and `kill` can both
   * report "the runtime is not up" inside their return types — `refused:
   * 'unknown'` and `false` — and this one cannot, since every member of
   * {@link AgentStatus} is a claim that something was written. Answering
   * `paused` for a pause that reached no file is the one outcome worth a
   * rejected promise.
   */
  const setAgentStatus = (name: string, status: AgentStatus): AgentStatus => {
    if (agentState === null) {
      throw new Error('The agent runtime is not running.');
    }

    const next = agentState.patch(name, { status });

    pushAgentStatus(name);
    /*
      And the socket (HIVE-124). A paused agent subscribes to nothing, so
      pausing the last one that named a channel is what closes the connection —
      and resuming it is what reopens it.

      Here rather than in the two handlers because this is the choke point both
      go through, exactly as `pushAgentStatus` is: a third verb that changed a
      status without re-asking the question would be a socket left open for an
      agent that no longer wants it, with nothing on screen to explain it.
    */
    slackBridge?.sync();

    return next.status;
  };

  /**
   * Refuse a name that is not an agent this machine has a definition for.
   *
   * `parseAgentNameRequest` validates the name's *shape* and nothing else, and
   * `AgentState.patch` creates an entry for whatever it is handed. Without this
   * check, `pause` on an unknown name writes `{"ghost": {"status": "paused"}}`
   * into `agents.json` permanently — and an agent later created under that name
   * would be born paused, refusing every trigger for a reason nothing on screen
   * explains. `BRIDGE_AGENTS_KEYS` claims these two verbs cannot create an
   * agent; this is what makes that true of its run state as well.
   *
   * HIVE-122's `rotate` is the third caller, for exactly this reason: it too
   * patches state before anything reads a definition.
   *
   * `run` needs no equivalent: it reaches `deps.command`, which reads the
   * definition off disk and refuses `invalid` when there is none.
   */
  const requireAgent = async (name: string): Promise<string> => {
    const snapshot = await agents?.list();

    if (!snapshot?.agents.some((agent) => agent.name === name)) {
      throw new Error(`No such agent: ${name}`);
    }

    return name;
  };

  /**
   * Force a handoff wake now (HIVE-122).
   *
   * `agents:run` with one field armed first, and the ordering is the point: the
   * flag is written to **state**, then the run goes through the ordinary door.
   * If the agent is busy or paused the run is refused exactly as `agents:run`
   * would refuse it — and the flag stays armed, so the wake that does happen is
   * the handoff wake. A rotation the user asked for is never silently dropped.
   *
   * `requireAgent` for `pause`'s reason and not `run`'s: this writes to
   * `agents.json` before it reaches anything that reads a definition, so
   * without the check a typo would leave `{"ghost": {"forceRotate": true}}` on
   * disk permanently — and an agent later created under that name would be
   * born owing a handoff for a conversation it never had.
   *
   * `agentState`, not the tracker, is what carries the flag, so arming a
   * rotation works on an agent that has never run: there is no tracker entry to
   * arm. `wake-command.ts` gives that case an ordinary first wake rather than a
   * last turn on a session that does not exist yet.
   *
   * The same two awaits as `run`, for the same two reasons, since this reaches
   * the same spawn: `PATH` may still be the pre-repair one, and `hive.mcp.json`
   * may not have been written yet.
   */
  handle(CH.agentsRotate, async (_event, payload): Promise<AgentRotateResult> => {
    const name = await requireAgent(parseAgentNameRequest(payload).name);

    if (agentState === null) {
      throw new Error('The agent runtime is not running.');
    }

    agentState.patch(name, { forceRotate: true });

    await loginEnvStatus();
    await mcp.start();

    return (
      runs?.run(name, 'manual') ?? {
        started: false,
        refused: 'unknown',
        reason: 'The agent runtime is not running.',
      }
    );
  });

  handle(CH.agentsPause, async (_event, payload): Promise<AgentStatus> =>
    // No `kill`. A pause lets the turn in flight finish — see the contract, and
    // `finalizeRun`, which is what stops that turn writing the pause back out.
    setAgentStatus(await requireAgent(parseAgentNameRequest(payload).name), 'paused'),
  );

  /**
   * Resume **recomputes** the resting status rather than restoring a
   * remembered one.
   *
   * Nothing records what an agent was before it was paused, and deliberately:
   * `AgentRunState` has no second representation of a status, and a remembered
   * `sleeping` would be wrong the moment the agent asked something while
   * paused — which is exactly when it can, since a turn in flight is allowed
   * to finish.
   *
   * The rule is `finalizeRun`'s, reused: an unanswered ask outranks everything
   * else, because status is about what the user must do next — with one term
   * `finalizeRun` does not need, because it only ever runs when the child is
   * already gone: a **live run outranks the ledger**. Pausing mid-turn does not
   * kill the child, so `paused` and "a process is running" are not exclusive,
   * and resuming into `sleeping` there would put a resting word on a row whose
   * agent is working — which `run` would then contradict by refusing.
   */
  handle(CH.agentsResume, async (_event, payload): Promise<AgentStatus> => {
    const name = await requireAgent(parseAgentNameRequest(payload).name);

    if (agentState === null) {
      throw new Error('The agent runtime is not running.');
    }

    /*
      Only a paused agent resumes.

      Without this the verb is destructive on every other status: a `working`
      agent resumed mid-turn would have its row rewritten to `sleeping` while
      its process is still running, and the next `finalizeRun` would be the
      only thing to put it right. Resume is the inverse of pause and nothing
      else, so anything not paused is already resumed — answer what it is.

      Read after the null check rather than through `?.`: answering `sleeping`
      for a resume that reached no file is exactly the lie the docblock above
      rejects for `pause`, and it is no more true here.
    */
    const current = agentState.read(name).status;

    if (current !== 'paused') return current;

    if (runs?.live().includes(name) === true) {
      /*
        No flush on this arm, deliberately (HIVE-120).

        A run is still in flight, so the agent cannot take a wake — and the
        queue is about to be flushed by the `onRunClosed` that run is going to
        fire, which will find the agent no longer paused and deliver it then.
        Flushing here would reach `refused: 'working'` and, having already
        cleared the queue, lose it.
      */
      return setAgentStatus(name, 'working');
    }

    setAgentStatus(name, hasOpenAsk(name) ? 'asking' : 'sleeping');

    /*
      What the pause was holding (HIVE-120): entries that arrived while this
      agent was stopped, delivered as one wake now that it is not. After the
      status is written, because the scheduler wakes through `RunTracker.run`
      and a `paused` still on disk would refuse it.
    */
    scheduler?.onResume(name);

    /*
      Read back **after** the flush, not captured before it.

      A queue standing at this moment starts a run inside `onResume`, which
      patches the status to `working` and pushes it. Answering with the value
      from before that would hand the renderer a `sleeping` the push it is about
      to receive already contradicts — the same disagreement `pushAgentStatus`
      re-reads the file to avoid.
    */
    return agentState.read(name).status;
  });

  /**
   * Getting a theme file on and off disk (HIVE-80).
   *
   * Neither verb takes a payload that names a destination: `pick` returns
   * whatever the open dialog chose, and `save`'s only renderer-supplied fields
   * are the file's contents and a suggested name for the save dialog — see
   * `parseSaveThemeRequest` for why both still need validating even though
   * neither is a path.
   */
  handle(CH.themePick, (event) => pickTheme(event));
  handle(CH.themeSave, (event, payload) =>
    saveTheme(event, parseSaveThemeRequest(payload)),
  );

  /**
   * What the renderer is showing (HIVE-81). Guarded to reject rather than
   * sanitise: a malformed payload is dropped and logged (see `on()` above),
   * never coerced into `null` — a compromised or buggy renderer must not be
   * able to make a fabricated shape read as "nothing on stage".
   */
  on(CH.uiForeground, (event, payload) => {
    if (!isRecord(payload)) throw new Error('ui:foreground expects an object');
    const keys = Object.keys(payload);
    /*
      `focused` is optional and only a socket sends it (HIVE-145): the client's
      main process stamps it while proxying, because it is the only process
      that can see that machine's windows. A local renderer sends the one-key
      shape it always did, and a window surface's focus is read live from
      `BrowserWindow` regardless of what arrives here.
    */
    if (keys.length === 0 || keys.length > 2) {
      throw new Error('ui:foreground expects { terminalId } or { terminalId, focused }');
    }
    for (const key of keys) {
      if (key !== 'terminalId' && key !== 'focused') {
        throw new Error('ui:foreground expects { terminalId } or { terminalId, focused }');
      }
    }
    if (!('terminalId' in payload)) {
      throw new Error('ui:foreground expects a terminalId');
    }
    const { terminalId } = payload;
    if (terminalId !== null && typeof terminalId !== 'string') {
      throw new Error('ui:foreground expects a string terminalId or null');
    }
    const reportedFocus = payload.focused;
    if (reportedFocus !== undefined && typeof reportedFocus !== 'boolean') {
      throw new Error('ui:foreground expects a boolean focused');
    }
    // Absent means not focused — the conservative default. See `foreground`.
    const focused = reportedFocus ?? false;

    const surfaceId = surfaceFor(event.sender);
    const before = foreground.get(surfaceId);
    if (before?.terminalId === terminalId && before.focused === focused) return;
    foreground.set(surfaceId, { terminalId, focused });
    notifyForegroundChange();
  });

  /**
   * What a session is called (HIVE-110). Guarded the same way and for the same
   * reason as `ui:foreground` above: rejected rather than sanitised, so a
   * malformed payload is dropped and logged instead of being coerced into a
   * name that would then appear in a toast.
   *
   * Recorded and nothing more — no notification is raised, nothing is
   * re-rendered. The only reader is the hub, at the moment it presents a toast.
   */
  on(CH.uiSessionName, (_event, payload) => {
    if (!isRecord(payload)) throw new Error('ui:session-name expects an object');
    const keys = Object.keys(payload);
    if (keys.length !== 2 || !keys.includes('terminalId') || !keys.includes('name')) {
      throw new Error('ui:session-name expects exactly { terminalId, name }');
    }
    const { terminalId, name } = payload;
    if (typeof terminalId !== 'string' || typeof name !== 'string') {
      throw new Error('ui:session-name expects string terminalId and name');
    }
    /*
      Capped at the same length `readTitle` caps the other name producer at
      (`sessions/index.ts`), and for a sharper reason here: `names.ts` claims its
      map is bounded by the number of sessions this process has spawned, and
      without a bound on either half of the pair that claim would rest on the
      renderer behaving — which this handler's own guard exists not to assume.
      The id is bounded by the same number: `sess-nn` and a `/clear` successor
      are both short, and nothing legitimate reaches this length.
    */
    if (
      terminalId.length > SESSION_NAME_DISPLAY_MAX ||
      name.length > SESSION_NAME_DISPLAY_MAX
    ) {
      throw new Error('ui:session-name expects a terminalId and name within bounds');
    }

    sessionNames.set(terminalId, name);
  });

  /**
   * The PTY channels (story 093).
   *
   * `spawn` and `kill` use `invoke` — both need a result. `write`, `resize`
   * and `ack` use `send`, and every one of them is validated before it reaches
   * process control.
   */
  /**
   * `sessionId` on the wire is an **entity** id.
   *
   * The renderer has always addressed terminals by entity id (story 094) and
   * never sees a pty handle. Story 096 makes the two genuinely different: main
   * mints a session id per generation, and the sessions layer translates in both
   * directions. Project resolution and every refusal message moved there with
   * it, so this handler is now only validation and delegation.
   */
  handle(CH.ptySpawn, async (_event, payload) => {
    const request = parseSpawnRequest(payload);
    /**
     * Wait for the login-shell import before the pty-host can be forked
     * (HIVE-84).
     *
     * This is the one await in this file that is about a *child process's*
     * environment rather than a reply. `forkPtyHost` passes no `env`, so the
     * utility process snapshots `process.env` **at fork time**, and the host is
     * forked lazily on the first spawn and then reused for the life of the app.
     * Without this, a user who clicks a project inside the first second — the
     * machine with the slow rc file, which is exactly the population the 5s
     * timeout exists for — forks the host with launchd's four-entry `PATH` and
     * freezes it there permanently, while Settings correctly reports that the
     * import succeeded.
     *
     * Costs nothing in the ordinary case: the probe starts at boot and has
     * long since resolved by the time anyone opens a session.
     */
    await loginEnvStatus();
    /**
     * Regenerate the skills plugin before the session is started (HIVE-96).
     *
     * Here rather than inside `spawn` because `spawn` is synchronous on
     * purpose — its "attach, never respawn" guard and the registration that
     * satisfies it must not be separated by an await. This handler is already
     * asynchronous and already waits for the login-shell probe, so the
     * regeneration is free of that constraint.
     *
     * Per spawn rather than at launch: a skill saved from Settings, or written
     * by hand into `~/.hive/skills` with the app already running, has to be on
     * *this* command line. A readdir over a handful of small files is cheaper
     * than any protocol that would tell us the tree changed.
     */
    await skills?.sync();
    /**
     * Wait for the MCP config write before a session can be spawned (HIVE-112).
     *
     * `mcp.start()` is fired once, unawaited, at construction so a slow write
     * cannot delay the first window — but `sessions.open()` calls `spawn()`
     * synchronously below, and `spawn()` reads `mcp.configPathFor()` the same
     * instant. Without this await, a session opened inside that window would
     * see `null` and start silently and permanently without ledger tools. The
     * promise is memoised, so this either resolves immediately (the ordinary
     * case, long since settled by the time anyone opens a session) or joins
     * the one write already in flight — never a second one.
     */
    await mcp.start();
    /**
     * A `rewrite` container project's per-session files (HIVE-133).
     *
     * Here rather than inside `spawn` for the reason `skills.sync()` above is:
     * `spawn` is synchronous on purpose, and its attach-never-respawn guard
     * must not be separated from the registration that satisfies it by an
     * await. This handler is already asynchronous.
     *
     * Keyed by **entity id**. `tokenFor` is HMAC(launchSecret, entityId) and the
     * receiver compares against `tokenFor(entityId)` for the id in
     * `x-hive-session`, so a directory named after the registry's generation id
     * would carry a token refused on every call.
     *
     * A no-op for a host project and for `exec-env`, where every per-session
     * value in the set is a `${VAR}` and there is nothing resolved to write.
     */
    /**
     * After any in-flight removal for this same id, never beside it.
     *
     * `settleExit` starts an `rm -rf` of this entity's session directory on
     * every ending and resolves its exit waiters without waiting for it, so
     * re-opening an entity whose previous generation has just exited can put
     * this write in the path of a deletion that is still running — losing the
     * four files it just produced, and spawning with no `--settings` and no
     * `--mcp-config`. `restartOnce` awaits the same promise for the same
     * reason; this is the other door into the same write.
     *
     * Resolves immediately in every ordinary case, this handler's own awaits
     * above having long since covered the removal.
     */
    await sessions?.containerRemoval(request.sessionId);
    await hooks?.writeContainerSession(request.sessionId, request.projectId);
    sessions?.open({
      entityId: request.sessionId,
      projectId: request.projectId,
      cols: request.cols,
      rows: request.rows,
      task: request.task,
      model: request.model,
      effort: request.effort,
      name: request.name,
      // HIVE-88. Forwarded only here — a restart is never a resume.
      resume: request.resume,
    });
  });

  handle(CH.ptySpawnTerminal, async (_event, payload) => {
    const request = parseSpawnTerminalRequest(payload);
    // The login-shell import is the only precondition a plain shell shares
    // with a session: no skills sync, no MCP config, no container files.
    await loginEnvStatus();
    sessions?.openTerminal({
      entityId: request.sessionId,
      projectId: request.projectId,
      cols: request.cols,
      rows: request.rows,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    });
  });

  handle(CH.ptyRestart, async (_event, payload) => {
    const request = parseSpawnRequest(payload);
    // Same fork race as `ptySpawn` above: a restart can be the call that first
    // brings the host up, so it has to wait for the same reason.
    await loginEnvStatus();
    // And the same regeneration, for the same reason: a restart builds a fresh
    // command line, so it must see the skills the user has now (HIVE-96).
    await skills?.sync();
    // Same wait as `ptySpawn` above, for the same reason: a restart's `spawn()`
    // reads `mcp.configPathFor()` synchronously too (HIVE-112).
    await mcp.start();
    /**
     * **Not** written here, unlike `ptySpawn` above (HIVE-133, post-review
     * fix). A restart's own teardown kills the old process and waits for its
     * exit before spawning the new one — and that exit unconditionally
     * removes this same entity id's container directory
     * (`removeSessionContainerFiles` in `settleExit`). A write landing here
     * would race that removal and lose: `sessions/index.ts`'s `restartOnce`
     * writes instead, in the one window between the old process actually
     * exiting and the new one spawning, which is the only ordering the
     * teardown cannot undo.
     */
    /**
     * The task is deliberately **not** forwarded (story 097).
     *
     * A restart discards a running agent's context and starts a fresh process.
     * Re-delivering an instruction the previous generation may already have
     * acted on — edited files, opened a PR — is worse than delivering nothing:
     * the user asked for a clean slate, not for the work to be redone.
     *
     * `model` and `effort` **are** forwarded, and the asymmetry is the point
     * (story 109): they describe the session, not the turn. Dropping them would
     * restart a Haiku session as whatever `claude` defaults to while its row
     * went on saying Haiku.
     */
    await sessions?.restart({
      entityId: request.sessionId,
      projectId: request.projectId,
      cols: request.cols,
      rows: request.rows,
      model: request.model,
      effort: request.effort,
      /**
       * Forwarded with `model` and `effort`, for their reason (HIVE-78): a name
       * describes the session, not the turn. A restarted `HIVE-73` that came
       * back as `sess-07` would rename a row the user has been watching.
       */
      name: request.name,
    });
  });

  handle(CH.ptyKill, (_event, payload) => {
    sessions?.kill(parseKillRequest(payload));
  });

  on(CH.ptyWrite, (_event, payload) => {
    const request = parseWriteRequest(payload);
    sessions?.write(request.sessionId, request.data);
  });

  on(CH.ptyResize, (_event, payload) => {
    const request = parseResizeRequest(payload);
    sessions?.resize(request.sessionId, request.cols, request.rows);
  });

  /**
   * The renderer — or an attached socket — says xterm has parsed up to `seq`,
   * which is what releases those bytes from the flow-control window
   * (`ipc/pty.ts`).
   *
   * **Keyed by the surface that acked (HIVE-145).** The window used to be per
   * *session* and an ack released it for everyone: with two surfaces watching
   * one terminal, the first to finish parsing a batch unpaused the producer for
   * both, so a fast client on a fast link let the pty outrun a slow one, whose
   * frames queued in `ws`'s own send buffer — which nothing here bounds — until
   * it was arbitrarily far behind or the process was holding megabytes for it.
   *
   * It follows the **slowest** surface now, and a surface that goes away
   * releases whatever it was holding, or a slow client could pause a session
   * forever by disconnecting. `ipc/pty.ts` holds the arithmetic and the two
   * cases that are easy to get wrong: a newcomer seeded at the head rather than
   * at zero, and an empty set releasing everything.
   *
   * `pty-transport.ts` records the same shape for split panes ("backpressure
   * follows the fastest pane"). That one is still open and still harmless for
   * the reason this one was until HIVE-144: both panes are the same surface, on
   * the same link, so there is no slow consumer for the fast one to outrun.
   */
  on(CH.ptyAck, (event, payload) => {
    const request = parseAckRequest(payload);
    sessions?.ack(request.sessionId, request.seq, surfaceFor(event.sender));
  });

  /**
   * The input-box report (HIVE-135). Session ids arriving from the renderer are
   * entity ids, as they are for `ack`; `deliver` keys its record by the same.
   *
   * Keyed by the surface that sent it (HIVE-145), which is also what registers
   * that surface's lifetime: a record left behind by a renderer that no longer
   * exists — or by a socket that dropped — would hold every nudge to that
   * session forever, since nothing would ever report it empty.
   *
   * `surfaceFor` cannot mislabel an attached socket as a window: the socket is
   * its own reporter and `onAttach` tracked it before any notify from it could
   * arrive, so this resolves to the existing surface, kind intact.
   */
  on(CH.ptyPrompt, (event, payload) => {
    const report = parsePromptReport(payload);
    deliver.onPrompt(surfaceFor(event.sender), report.sessionId, report.input);
  });

  /*
    Returned rather than left as a private closure (HIVE-144, Ruling 24):
    `router.ts`'s own `registerIpc('local', ...)` captures this and hands it
    to `registerRemoteProxy` as `localAppInfo` the next time this process
    attaches, so `CH.appInfo` keeps answering from *this* process's `hooks`,
    `remoteListener` and `sessions` — the exact instances this call just
    built — rather than from whatever the far end's own instances say.
  */
  return buildAppInfo;
}

/**
 * Drop the sessions layer, its timers, and every `ipcMain` binding this
 * process made.
 *
 * Was test-only until HIVE-144: the production mode switch calls this too,
 * to leave `ipcMain` clean before `registerIpcHandlers` runs again against a
 * different set of layers. See the `bindings.unbindAll()` comment below for
 * why the switch can trust this path.
 *
 * ## `flush`, and why a live switch is not a test teardown (HIVE-144, fix round 1)
 *
 * `history` and `agentState` both write on a 400 ms debounce, and this function
 * has always **cancelled** that timer rather than letting it fire —
 * deliberately, because a test's paths point at whatever `configPath()` and
 * `app.getPath` were stubbed to return, and writing there on teardown is how a
 * unit test comes to leave a file behind.
 *
 * That was correct while the only caller was a teardown. It stopped being
 * correct the moment a live mode switch called it: `runs?.closeAll('reset')`
 * below finalises every headless run in flight and schedules an `agents.json`
 * write carrying that run's summary, its `runsSinceRotate`, its `nextRunAt` —
 * and its `sessionUuid`, which is what the next wake `--resume`s from
 * (`agents/runs.ts`). The very next statement then cancelled it. A user who
 * attached, detached, or simply suffered a failed attach while an agent was
 * mid-run lost that conversation's continuity with no error anywhere: the next
 * wake would start a fresh conversation instead of resuming.
 *
 * The tell was that the shutdown hook (`onShutdown`, above) already performs
 * this exact sequence with `flush()` — one path flushed and the other dropped,
 * for the same data. So the choice is now the caller's, and the two production
 * callers make the same one.
 *
 * The default is **drop**, which keeps every existing suite writing nothing,
 * and `unbindEverything` in `ipc/router.ts` is the one caller that opts in.
 * The flush sits exactly where the shutdown hook's does — *after*
 * `runs.closeAll`, never before, or it would write the state as it was before
 * the run was finalised, which is the same loss with an extra file.
 */
export function resetIpcHandlers(options: { flush?: boolean } = {}): void {
  const { flush = false } = options;
  /*
    HIVE-142. Most tests never call `startRemoteListener`, so this is usually
    stopping a socket that was never bound — cheap, per `listener.ts`'s own
    `stop()`. The ones that do start it (a live suite, or a future test of
    this composition) must not leak a bound port into the next test.
  */
  void remoteListener?.stop();
  remoteListener = null;
  /*
    HIVE-143. Both are module scope and both are filled by
    `registerIpcHandlers`, so both leak into the next suite if they are not
    dropped here. An emptied registry is also the honest state for a socket
    that somehow outlives this teardown: `remote-dispatch.ts` answers
    `not-ready` rather than reaching a handler wired to a disposed layer.
  */
  remoteRegistry.clear();
  surfaces.clear();
  toastQueue.clear();
  /*
    HIVE-144. This makes the test-only reset and the production mode switch
    the same path: a live switch calls this to leave `ipcMain` clean before
    `registerIpcHandlers` runs again against a different set of layers, and it
    can trust that path precisely because every test in this suite already
    exercises it on every teardown.
  */
  bindings.unbindAll();
  sessions?.dispose();
  sessions = null;
  cloneFlow?.dispose();
  cloneFlow = null;
  fsWatch?.dispose();
  fsWatch = null;
  /*
    HIVE-87. Dropped without flushing: a test's history points at whatever
    `app.getPath` was stubbed to return, and writing there on teardown is how a
    unit test comes to leave a file behind.

    `dispose()` rather than just dropping the reference — the debounce timer
    closes over the write directly, so an unreferenced history still fires one
    last `writeFileSync` at that stubbed path.

    Unless the caller asked for a flush (HIVE-144) — a live mode switch is not
    a teardown, and the fleet as it stood a moment before the switch is the
    fleet the next launch should show.
  */
  if (flush) history?.flush();
  history?.dispose();
  history = null;
  /*
    HIVE-115. Killed rather than dropped: a spec that let a real run leak would
    leave a `claude -p` process running after the test that started it, and the
    registry holds an `fs.watch` handle and a debounce timer that would
    otherwise fire into the next test's handlers.

    `closeAll`, not `killAll`, and the ordering with `dispose()` on the next
    line is the whole reason. `killAll` only signals: the `'close'` events land
    afterwards, run `finalizeRun` → `recordRun` → `schedule()`, and arm a *new*
    400 ms timer against a state that has already been disposed — writing
    `agents.json` at whatever `configPath()` was stubbed to, which is precisely
    the leak `dispose()` exists to cancel, and pushing status into a torn-down
    IPC layer on the way. `closeAll` finalizes each run synchronously, so
    everything it schedules is scheduled *before* the dispose that cancels it.

    `agentState` is **disposed**, exactly as `history` is and for the same
    reason — a test's state file points at whatever `configPath` was stubbed to
    return, and writing there on teardown is how a unit test comes to leave a
    file behind. `dispose()` rather than dropping the reference, and rather
    than `flush()`: the debounce timer closes over the write directly, so an
    unreferenced state still fires one last `writeFileSync` at that stubbed
    path 400 ms later, into a directory the test that owned it has finished
    with.
  */
  /*
    Disarmed for the same reason `agentState` is disposed (HIVE-120): the sweep
    is a live interval closing over this registration's ledger, and one left
    running would fire into a torn-down composition — and, in a test, at a path
    the case that owned it has finished with.

    **Before `closeAll`**, which finalizes every live run synchronously and so
    reaches `onRunClosed` from inside this teardown. A flush there would spawn a
    real `claude` out of a unit test, and its finalizer would then write through
    an `agentState` disposed a few lines below.
  */
  /*
    Before `scheduler.stop()` and `runs.closeAll`, for the reason the rest of
    this sequence is ordered (HIVE-124): the bridge produces wakes, and one that
    outlives the scheduler calls `onEvent` into an `agentState` disposed a few
    lines below. It is the same class of bug `slackChildren` was created to fix,
    arriving through a different door.

    The reference is dropped as well as stopped, so a next registration builds
    its own rather than re-syncing this one's — a socket bound to a torn-down
    composition would push status into a dead `send` and wake through a `null`
    scheduler.
  */
  slackBridge?.stop();
  slackBridge = null;
  scheduler?.stop();
  scheduler = null;
  // Holds no resources of its own — no `.stop()` — but a stale reference
  // here would let a next test's `ledger.onChange` reach a `permissions`
  // built against this test's disposed `agents`/`ledger`.
  permissions = null;
  runs?.closeAll('reset');
  runs = null;
  /*
    **After `closeAll`, never before** (HIVE-144, fix round 1). `closeAll`
    finalises every live run synchronously, and `finalizeRun` writes that run's
    summary and its `sessionUuid` into this state on the way — so a flush that
    ran first would write the state as it was *before* the run was finalised,
    which loses exactly what this flush exists to keep and leaves a file behind
    to prove it did something.

    This is the same statement, in the same position, as the shutdown hook's
    own `runs?.closeAll('app-closed'); agentState?.flush();`. The two paths
    finally agree.
  */
  if (flush) agentState?.flush();
  agentState?.dispose();
  agentState = null;
  /*
    HIVE-123. Same reason the runs are killed above: a Slack child left running
    outlives the test that spawned it, and a resolved-but-forgotten in-flight
    entry would let the next registration join a promise built against this
    one's composition.
  */
  slackChildren?.abort();
  slackChildren = null;
  slackInFlight.clear();
  agents?.close();
  agents = null;
  knownAgents.clear();
  ledgerAgents.clear();
  agentSchedules.clear();
  agentParallel.clear();
  // Back to "nothing has been listed", not "nothing is scheduled": the next
  // registration must earn the right to clear a `nextRunAt` all over again.
  agentsListed = false;
  // HIVE-81. Test-only: a fresh registration starts with nothing on stage and
  // no listeners left over from a previous test — including the app-level
  // focus wiring and any tick it has already scheduled, which would otherwise
  // fire into the next test's handlers.
  foreground.clear();
  foregroundListeners.clear();
  unwatchWindowFocus?.();
  if (foregroundTick !== null) {
    clearTimeout(foregroundTick);
    foregroundTick = null;
  }
}

/**
 * Test-only: how many handlers the remote registry holds (HIVE-143).
 *
 * In the same register as {@link resetIpcHandlers} above — exported for the
 * composition suite and for nothing else. It is the one assertion that can
 * catch a channel added without a handler, a handler recorded twice, or a
 * registry that is populated in the wrong order relative to `startRemoteListener`.
 */
export function remoteRegistrySize(): number {
  return remoteRegistry.size();
}

/*
  There is deliberately no `attachForTest` here (HIVE-143 review).

  It existed so the composition suite could reach `attachedSockets` without a
  real `ws` server, and it was documented test-only — but a documented
  convention is not a fence. As an ordinary export it let any caller add an
  arbitrary object to the fan-out set, which is push access to every attached
  client's stream, from a module the whole main process already imports. The
  suite reaches the same set through the production door instead: it stands in
  for the listener, captures the real `onAttach` this file hands
  `createRemoteListener`, and calls that — which is also a stronger test, since
  it now covers the callback rather than bypassing it.
*/
export { assertSender, isTrustedSender, IpcSenderError } from './sender';

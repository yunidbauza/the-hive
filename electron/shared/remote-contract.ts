/**
 * The wire contract for server mode (HIVE-141).
 *
 * The Hive can run as two processes on two machines: a server that owns the
 * PTYs, the agents, the ledger and the config, and a client that owns a window.
 * Everything between them crosses this file. Nothing here opens a socket —
 * HIVE-142 and HIVE-143 do that — but every frame they exchange is shaped here
 * first, so the security decision is a table somebody read before it was a guard
 * somebody trusted.
 *
 * `electron/shared/**` rules apply: no runtime imports beyond this directory, no
 * Node APIs, no DOM APIs. `ipc-contract.ts` is the one import, and it is the
 * point — every map below is keyed by {@link CH} itself, so a channel added
 * there and forgotten here is a compile error rather than a channel that
 * silently crosses the wire unclassified.
 */

import { CH, type Channel } from './ipc-contract';

/**
 * Bumped whenever {@link CH} gains or loses an entry, or any payload type on an
 * existing channel changes shape.
 *
 * Two artifacts version independently once the app can be split across two
 * machines: the mini updates on its own schedule and the laptop on its own. The
 * handshake is the only place that can catch the skew while it is still a
 * refusal with a readable message, rather than a payload that deserialises into
 * the wrong shape three frames later.
 */
export const REMOTE_PROTOCOL_VERSION = 1;

/**
 * What a frame is for.
 *
 * The four kinds are not a design choice made here — they are the verb mix
 * `electron/preload/index.ts` already uses, read back off it. That mix encodes
 * which calls need an answer and which must never block, and it is load-bearing:
 * demote a `call` to a `notify` and a typed refusal stops reaching the renderer;
 * promote a `notify` to a `call` and the typing path acquires a round trip.
 *
 * - `call` — request/response. The client asks, the server answers with
 *   `result` or `error`. 86 channels.
 * - `notify` — fire and forget, client to server, ordered per session. 6
 *   channels. Ordering between a `pty:write` and a `pty:resize` is observable,
 *   so a transport may not reorder them.
 * - `event` — server to client push. 22 channels, including `pty:data`, the
 *   only hot path.
 * - `attach` — the handshake, and the only frame that may precede a version
 *   check. Exactly one per connection.
 */
export type FrameKind = 'call' | 'notify' | 'event' | 'attach';

/**
 * What a caller must be trusted with.
 *
 * Read as a ladder: `execute` implies `mutate` implies `read`. The classes are
 * defined by consequence, not by verb, which is why `fs:write-file` is not a
 * `mutate` — a file written into a project is a file the next agent run
 * executes.
 *
 * - `read` — the caller learns something. Nothing on the host outlives the call.
 * - `mutate` — the caller changes host state: config on disk, a credential in
 *   `safeStorage`, a record in a remote service, or in-memory state another
 *   observer can see.
 * - `execute` — the caller can cause code to run on the host, write content the
 *   host will later execute, or replace the running application.
 *
 * Server mode carries `pty:spawn`, `pty:write`, `fs:write-file`,
 * `config:set-runtime` and `agents:run`. Anyone who completes the handshake can
 * run arbitrary code as the user on the server, so this is a remote execution
 * endpoint rather than an app with a login, and the table is written from that
 * premise.
 */
export type Authorization = 'read' | 'mutate' | 'execute';

/**
 * Which frame carries which channel.
 *
 * Derived from two observable facts rather than restated: `EVENT_CHANNELS` and
 * the `invoke`/`send`/`subscribe` split in `electron/preload/index.ts`. Where
 * this map and the bridge disagree, the bridge is right and this map is a bug —
 * `tests/shared/remote-contract.test.ts` asserts they agree, reading both.
 *
 * One correction that assertion forced: `EVENT_CHANNELS` lists 18 channels, but
 * 22 are pushed. `slack:socket-status` and the three `notifications:*` pushes
 * are subscribed in the bridge without appearing in that array — the three go
 * out through the hub's own loops at `ipc/index.ts:872-892`, deliberately
 * bypassing the tapped fan-out so the notifier's output cannot re-enter its
 * input (HIVE-75). They are pushes all the same, and a remote client that only
 * forwarded `EVENT_CHANNELS` would lose every notification.
 */
export const FRAME_KIND = {
[CH.configGet]: 'call',
  [CH.configReload]: 'call',
  [CH.configChooseDirectory]: 'call',
  [CH.configAddProject]: 'call',
  [CH.configRemoveProject]: 'call',
  [CH.configRenameProject]: 'call',
  [CH.configRepointProject]: 'call',
  [CH.configReorderProjects]: 'call',
  [CH.configSetProjectKey]: 'call',
  [CH.configSetRuntime]: 'call',
  [CH.configSetProjectRuntime]: 'call',
  [CH.configDiagnoseCommand]: 'call',
  [CH.configDiagnoseEnv]: 'call',
  [CH.configSetNotifications]: 'call',
  [CH.configReveal]: 'call',
  [CH.configReset]: 'call',
  [CH.integrationsStatus]: 'call',
  [CH.integrationsLoginEnv]: 'call',
  [CH.configSetJira]: 'call',
  [CH.configSetSlack]: 'call',
  [CH.configSetReceiver]: 'call',
  [CH.jiraStatus]: 'call',
  [CH.jiraSetToken]: 'call',
  [CH.jiraClearToken]: 'call',
  [CH.jiraTest]: 'call',
  [CH.jiraSearch]: 'call',
  [CH.jiraIssue]: 'call',
  [CH.jiraTransitions]: 'call',
  [CH.jiraApplyTransition]: 'call',
  [CH.jiraComments]: 'call',
  [CH.jiraLinks]: 'call',
  [CH.jiraAddComment]: 'call',
  [CH.slackStatus]: 'call',
  [CH.slackSignIn]: 'call',
  [CH.slackSignOut]: 'call',
  [CH.slackTest]: 'call',
  [CH.slackSetTokens]: 'call',
  [CH.slackClearTokens]: 'call',
  [CH.slackSocketStatus]: 'event',
  [CH.slackSocketState]: 'call',
  [CH.slackSocketTest]: 'call',
  [CH.githubPrs]: 'call',
  [CH.githubSearchPrs]: 'call',
  [CH.notificationsActivate]: 'event',
  [CH.notificationsNew]: 'event',
  [CH.notificationsList]: 'call',
  [CH.notificationsMarkRead]: 'call',
  [CH.notificationsDismiss]: 'call',
  [CH.notificationsClear]: 'call',
  [CH.notificationsRead]: 'event',
  [CH.notificationsDismissed]: 'event',
  [CH.notificationsDelivery]: 'call',
  [CH.notificationsAct]: 'call',
  [CH.ledgerList]: 'call',
  [CH.ledgerPost]: 'call',
  [CH.ledgerAnswer]: 'call',
  [CH.ledgerChanged]: 'event',
  [CH.updatesStatus]: 'call',
  [CH.updatesCheck]: 'call',
  [CH.configCloneStart]: 'call',
  [CH.configCloneCancel]: 'call',
  [CH.configCloneDone]: 'event',
  [CH.ptySpawn]: 'call',
  [CH.ptyWrite]: 'notify',
  [CH.ptyResize]: 'notify',
  [CH.ptyKill]: 'call',
  [CH.ptyAck]: 'notify',
  [CH.ptyPrompt]: 'notify',
  [CH.ptyData]: 'event',
  [CH.ptyExit]: 'event',
  [CH.ptyLost]: 'event',
  [CH.ptyRestart]: 'call',
  [CH.sessionStatus]: 'event',
  [CH.sessionName]: 'event',
  [CH.sessionCleared]: 'event',
  [CH.sessionFinished]: 'event',
  [CH.sessionBranch]: 'event',
  [CH.sessionReady]: 'event',
  [CH.sessionTicketIntent]: 'event',
  [CH.sessionMetrics]: 'event',
  [CH.sessionHistory]: 'call',
  [CH.sessionNote]: 'call',
  [CH.sessionPr]: 'call',
  [CH.fsReadDir]: 'call',
  [CH.fsRoot]: 'call',
  [CH.fsReadFile]: 'call',
  [CH.fsWriteFile]: 'call',
  [CH.fsSearch]: 'call',
  [CH.fsWatch]: 'call',
  [CH.fsUnwatch]: 'call',
  [CH.fsChanged]: 'event',
  [CH.skillsList]: 'call',
  [CH.skillsRead]: 'call',
  [CH.skillsWrite]: 'call',
  [CH.skillsRemove]: 'call',
  [CH.skillsRename]: 'call',
  [CH.agentsList]: 'call',
  [CH.agentsRead]: 'call',
  [CH.agentsWrite]: 'call',
  [CH.agentsRemove]: 'call',
  [CH.agentsRename]: 'call',
  [CH.agentsChanged]: 'event',
  [CH.agentsRun]: 'call',
  [CH.agentsKill]: 'call',
  [CH.agentsPause]: 'call',
  [CH.agentsResume]: 'call',
  [CH.agentsRotate]: 'call',
  [CH.agentsStatus]: 'event',
  [CH.agentsLines]: 'event',
  [CH.appInfo]: 'call',
  [CH.themePick]: 'call',
  [CH.themeSave]: 'call',
  [CH.uiForeground]: 'notify',
  [CH.uiSessionName]: 'notify',
} as const satisfies Record<Channel, Exclude<FrameKind, 'attach'>>;

/**
 * What each channel costs to call, default deny.
 *
 * Local mode consults this and always allows — the table guards nothing today.
 * That is the point of landing it a story early: a security decision this broad
 * should be reviewed as a table, in one diff, before it is the thing standing
 * between a socket and `pty:spawn`.
 *
 * `event` channels carry a class too, because the ticket asks for all 114
 * classified exactly once and a hole in a default-deny table is worse than an
 * over-classification. For a push the class is the privilege needed to *receive*
 * it, which is `read` for all 22: a client cannot cause an event, only observe
 * one.
 *
 * The sixteen `execute` entries, each with its reason:
 *
 * - `pty:spawn`, `pty:write`, `pty:kill`, `pty:restart` — drive a real process.
 * - `fs:write-file`, `skills:write`, `agents:write` — write content the host
 *   later executes. A skill file and an `AGENT.md` are instructions a model
 *   follows with tools in hand; they are code with a friendlier extension.
 * - `config:set-runtime`, `config:set-project-runtime` — name the command a
 *   session spawns. Whoever writes this writes what `pty:spawn` runs.
 * - `config:clone-start` — runs `git clone` against a caller-supplied URL.
 * - `agents:run`, `agents:resume` — start a headless `claude` run. `kill` and
 *   `pause` only ever stop one, so they stay `mutate`.
 * - `ledger:post`, `ledger:answer` — deliver text into a live session's context.
 *   A model that reads it has tools, so this is prompt injection with a
 *   delivery mechanism, and it is classified for what it can cause rather than
 *   for the row it appends.
 * - `notifications:act` — carries out a queued action, which includes answering
 *   a permission prompt. Answering one authorises a tool call.
 * - `updates:check` — can download and install a new binary over the running
 *   application.
 */
export const CHANNEL_AUTHORIZATION = {
[CH.configGet]: 'read',
  [CH.configReload]: 'mutate',
  [CH.configChooseDirectory]: 'read',
  [CH.configAddProject]: 'mutate',
  [CH.configRemoveProject]: 'mutate',
  [CH.configRenameProject]: 'mutate',
  [CH.configRepointProject]: 'mutate',
  [CH.configReorderProjects]: 'mutate',
  [CH.configSetProjectKey]: 'mutate',
  [CH.configSetRuntime]: 'execute',
  [CH.configSetProjectRuntime]: 'execute',
  [CH.configDiagnoseCommand]: 'read',
  [CH.configDiagnoseEnv]: 'read',
  [CH.configSetNotifications]: 'mutate',
  [CH.configReveal]: 'read',
  [CH.configReset]: 'mutate',
  [CH.integrationsStatus]: 'read',
  [CH.integrationsLoginEnv]: 'read',
  [CH.configSetJira]: 'mutate',
  [CH.configSetSlack]: 'mutate',
  [CH.configSetReceiver]: 'mutate',
  [CH.jiraStatus]: 'read',
  [CH.jiraSetToken]: 'mutate',
  [CH.jiraClearToken]: 'mutate',
  [CH.jiraTest]: 'read',
  [CH.jiraSearch]: 'read',
  [CH.jiraIssue]: 'read',
  [CH.jiraTransitions]: 'read',
  [CH.jiraApplyTransition]: 'mutate',
  [CH.jiraComments]: 'read',
  [CH.jiraLinks]: 'read',
  [CH.jiraAddComment]: 'mutate',
  [CH.slackStatus]: 'read',
  [CH.slackSignIn]: 'mutate',
  [CH.slackSignOut]: 'mutate',
  [CH.slackTest]: 'read',
  [CH.slackSetTokens]: 'mutate',
  [CH.slackClearTokens]: 'mutate',
  [CH.slackSocketStatus]: 'read',
  [CH.slackSocketState]: 'read',
  [CH.slackSocketTest]: 'read',
  [CH.githubPrs]: 'read',
  [CH.githubSearchPrs]: 'read',
  [CH.notificationsActivate]: 'read',
  [CH.notificationsNew]: 'read',
  [CH.notificationsList]: 'read',
  [CH.notificationsMarkRead]: 'mutate',
  [CH.notificationsDismiss]: 'mutate',
  [CH.notificationsClear]: 'mutate',
  [CH.notificationsRead]: 'read',
  [CH.notificationsDismissed]: 'read',
  [CH.notificationsDelivery]: 'read',
  [CH.notificationsAct]: 'execute',
  [CH.ledgerList]: 'read',
  [CH.ledgerPost]: 'execute',
  [CH.ledgerAnswer]: 'execute',
  [CH.ledgerChanged]: 'read',
  [CH.updatesStatus]: 'read',
  [CH.updatesCheck]: 'execute',
  [CH.configCloneStart]: 'execute',
  [CH.configCloneCancel]: 'mutate',
  [CH.configCloneDone]: 'read',
  [CH.ptySpawn]: 'execute',
  [CH.ptyWrite]: 'execute',
  [CH.ptyResize]: 'mutate',
  [CH.ptyKill]: 'execute',
  [CH.ptyAck]: 'read',
  [CH.ptyPrompt]: 'mutate',
  [CH.ptyData]: 'read',
  [CH.ptyExit]: 'read',
  [CH.ptyLost]: 'read',
  [CH.ptyRestart]: 'execute',
  [CH.sessionStatus]: 'read',
  [CH.sessionName]: 'read',
  [CH.sessionCleared]: 'read',
  [CH.sessionFinished]: 'read',
  [CH.sessionBranch]: 'read',
  [CH.sessionReady]: 'read',
  [CH.sessionTicketIntent]: 'read',
  [CH.sessionMetrics]: 'read',
  [CH.sessionHistory]: 'read',
  [CH.sessionNote]: 'mutate',
  [CH.sessionPr]: 'read',
  [CH.fsReadDir]: 'read',
  [CH.fsRoot]: 'read',
  [CH.fsReadFile]: 'read',
  [CH.fsWriteFile]: 'execute',
  [CH.fsSearch]: 'read',
  [CH.fsWatch]: 'read',
  [CH.fsUnwatch]: 'read',
  [CH.fsChanged]: 'read',
  [CH.skillsList]: 'read',
  [CH.skillsRead]: 'read',
  [CH.skillsWrite]: 'execute',
  [CH.skillsRemove]: 'mutate',
  [CH.skillsRename]: 'mutate',
  [CH.agentsList]: 'read',
  [CH.agentsRead]: 'read',
  [CH.agentsWrite]: 'execute',
  [CH.agentsRemove]: 'mutate',
  [CH.agentsRename]: 'mutate',
  [CH.agentsChanged]: 'read',
  [CH.agentsRun]: 'execute',
  [CH.agentsKill]: 'mutate',
  [CH.agentsPause]: 'mutate',
  [CH.agentsResume]: 'execute',
  [CH.agentsRotate]: 'mutate',
  [CH.agentsStatus]: 'read',
  [CH.agentsLines]: 'read',
  [CH.appInfo]: 'read',
  [CH.themePick]: 'read',
  [CH.themeSave]: 'mutate',
  [CH.uiForeground]: 'mutate',
  [CH.uiSessionName]: 'mutate',
} as const satisfies Record<Channel, Authorization>;

/**
 * The first frame on every connection, and the only one that may precede a
 * version check.
 *
 * The token is a per-device secret minted by the server (HIVE-142), not the
 * per-session HMAC the hook receiver hands to `claude` processes. Different
 * audience, different lifetime: this one survives a reboot and is revoked per
 * device.
 */
export interface AttachRequest {
  kind: 'attach';
  /** The client's {@link REMOTE_PROTOCOL_VERSION}. */
  protocol: number;
  /** Which paired device is speaking. Never a secret on its own. */
  deviceId: string;
  /** The device secret, compared in constant time by the server. */
  token: string;
  /**
   * Last sequence seen per session, so the server can replay from `Scrollback`
   * rather than the client re-rendering a transcript it already has. Empty on a
   * first attach. See `electron/pty-host/scrollback.ts` for what backs it, and
   * the existing gap notice for what happens when the buffer no longer reaches.
   */
  resumeFrom?: Readonly<Record<string, number>>;
}

/** Everything a client needs to render a busy server without a second call. */
export interface AttachAccepted {
  kind: 'attach-accepted';
  protocol: number;
  /** What the client puts in the header indicator: "attached · mini". */
  serverName: string;
  /**
   * The full state snapshot, channel-keyed so it stays honest as `CH` grows:
   * every entry is the payload that channel's `call` would have returned.
   */
  snapshot: Readonly<Partial<Record<Channel, unknown>>>;
}

/**
 * Why a handshake was refused.
 *
 * `protocol-mismatch` names both versions and which side to update; the others
 * are deliberately indistinguishable to the caller, because telling an attacker
 * whether a device id exists is telling them something.
 */
export type AttachRefusalCode =
  | 'protocol-mismatch'
  | 'unauthorized'
  | 'revoked'
  | 'origin-refused';

export interface AttachRefused {
  kind: 'attach-refused';
  code: AttachRefusalCode;
  /** The server's version, so a mismatch can be read without a second round. */
  protocol: number;
  message: string;
}

/** A `call`: the client asks and waits. */
export interface CallFrame {
  kind: 'call';
  /** Correlates with exactly one {@link ResultFrame} or {@link ErrorFrame}. */
  id: string;
  channel: Channel;
  payload: unknown;
}

export interface ResultFrame {
  kind: 'result';
  id: string;
  payload: unknown;
}

/**
 * A refusal, carried with its code intact.
 *
 * The contract's refusals mean things. `IpcValidationError` from
 * `electron/shared/guards.ts` is not the same failure as an `EOUTSIDE` in
 * `FsResult`, and the explorer and editor branch on the difference. Flattening
 * either to a message string would turn a precise failure into a generic one and
 * quietly delete behaviour that is correct today, so the code crosses the wire
 * and the message is for the human.
 */
export interface ErrorFrame {
  kind: 'error';
  id: string;
  /** `EOUTSIDE`, `IpcValidationError`, and every other code the contract names. */
  code: string;
  message: string;
}

/** A `notify`: client to server, no answer, ordered per session. */
export interface NotifyFrame {
  kind: 'notify';
  channel: Channel;
  payload: unknown;
}

/** An `event`: server to client push. */
export interface EventFrame {
  kind: 'event';
  channel: Channel;
  payload: unknown;
}

/** Client to server. */
export type ClientFrame = AttachRequest | CallFrame | NotifyFrame;

/** Server to client. */
export type ServerFrame = AttachAccepted | AttachRefused | ResultFrame | ErrorFrame | EventFrame;

export type RemoteFrame = ClientFrame | ServerFrame;

/**
 * The frame kind for a channel name off the wire, or `null` if there is no such
 * channel.
 *
 * Takes a `string` rather than a {@link Channel} on purpose: the caller is
 * holding something a socket handed it, and the whole job of this function is to
 * decide whether that string is a channel at all. Typing the parameter as
 * `Channel` would move the decision to the caller, which is where it gets
 * skipped.
 */
export function frameKindOf(channel: string): Exclude<FrameKind, 'attach'> | null {
  return Object.hasOwn(FRAME_KIND, channel)
    ? FRAME_KIND[channel as Channel]
    : null;
}

/**
 * What a channel costs to call, or `null` if it is not a channel.
 *
 * `null` is the default deny. A caller that treats it as "no restriction" has
 * inverted the contract, so there is no overload that returns a permissive
 * default and nothing here falls back to `read`.
 */
export function authorizationOf(channel: string): Authorization | null {
  return Object.hasOwn(CHANNEL_AUTHORIZATION, channel)
    ? CHANNEL_AUTHORIZATION[channel as Channel]
    : null;
}

/** Ladder order, so a grant of `execute` covers `mutate` and `read`. */
const RANK: Readonly<Record<Authorization, number>> = {
  read: 0,
  mutate: 1,
  execute: 2,
};

/**
 * Whether a caller granted `granted` may use `channel`.
 *
 * Unknown channel is refused. That is the whole of the default-deny rule, and it
 * lives in one function so a future listener cannot implement a second, laxer
 * version of it by accident.
 */
export function isAuthorized(channel: string, granted: Authorization): boolean {
  const required = authorizationOf(channel);
  return required !== null && RANK[granted] >= RANK[required];
}

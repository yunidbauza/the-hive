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
 *
 * **1 → 2 (HIVE-144):** {@link AttachRequest.resumeFrom} changed from
 * `Record<string, number>` — a bare `seq` per session — to
 * `Record<string, ResumePoint>`, a `{ gen, seq }` pair. A bare seq could not
 * tell a client which *process* it counted: a restart mints a fresh generation
 * whose `seq` also starts at 0, so a client that reattached after a restart
 * with only its old `seq` got the new generation's batches renumbered onto its
 * old transcript as though nothing had happened. `gen` is what lets the server
 * answer a real discontinuity with `gap` instead of a contiguous, wrong,
 * `replay`. A v1 client's bare-number `resumeFrom` is rejected by
 * `isResumeFromShaped` rather than misread as `{ gen: <a seq>, seq: undefined }`
 * — which is exactly what this version bump exists to force: an old client
 * talking to a new server fails the handshake instead of being silently
 * misunderstood.
 */
export const REMOTE_PROTOCOL_VERSION = 2;

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
 *   `result` or `error`. 99 channels.
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
 * out through the hub's own loops at `ipc/index.ts:887-899`, deliberately
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
  [CH.configSetServer]: 'call',
  [CH.serverPair]: 'call',
  [CH.serverRevoke]: 'call',
  [CH.configSetRemote]: 'call',
  [CH.remotePair]: 'call',
  [CH.remoteForget]: 'call',
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
  [CH.skillsFileRead]: 'call',
  [CH.skillsFileWrite]: 'call',
  [CH.skillsFileMkdir]: 'call',
  [CH.skillsFileRemove]: 'call',
  [CH.skillsFileMove]: 'call',
  [CH.skillsFileImport]: 'call',
  [CH.skillsFileDrop]: 'call',
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
 * `event` channels carry a class too, because the ticket asks for all 127
 * classified exactly once and a hole in a default-deny table is worse than an
 * over-classification. For a push the class is the privilege needed to *receive*
 * it, which is `read` for all 22: a client cannot cause an event, only observe
 * one.
 *
 * That reasoning covers the 22 pushes and **nothing else**. It does not extend
 * to the 6 client-sent `notify` channels, which look passive and are not — see
 * `pty:ack` and `pty:prompt` above. Grading a channel by the tone of its name is
 * how both of those came out wrong on the first pass.
 *
 * The thirty-one `execute` entries, each with its reason. The list is long
 * because the rule was applied by reading each handler rather than by trusting
 * the channel's name, and a surprising number of innocuously-named reads spawn a
 * process:
 *
 * - `pty:spawn`, `pty:write`, `pty:restart` — start a process, or type into one.
 *   `pty:kill` is deliberately NOT here: it can only ever stop something, which
 *   is `mutate`, and that is the same reading that keeps `agents:kill` and
 *   `agents:pause` out. If killing were `execute` the rule would stop being
 *   re-derivable from the grades.
 * - `pty:prompt` — reads as a passive report of what the input box holds, and is
 *   not one. `deliver.onPrompt` treats an `empty` transition as a flush trigger
 *   (`ledger/deliver.ts:242`), writing held ledger nudges into the running PTY.
 *   A forged report therefore delivers text into a session of the caller's
 *   choosing, which is the same capability `ledger:post` is graded for.
 * - `fs:write-file`, `skills:write`, `agents:write`, `skills:file:write`,
 *   `skills:file:import`, `skills:file:drop` (HIVE-148) — write content the
 *   host later executes. A skill file and an `AGENT.md` are instructions a
 *   model follows with tools in hand; they are code with a friendlier
 *   extension, and that holds for any file inside a skill's bundle, not only
 *   `SKILL.md` — `import` and `drop` just source their bytes from outside the
 *   app rather than from the pane's own editor. `skills:file:mkdir` stays
 *   `mutate`: an empty directory is structure, not content.
 * - `config:set-runtime`, `config:set-project-runtime` — name the command a
 *   session spawns. Whoever writes this writes what `pty:spawn` runs.
 * - `config:clone-start` — runs `git clone` against a caller-supplied URL.
 * - `config:diagnose-command` — runs its probe through `/bin/sh -c` on the host
 *   (`config/runtime.ts:195`). `tests/e2e/electron/security.spec.ts` already
 *   says of it: "the first payload on this bridge that main executes at all
 *   outside a session's own terminal".
 * - `config:diagnose-env` — spawns the configured shell **login and
 *   interactive** with `cwd` set to the project's own directory
 *   (`config/env-diagnostic.ts:218`). That sources `.zshrc`, and anything
 *   directory-keyed that a shell startup consults. Grading this `read` left a
 *   real escalation: `config:add-project` is `mutate` and takes a path, so a
 *   `mutate`-granted device could point a project at a directory it controls and
 *   then call a "read" to get code execution as the user on the server.
 * - `github:prs`, `github:search-prs`, `integrations:status` — spawn `gh`. The
 *   handler comment at `ipc/index.ts:1064` says of the third that it
 *   "**executes `gh`**", which is as clear a statement as the codebase offers.
 * - `integrations:login-env` — spawns the login shell to snapshot its
 *   environment. It takes no payload, which bounds the injection surface but not
 *   the fact that a process runs.
 * - `slack:status`, `slack:test`, `slack:sign-in`, `slack:sign-out` — all
 *   resolve and spawn the `claude` binary and run model turns with tools in
 *   hand. `slack:socket-state` and `slack:socket-test` do not, and stay `read`
 *   and `mutate`: the first is two property reads, the second exercises the
 *   Slack socket over the network without starting anything locally.
 * - `agents:run`, `agents:resume` — start a headless `claude` run.
 * - `ledger:post`, `ledger:answer` — deliver text into a live session's context.
 *   A model that reads it has tools, so this is prompt injection with a delivery
 *   mechanism, graded for what it can cause rather than for the row it appends.
 * - `notifications:act` — carries out a queued action, which includes answering
 *   a permission prompt. Answering one authorises a tool call.
 * - `updates:check` — can download and install a new binary over the running
 *   application.
 * - `server:pair`, `server:revoke` (HIVE-142) — mint or destroy a device
 *   credential. The same register as `agents:run`: whoever holds a paired
 *   device's token can reach the entire IPC surface, which is a strictly
 *   larger capability than any single channel that credential could later
 *   call. `config:set-server` stays `mutate` — it only ever writes `enabled`
 *   and `bind`, both already resolved by {@link ConfigSnapshot.server};
 *   minting and destroying the credential itself is what `server:pair` and
 *   `server:revoke` are for.
 * - `remote:pair`, `remote:forget` (HIVE-144) stay `mutate`, and are **not**
 *   graded like `server:pair`/`server:revoke` above despite both storing a
 *   secret: `server:pair` mints a *new* credential that grants its holder
 *   this machine's entire IPC surface — the capability the `execute` grade is
 *   for. `remote:pair` stores a credential *this device* was already handed,
 *   for attaching *outward* as a client to someone else's server; whoever can
 *   already call it could already call every other channel on this bridge, so
 *   the call itself grants nothing new here. It can still redirect where this
 *   window attaches next (paired with `config:set-remote`'s `host`), which is
 *   why it is graded above a plain settings write rather than folded into
 *   `read` — but it is not the "mint a master key" register `server:pair` is.
 *   `config:set-remote` is `mutate` for the same reason `config:set-server`
 *   is: it only ever writes what {@link ConfigSnapshot.remote} resolves to,
 *   never a credential.
 *
 * Two channels that read like `read` and are `mutate`: `session:pr` returns
 * `void` and calls `history.record` (`ipc/index.ts:2162`), a persistent write —
 * it is `session:note`'s sibling and had to be graded like it; and `pty:ack` is
 * a client-sent `notify` that releases per-session backpressure
 * (`sessions/index.ts`), so a client can ack sequences it never received.
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
  [CH.configDiagnoseCommand]: 'execute',
  [CH.configDiagnoseEnv]: 'execute',
  [CH.configSetNotifications]: 'mutate',
  [CH.configReveal]: 'read',
  [CH.configReset]: 'mutate',
  [CH.integrationsStatus]: 'execute',
  [CH.integrationsLoginEnv]: 'execute',
  [CH.configSetJira]: 'mutate',
  [CH.configSetSlack]: 'mutate',
  [CH.configSetReceiver]: 'mutate',
  [CH.configSetServer]: 'mutate',
  [CH.serverPair]: 'execute',
  [CH.serverRevoke]: 'execute',
  [CH.configSetRemote]: 'mutate',
  [CH.remotePair]: 'mutate',
  [CH.remoteForget]: 'mutate',
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
  [CH.slackStatus]: 'execute',
  [CH.slackSignIn]: 'execute',
  [CH.slackSignOut]: 'execute',
  [CH.slackTest]: 'execute',
  [CH.slackSetTokens]: 'mutate',
  [CH.slackClearTokens]: 'mutate',
  [CH.slackSocketStatus]: 'read',
  [CH.slackSocketState]: 'read',
  [CH.slackSocketTest]: 'read',
  [CH.githubPrs]: 'execute',
  [CH.githubSearchPrs]: 'execute',
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
  [CH.ptyKill]: 'mutate',
  [CH.ptyAck]: 'mutate',
  [CH.ptyPrompt]: 'execute',
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
  [CH.sessionPr]: 'mutate',
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
  [CH.skillsFileRead]: 'read',
  [CH.skillsFileWrite]: 'execute',
  [CH.skillsFileMkdir]: 'mutate',
  [CH.skillsFileRemove]: 'mutate',
  [CH.skillsFileMove]: 'mutate',
  [CH.skillsFileImport]: 'execute',
  [CH.skillsFileDrop]: 'execute',
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
 * Channels that cannot be answered for a socket, and the ticket that fixes each
 * (HIVE-143).
 *
 * Exactly five channels in the whole surface dereference the Electron event
 * they are handed. Four of them do it for the same reason — resolving a parent
 * `BrowserWindow` for a native dialog — and server mode opens no window at all,
 * so `BrowserWindow.fromWebContents` has nothing to return. Proxied as-is they
 * would not throw: `config:choose-directory` returns `null` and reads to the
 * user as a cancelled dialog, which is a silent failure rather than a loud one.
 *
 * Refused by name instead, so a remote client gets a code it can act on and a
 * message naming the work. HIVE-146 deletes three of these as it lands each
 * replacement — a server-side browser for the first, a client-side import and
 * export for the two theme ones.
 *
 * `skills:file:import` is the fourth and is **not** HIVE-146's, so this table
 * does not go away with it (HIVE-148). There is nothing to move to a
 * client-side picker: choosing files for a skill on the server would copy the
 * *server's* files rather than the user's, which is not a worse version of the
 * feature but a different and wrong one. `skills:file:drop` already carries
 * files from the machine the user is sitting at, so the refusal names it.
 *
 * The fifth, `pty:prompt`, is deliberately absent. It uses the event for a
 * surface *lifetime* rather than a window, and `watchReporter` already accepts
 * anything with an `.on`, so a socket satisfies it. Refusing it would silently
 * revert HIVE-135's nudge holding for every remote session.
 */
export const WINDOW_BOUND = {
  [CH.configChooseDirectory]:
    'Choosing a directory opens a dialog on the server, which has no window. HIVE-146 replaces it with a server-side browser.',
  [CH.skillsFileImport]:
    'Adding files to a skill opens a dialog on the server, which has no window — and would copy the server’s files, not yours. Drag them onto the skill instead.',
  [CH.themePick]:
    'Importing a theme reads a file on the machine the user is sitting at. HIVE-146 keeps it on the client.',
  [CH.themeSave]:
    'Exporting a theme writes a file on the machine the user is sitting at. HIVE-146 keeps it on the client.',
} as const satisfies Partial<Record<Channel, string>>;

/**
 * Why `channel` cannot be answered for a socket, or `null` if it can.
 *
 * Takes a `string` for the reason {@link frameKindOf} does: the caller is
 * holding something a socket sent it.
 */
export function windowBoundReason(channel: string): string | null {
  return Object.hasOwn(WINDOW_BOUND, channel)
    ? WINDOW_BOUND[channel as keyof typeof WINDOW_BOUND]
    : null;
}

/**
 * The first frame on every connection, and the only one that may precede a
 * version check.
 *
 * The token is a per-device secret minted by the server (HIVE-142), not the
 * per-session HMAC the hook receiver hands to `claude` processes. Different
 * audience, different lifetime: this one survives a reboot and is revoked per
 * device.
 */
/**
 * What a client remembers about one entity's stream: which generation it was
 * watching, and how far into it (HIVE-144).
 *
 * Both fields are required, not `seq` alone, because `seq` resets to 0 on
 * every restart — see {@link DataEvent.gen} and `REMOTE_PROTOCOL_VERSION`'s
 * doc comment for the failure a bare `seq` produced.
 */
export interface ResumePoint {
  gen: number;
  seq: number;
}

export interface AttachRequest {
  kind: 'attach';
  /** The client's {@link REMOTE_PROTOCOL_VERSION}. */
  protocol: number;
  /** Which paired device is speaking. Never a secret on its own. */
  deviceId: string;
  /** The device secret, compared in constant time by the server. */
  token: string;
  /**
   * Last generation and sequence seen per session, so the server can replay
   * from `Scrollback` rather than the client re-rendering a transcript it
   * already has — or answer `gap` when the generation it names is not the one
   * still running (HIVE-144).
   *
   * **Absent** on a first attach, never `{}`. The two are different questions —
   * "I have never been here" versus "I have been here and hold nothing" — and a
   * server that branches on one while the client sends the other replays the
   * wrong thing. `electron/remote-client/index.ts` omits the key for this
   * reason. See `electron/pty-host/scrollback.ts` for what backs it, and the
   * existing gap notice for what happens when the buffer no longer reaches.
   */
  resumeFrom?: Readonly<Record<string, ResumePoint>>;
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
 * Unknown channel is refused. That is the whole of the default-deny rule for
 * *privilege*, and it lives in one function so a future listener cannot
 * implement a second, laxer version of it by accident.
 *
 * **It is not the whole gate, and must not be used as one.** It answers a
 * question about privilege and says nothing about direction: every push is
 * graded `read`, so `isAuthorized('pty:data', 'read')` is `true` — correct, and
 * useless to a dispatcher deciding whether a *client* may send a frame naming
 * `pty:data`. Use {@link isClientFrameAllowed} on the receive path.
 */
export function isAuthorized(channel: string, granted: Authorization): boolean {
  const required = authorizationOf(channel);
  return required !== null && RANK[granted] >= RANK[required];
}

/**
 * Channels no remote caller may ever reach, whatever grade its device holds
 * (HIVE-148).
 *
 * `Authorization` grades what a call can do to host state **assuming the call
 * is genuine**. `skills:file:drop` breaks that assumption over a wire:
 * `parseSkillDropRequest` (`electron/shared/guards.ts`) accepts any string
 * that starts with `/`, and the only reason that is not a read-anywhere
 * primitive — copy `/etc/passwd` into a bundle, then read it back with
 * `skills:file:read` — is `electron/preload/index.ts`'s `pathToken`: a
 * guarantee that `sources` came from `webUtils.getPathForFile` on a `File` a
 * real browser drop produced. That guarantee is a property of *this
 * process's own preload*. A remote client speaks the frame format directly,
 * with nothing on the wire proving a `sources` entry ever passed through a
 * preload at all — an attacker-controlled client can simply put
 * `/etc/passwd` in the field, and this channel is already graded `execute`,
 * its ceiling, so no stricter grade closes the gap. No `Authorization` value
 * can express "this channel's safety proof does not survive the wire", so the
 * channel itself is refused for every remote caller instead, independent of
 * grant.
 *
 * Empty of anything else today, and additions to it should stay rare: this is
 * not where "a channel feels risky" gets recorded — `CHANNEL_AUTHORIZATION`'s
 * `execute` grade is. It is only for a channel whose *local* safety argument
 * relies on a fact the wire cannot carry, the way `skills:file:drop`'s does.
 * `remote-dispatch.ts`'s `refuse()` is what consults this before dispatching a
 * frame — recording the constraint here first, before that code existed, is
 * what makes it impossible to wire the remote path through this channel
 * without whoever does it reading why it is here.
 *
 * Keyed with a message beside each channel, the same shape {@link WINDOW_BOUND}
 * uses and for the same reason (HIVE-148 review): this used to be a bare
 * `Set`, folded into {@link isClientFrameAllowed} with nothing else to say
 * about *why* — so a client sending `skills:file:drop` correctly, as a `call`,
 * with every privilege it holds, was refused `wrong-frame-kind` and told
 * "skills:file:drop is not a call channel", which is false. That code means a
 * malformed frame and invites a client to retry with a different shape; no
 * shape fixes a policy refusal. {@link remoteRefusedReason} is what
 * `remote-dispatch.ts` now checks first, the same way it already checks
 * {@link windowBoundReason}, so this gets its own code and its own true
 * sentence instead of borrowing the direction check's.
 */
export const REMOTE_REFUSED = {
  [CH.skillsFileDrop]:
    'Dropping files onto a skill trusts that preload minted every source path from a real browser drop on this device — a guarantee a socket cannot carry, so this channel is refused for every remote caller rather than trusted on its word. Drag the files onto the skill from the machine you are sitting at instead.',
} as const satisfies Partial<Record<Channel, string>>;

/**
 * The channels {@link REMOTE_REFUSED} names, as a set — kept for
 * {@link isClientFrameAllowed}'s own membership check and for the tests that
 * assert a channel is, or is not, in it. Derived from the same object rather
 * than listed a second time, so the two cannot name a different set of
 * channels from each other.
 */
export const REMOTE_REFUSED_CHANNELS: ReadonlySet<Channel> = new Set(
  Object.keys(REMOTE_REFUSED) as Channel[],
);

/**
 * Why `channel` is refused for every remote caller, or `null` if it is not.
 *
 * The {@link windowBoundReason} of this constant: same shape, same job, same
 * reason a caller wants the sentence and not just the boolean.
 */
export function remoteRefusedReason(channel: string): string | null {
  return Object.hasOwn(REMOTE_REFUSED, channel)
    ? REMOTE_REFUSED[channel as keyof typeof REMOTE_REFUSED]
    : null;
}

/**
 * The gate a server's receive path actually wants: may a client send this frame,
 * naming this channel, holding this grant?
 *
 * Four ways to fail, and the middle two are the reason this function exists
 * rather than being left to each caller to remember:
 *
 * 1. The channel is not a channel — {@link frameKindOf} returns `null`.
 * 2. The frame kind does not match the channel's direction. A `call` may only
 *    name a `call` channel and a `notify` only a `notify` channel; a client may
 *    never send a frame naming one of the 22 server-to-client `event` channels.
 *    Privilege alone cannot catch this, because those 22 are graded `read` and
 *    `read` is the grant every attached device has.
 * 3. The channel is in {@link REMOTE_REFUSED_CHANNELS} — refused for every
 *    remote caller regardless of grant, because its local safety argument does
 *    not survive the wire.
 * 4. The grant does not reach what the channel costs.
 *
 * `FRAME_KIND` held the information needed for (2) from the first commit; the
 * gap was that nothing consulted it.
 */
export function isClientFrameAllowed(
  frame: 'call' | 'notify',
  channel: string,
  granted: Authorization,
): boolean {
  return (
    frameKindOf(channel) === frame &&
    !REMOTE_REFUSED_CHANNELS.has(channel as Channel) &&
    isAuthorized(channel, granted)
  );
}

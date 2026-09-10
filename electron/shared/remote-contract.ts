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
 * - `event` — server to client push. 25 channels, including `pty:data`, the
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
  [CH.configBrowseDirectory]: 'call',
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
  /*
    HIVE-145. Carried like the three `notifications:*` pushes beside it, and
    like them absent from `EVENT_CHANNELS` — the toast is raised by the
    receiving *main* process, not by a renderer.
  */
  [CH.notificationsToast]: 'event',
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
  [CH.ptySpawnTerminal]: 'call',
  [CH.sessionStatus]: 'event',
  [CH.sessionName]: 'event',
  [CH.sessionCleared]: 'event',
  [CH.sessionFinished]: 'event',
  [CH.sessionBranch]: 'event',
  [CH.sessionReady]: 'event',
  [CH.sessionTicketIntent]: 'event',
  [CH.sessionMetrics]: 'event',
  [CH.sessionForeground]: 'event',
  [CH.sessionTerminalEnded]: 'event',
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
  /*
    The caller learns which directories exist under the answering machine's
    home and nothing outlives the call, so `read` by this table's own
    definition. It is not `mutate`: nothing is written, and the path it hands
    back is only a suggestion `config:add-project` re-validates from scratch.
  */
  [CH.configBrowseDirectory]: 'read',
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
  [CH.notificationsToast]: 'read',
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
  [CH.ptySpawnTerminal]: 'execute',
  [CH.sessionStatus]: 'read',
  [CH.sessionName]: 'read',
  [CH.sessionCleared]: 'read',
  [CH.sessionFinished]: 'read',
  [CH.sessionBranch]: 'read',
  [CH.sessionReady]: 'read',
  [CH.sessionTicketIntent]: 'read',
  [CH.sessionMetrics]: 'read',
  [CH.sessionForeground]: 'read',
  [CH.sessionTerminalEnded]: 'read',
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
  [CH.uiForeground]: 'mutate',
  [CH.uiSessionName]: 'mutate',
} as const satisfies Record<Channel, Authorization>;

/**
 * Channels that cannot be answered for a socket, and the ticket that fixes each
 * (HIVE-143, widened by HIVE-144 Ruling 25).
 *
 * The membership test used to be narrower than the real one: "dereferences
 * the Electron event it is handed." That was true of every entry until this
 * one, and it is why `configReveal` slipped past this table for as long as it
 * did — `shell.showItemInFolder` never touches the event at all. The test
 * this table actually enforces, restated to cover both shapes: **a channel
 * whose effect lands on the machine that answers it, when the person who
 * asked is at the other one.** Four entries satisfy that through a
 * `BrowserWindow` a server does not have; `configReveal` satisfies it through
 * `shell` — a Finder window opened on a headless Mac mini, on a desktop
 * nobody is looking at, while the user who clicked "Reveal" sees nothing
 * happen on their own screen. Proxied as-is none of the five would throw:
 * `config:choose-directory` returns `null` and reads as a cancelled dialog,
 * and `config:reveal` returns `undefined` and reads as success — both a
 * silent failure rather than a loud one, which is worse.
 *
 * Refused by name instead, so a remote client gets a code it can act on and a
 * message naming the work.
 *
 * ## What HIVE-146 did, and why the table did not shrink by three
 *
 * It was written expecting to delete three entries. It deleted two.
 *
 * `theme:pick` and `theme:save` are gone outright, channels and all: a theme
 * file lives on the machine the user is sitting at, so the renderer reads and
 * writes it directly and there is nothing left for main to be asked.
 *
 * `config:choose-directory` **stays**, because nothing about it became
 * answerable. A server still has no window to parent a dialog to. What changed
 * is on the other side of the seam: the renderer now asks
 * `config:browse-directory` instead while attached, and only opens the native
 * dialog when it is local. So this entry is no longer a dead button's excuse —
 * it is the reason a channel that would silently return `null` is refused by
 * name if anything ever does call it from a socket.
 *
 * `skills:file:import` is the fourth of those and is **not** HIVE-146's, so
 * this table does not go away with it (HIVE-148). There is nothing to move to
 * a client-side picker: choosing files for a skill on the server would copy
 * the *server's* files rather than the user's, which is not a worse version
 * of the feature but a different and wrong one. `skills:file:drop` already
 * carries files from the machine the user is sitting at, so the refusal names
 * it.
 *
 * `configReveal` is the fifth, and the first refused for a reason other than
 * the event (HIVE-144, Ruling 25). While attached, Settings is already
 * showing the *server's* config (`ConfigSnapshot.attachedServer`,
 * `RemoteConfig`'s own doc comment: `config:get` is answered by the far end)
 * — so even a correct, non-silent local answer here would open a folder onto
 * a file that is not the one on screen. There is no server-side counterpart
 * to build the way HIVE-146 is building one for the dialogs; the file this
 * channel would reveal simply is not on the machine the user is sitting at.
 *
 * `pty:prompt` is deliberately absent, the one case among the event-binding
 * five that stays unrefused. It uses the event for a surface *lifetime*
 * rather than a window, and `watchReporter` already accepts anything with an
 * `.on`, so a socket satisfies it. Refusing it would silently revert
 * HIVE-135's nudge holding for every remote session.
 */
export const WINDOW_BOUND = {
  [CH.configChooseDirectory]:
    'Choosing a directory opens a dialog on the server, which has no window. Browse the server’s folders with config:browse-directory instead.',
  [CH.skillsFileImport]:
    'Adding files to a skill opens a dialog on the server, which has no window — and would copy the server’s files, not yours. Drag them onto the skill instead.',
  [CH.configReveal]:
    'Revealing the config file opens Finder on the server, which nobody is sitting at — and while attached, Settings is already showing the server’s config, not this machine’s.',
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
 * Channels answered by this process itself even while attached, never
 * forwarded over the socket (HIVE-144, Ruling 24).
 *
 * A channel belongs here when it **reads or changes this process's own
 * identity or attachment**, rather than the fleet it may be attached to.
 *
 * **That test is wider than the one this list shipped with, and Ruling 28
 * widened it for a defect a live test found rather than for tidiness.** The
 * original wording was "every field of its *payload* describes the running
 * process", which reads a channel as something that *returns* a fact and so
 * cannot classify a **command** at all. `CH.configSetRemote` is that command,
 * and it fell through: graded `mutate`, absent from `WINDOW_BOUND`, absent
 * from here, so an attached client's "detach" was forwarded down the socket
 * like any other write. The server parsed it, ran its *own*
 * `switchIpcMode('local')` — already local, so `{ ok: true }` — wrote its own
 * `config.json`, and handed back its own snapshot. The pane read
 * `switched.ok` and rendered success; nothing detached, and because the
 * client's own file still said `remote`, the next launch reattached. **A
 * client could enter remote mode and never leave it**, this run or any later
 * one (`tests/live/server-conformance.test.ts`, cases 21g/21h — two real
 * apps, which is the only place this was observable).
 *
 * Attachment is the field the widened test turns on, and it is not a
 * preference: *which machine this one is attached to* is a fact that cannot
 * live on the far end **by definition**, because the far end is the thing
 * being attached to. A server asked "are you attached?" answers about itself
 * and is not wrong, only irrelevant — the same plausible-but-wrong shape a
 * server's own Electron version has when it stands in for the client's.
 *
 * Four channels pass on this branch. `AppInfo` (`CH.appInfo`) and
 * `UpdateStatus` (`CH.updatesStatus`, `CH.updatesCheck`) *read* this process's
 * identity — its own Electron/Chrome/Node build, its own log path, its own
 * receiver and server-mode binds, whether it is itself attached, its own
 * installed version against its own update track. `CH.configSetRemote`
 * *changes* this process's attachment, which is the half the original wording
 * had no room for. See the sweep note on `CH.updatesStatus`'s own history for
 * the candidates this list still does *not* include and why (login
 * environment, command diagnostics, config file paths: all genuinely about
 * the fleet, because sessions run on whichever machine answers `pty:spawn`,
 * not on the machine reading its own `AppInfo`).
 *
 * A locally-answered channel is still **bound**, and its binding is still
 * recorded — `registerRemoteProxy` swaps what the handler does, never whether
 * one exists — so the binding counts Task 9 pins do not move when a channel
 * joins this list.
 *
 * This is the same problem `WINDOW_BOUND` solves, and it rests on the same
 * observation — proxying some channels wholesale is wrong — but it needs the
 * opposite remedy, which is why it is a second list rather than a second
 * entry format on that one. `WINDOW_BOUND` channels are **refused** locally,
 * with a reason, because only the near end holds the `BrowserWindow` a
 * dialog needs and the far end could never compute a real answer. This list's
 * channels are **answered** locally, with no error at all, because the near
 * end's answer is the only *true* one even though the far end could compute
 * *an* answer that would look plausible and be wrong — a server's own
 * Electron version standing in for the client's, a server's own exposure
 * standing in for the client's. `registerRemoteProxy` binds a channel here to
 * a local handler instead of `client.call`; it does not touch `WINDOW_BOUND`'s
 * refusal path at all.
 *
 * A future channel of this shape is added to this list, not special-cased in
 * a conditional — the loop in `registerRemoteProxy` reads this table, the
 * same way it reads `FRAME_KIND` and `WINDOW_BOUND`, so a channel added here
 * and forgotten in the loop is structurally impossible rather than merely
 * unlikely.
 *
 * **Three shapes now exist, not two — `CH.configReveal` is the channel that
 * proved it (HIVE-144, Ruling 25).** It fails *this* list's test (its payload
 * describes nothing) and it failed `WINDOW_BOUND`'s old, narrower test
 * ("dereferences the Electron event") too, which is how it slipped past both
 * for as long as it did. It belongs to `WINDOW_BOUND` under that table's
 * widened test instead — a `shell` call that opens Finder on the answering
 * machine is the same "wrong machine" defect this list closes for a payload,
 * just for an OS-level side effect instead. The question that tells the three
 * shapes apart: does the channel *return a fact* (proxy it, unless the fact
 * is about the process, then it belongs here) or does it *cause an effect
 * somewhere* (refuse it, in `WINDOW_BOUND`, if the effect lands on whichever
 * machine answers rather than the one the user is sitting at)?
 *
 * `CH.configSetRemote` is the case that shows those two questions are not
 * exhaustive, and where a third answer sits: it *causes an effect*, but the
 * effect belongs on the near end and the near end can perform it, so it is
 * neither proxied nor refused — it is **answered here**. `WINDOW_BOUND` would
 * have been the wrong remedy: refusing a detach leaves a client just as stuck
 * as forwarding it did.
 */
export const PROCESS_LOCAL: readonly Channel[] = [
  CH.appInfo,
  CH.updatesStatus,
  CH.updatesCheck,
  CH.configSetRemote,
];

/** Whether `channel` must be answered by this process itself, never proxied. */
export function isProcessLocal(channel: string): boolean {
  return (PROCESS_LOCAL as readonly string[]).includes(channel);
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
 * The six read channels a joining client needs to render the fleet at once
 * (HIVE-144) — what `buildAttachSnapshot` in `electron/main/ipc/index.ts`
 * fills {@link AttachAccepted.snapshot} with, keyed exactly as `CH` names
 * them so a client reads a key back with the same channel it would have
 * `call`ed for it.
 *
 * Shared rather than declared beside the builder, because both halves of the
 * link need to agree on what a snapshot contains and
 * `electron/remote-client/**` may not import `electron/remote-host/**` — the
 * builder itself stays in `ipc/index.ts`, which is the only place
 * `remoteRegistry` lives, but the *shape* of what it promises to fill has to
 * be somewhere both sides can read.
 */
export const SNAPSHOT_CHANNELS: readonly Channel[] = [
  // Last run's fleet, merged into the store by `hydrateSessions` (`src/main.tsx`).
  CH.sessionHistory,
  // The agent definitions pane's own snapshot, set by `loadAgents` (`src/lib/agents.ts`).
  CH.agentsList,
  // The ledger tail, merged by `hydrateLedger` (`use-ledger-sync.ts`).
  CH.ledgerList,
  // The inbox, merged by `hydrateNotifs` (`use-notification-stream.ts`).
  CH.notificationsList,
  // The PRs panel, merged by `hydratePrs` (`src/stores/hive-store.ts`).
  CH.githubPrs,
  // The workspace config, set by `loadProjectConfig` (`src/lib/project-config.ts`).
  CH.configGet,
];

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

/**
 * How long the server lets one `call` run before it answers a
 * {@link CALL_TIMEOUT_CODE} error frame instead of leaving the client's
 * correlation id to hang forever (HIVE-144).
 *
 * `dispatch.call` never rejects — every refusal and every thrown handler
 * already comes back as an `error` frame — but it can fail to *settle* at
 * all: `agents:run` awaits the memoised `mcp.start()`, and `slack:sign-in`
 * spawns a real `claude` turn and waits for it, so a handler stuck on either
 * one holds `electron/remote-host/listener.ts`'s `socketHandle` past a
 * detach that has already happened, with the client's own correlation id
 * outstanding and nothing on the wire to say so. This deadline does not
 * release that handle — the `.then`/`.catch` reaction still keeps
 * `socketHandle` alive for as long as `dispatch.call` takes to actually
 * settle, however late — it only makes sure the client is not left waiting:
 * an answer goes out on time, and the eventual real answer is discarded
 * rather than sent as a confusing second frame for the same `id`.
 *
 * Two minutes: comfortably longer than either of those genuinely slow paths
 * takes to succeed, so a real `agents:run` or `slack:sign-in` never trips it,
 * and short enough that a call which has not answered by then is a stuck
 * handler rather than a slow one — the difference the deadline exists to
 * draw.
 */
export const CALL_DEADLINE_MS = 120_000;

/**
 * How long a client waits for a `call` before giving up on it itself
 * (HIVE-144) — {@link CALL_DEADLINE_MS} plus margin for the round trip, not
 * the same number.
 *
 * It has to be strictly greater, and by more than jitter: a client that gave
 * up at or before the instant the server's own timer fires would abandon a
 * call the server is still going to answer — the race
 * `electron/remote-host/listener.ts`'s call site describes as the reason a
 * server-only deadline shipped unfixed until this constant had a partner. 15
 * seconds of margin is generous flight time for a loopback or tailnet round
 * trip and the time this process takes to notice its own timer fired, with
 * room to spare.
 */
export const CALL_GIVE_UP_MS = 135_000;

/** {@link ErrorFrame.code} for a call `listener.ts` gave up on at {@link CALL_DEADLINE_MS}. */
export const CALL_TIMEOUT_CODE = 'call-timeout';

/**
 * The most a **first** frame may weigh — the attach frame, and only that one.
 *
 * An attach frame — `kind`, `protocol`, `deviceId`, `token`, and an optional
 * `resumeFrom` map — is a few hundred bytes even with a realistic session
 * count in `resumeFrom`. Nothing an unauthenticated peer sends needs more than
 * this, and the same discipline the hook receiver applies per route
 * (`HOOK_MAX_BODY_BYTES` and its siblings in `electron/shared/hook-contract.ts`)
 * applies here, sized for what this one frame actually needs.
 *
 * **Enforced explicitly by the server, not by `maxPayload` (HIVE-143 review).**
 * It used to be handed to `WebSocketServer` as its `maxPayload`, which was a bug
 * rather than a shortcut: `ws` builds each connection's `Receiver` **once**,
 * with that value, and enforces it on every message for the life of the socket.
 * A handshake-shaped bound was therefore silently bounding every post-attach
 * frame too — a `fs:write-file`, `skills:write`, `agents:write`, `theme:save`,
 * `ledger:post`, `jira:add-comment` or pasted `pty:write` over 8 KiB never
 * reached `dispatch.call` at all, answered neither `result` nor `error`, left
 * the client's correlation id unresolved forever, and closed the connection
 * with 1009. `electron/remote-host/listener.ts` checks the first frame by hand,
 * where "first" is a fact that file knows and `ws` does not.
 *
 * **Here rather than in `listener.ts`, where it was defined through HIVE-143
 * (HIVE-144 review).** Unlike the unattached-phase bounds beside it there —
 * `ATTACH_HANDSHAKE_TIMEOUT_MS`, `MAX_UNATTACHED_SOCKETS` — this one is not the
 * server's problem alone: the client is the *only* thing that ever sends the
 * frame it bounds. `electron/remote-client/socket.ts` checks its own attach
 * frame against this before sending it, so a `resumeFrom` grown past the
 * ceiling fails with a message naming the session count rather than as the
 * server's `unauthorized` refusal, which a settings pane would present as a
 * credential problem. That mattering more over time is the point: HIVE-144's
 * later tasks put a snapshot behind this handshake, so the frame only grows.
 */
export const ATTACH_FRAME_MAX_BYTES = 8 * 1024;

/**
 * The most **any** frame on an attached socket may weigh — `ws`'s `maxPayload`
 * on both ends, and therefore the ceiling an attached device's `call` and
 * `notify` frames live under (HIVE-143 review).
 *
 * A bound, not an absence of one: `ws` defaults `maxPayload` to 100 MiB, and
 * even an authorized device must not be able to make the server buffer that
 * much per socket on demand. An attached client is trusted to *execute*
 * (`DEVICE_GRANT` in `remote-dispatch.ts`), which is not the same as being
 * trusted with that process's heap — a paired laptop with a bug in its send
 * path is the ordinary case here, not an attacker.
 *
 * 8 MiB, derived from the worst-case **encoded** payload rather than picked
 * (HIVE-143 review). The largest body any channel legitimately carries is a
 * file, and `MAX_FILE_BYTES` (`electron/shared/fs-contract.ts`) caps that at
 * 1,000,000 bytes — but what crosses this socket is not the file, it is the
 * file *inside a JSON string*, and JSON spends six characters — a \uXXXX escape — on
 * a single unprintable byte such as ESC. So the worst honest `fs:write-file` is
 * 1,000,000 × 6 = 6,000,000 bytes of escaped text plus the envelope, and an
 * earlier constant cited that six and then multiplied by four: an escape-dense
 * file the editor is willing to open encoded to ~6 MB, exceeded the 4 MiB
 * ceiling, and was refused by `ws` at 1009 — which does not refuse the *frame*,
 * it drops the socket and every in-flight correlation id on it. 8 MiB
 * (8,388,608) is the next power of two above 6,000,000 and leaves ~2.4 MB for
 * `path`, `channel`, `id` and the JSON structure around them. Everything else on
 * the wire is far smaller: `pty:write` carries a paste, `ledger:post` and
 * `jira:add-comment` carry prose, and `pty:data` only ever travels the other way
 * in `BATCH_FLUSH_BYTES`-sized batches.
 *
 * **Here rather than in `electron/remote-host/listener.ts`, where it was
 * defined through HIVE-143 (HIVE-144).** It is a property of the wire, not of
 * one end of it: the server hands it to `WebSocketServer` as `maxPayload`, and
 * `electron/remote-client/socket.ts` checks its own outgoing `call` and
 * `notify` frames against the same number before sending them, because a frame
 * over this ceiling is not answered with an error — `ws` closes the connection
 * at 1009 and takes every in-flight correlation id with it. Two copies of a
 * number whose whole job is that both ends agree on it would be the defect the
 * check exists to prevent, and `electron/remote-client/**` may not import
 * `electron/remote-host/**` in any case.
 *
 * The trade the server makes, stated because it is the cost of fixing the bug
 * above: an unauthenticated peer that clears the Origin/Host guard can make
 * `ws` buffer up to this before {@link ATTACH_FRAME_MAX_BYTES} refuses it,
 * where before that `maxPayload` bug it could buffer only 8 KiB. Per socket
 * that is bounded by `ATTACH_HANDSHAKE_TIMEOUT_MS` and by the socket being
 * closed the instant the oversized frame is inspected; in *aggregate* it is
 * bounded by `MAX_UNATTACHED_SOCKETS`. Both of those stay in `listener.ts`:
 * they bound the *unauthenticated* phase, which is the server's problem alone
 * and means nothing to a client.
 */
export const POST_ATTACH_FRAME_MAX_BYTES = 8 * 1024 * 1024;

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
 *    never send a frame naming one of the 24 server-to-client `event` channels.
 *    Privilege alone cannot catch this, because those 24 are graded `read` and
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

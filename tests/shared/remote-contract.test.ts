import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CH, EVENT_CHANNELS, type Channel } from '@shared/ipc-contract';
import {
  CALL_DEADLINE_MS,
  CALL_GIVE_UP_MS,
  CHANNEL_AUTHORIZATION,
  FRAME_KIND,
  LOCAL_ONLY_EVENTS,
  PROCESS_LOCAL,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_REFUSED_CHANNELS,
  SNAPSHOT_CHANNELS,
  WINDOW_BOUND,
  authorizationOf,
  frameKindOf,
  type FrameKind,
  isAuthorized,
  isClientFrameAllowed,
  isLocalOnlyEvent,
  isProcessLocal,
  remoteRefusedReason,
  windowBoundReason,
} from '@shared/remote-contract';

/**
 * The contract's two maps, checked against the thing they claim to describe
 * (HIVE-141).
 *
 * A map keyed by `CH` cannot be missing a channel — `satisfies Record<Channel,
 * …>` makes that a compile error, and the `@ts-expect-error` case below proves
 * it. What a type cannot prove is that the *values* are right: nothing stops
 * `pty:write` being classified `read`, or a push being called a `call`. So this
 * file reads `electron/preload/index.ts` and derives the answer, rather than
 * restating it and agreeing with itself.
 *
 * Reading a source file in a unit test is unusual and deliberate. The bridge is
 * the only place that knows which verb a channel actually uses; a fixture would
 * be a third copy to keep in sync, and it would go stale in exactly the silence
 * this test exists to break.
 */

const PRELOAD = readFileSync(
  join(process.cwd(), 'electron/preload/index.ts'),
  'utf8',
);

/** `CH` keys used with a given `ipcRenderer` verb in the bridge. */
const bridgeKeys = (pattern: RegExp): ReadonlySet<string> =>
  new Set([...PRELOAD.matchAll(pattern)].map((match) => match[1]));

const invoked = bridgeKeys(/ipcRenderer\.invoke\(\s*CH\.([A-Za-z0-9]+)/g);
const sent = bridgeKeys(/ipcRenderer\.send\(\s*CH\.([A-Za-z0-9]+)/g);
const subscribed = bridgeKeys(/subscribe<[^>]*>\(\s*CH\.([A-Za-z0-9]+)/g);

const entries = Object.entries(CH) as ReadonlyArray<[string, Channel]>;

/**
 * The channels the preload bridge cannot account for, because a **renderer
 * never sees them** (HIVE-145).
 *
 * `notifications:toast` is answered by the receiving *main* process: it raises
 * an Electron `Notification`, which is not something a renderer can do. So
 * there is no `invoke`, `send` or `subscribe` for it to be derived from, and
 * deriving its kind from the bridge would be deriving it from a file that is
 * correct to be silent about it.
 *
 * Listed rather than skipped, so adding a second main-only channel is a
 * deliberate edit here with a reason beside it, not a quiet hole in the one
 * test that checks these classifications against something other than
 * themselves. Each entry still has its kind asserted below.
 */
const MAIN_ONLY: ReadonlyMap<string, FrameKind> = new Map([
  ['notificationsToast', 'event'],
]);

describe('remote contract: coverage', () => {
  it('classifies every channel exactly once for frame kind', () => {
    expect(entries).toHaveLength(131);
    expect(Object.keys(FRAME_KIND).sort()).toEqual([...Object.values(CH)].sort());
  });

  it('classifies every channel exactly once for authorization', () => {
    expect(Object.keys(CHANNEL_AUTHORIZATION).sort()).toEqual(
      [...Object.values(CH)].sort(),
    );
  });

  it('has no channel classified by only one of the two maps', () => {
    expect(Object.keys(FRAME_KIND).sort()).toEqual(
      Object.keys(CHANNEL_AUTHORIZATION).sort(),
    );
  });
});

describe('remote contract: frame kinds match the preload bridge', () => {
  it.each(entries)('%s is classified as the bridge uses it', (key, channel) => {
    const mainOnly = MAIN_ONLY.get(key);
    if (mainOnly !== undefined) {
      expect(frameKindOf(channel)).toBe(mainOnly);
      // And it really is absent from the bridge, or this exemption is stale.
      expect(invoked.has(key) || sent.has(key) || subscribed.has(key)).toBe(false);
      return;
    }

    const expected = invoked.has(key)
      ? 'call'
      : sent.has(key)
        ? 'notify'
        : subscribed.has(key)
          ? 'event'
          : null;

    expect(expected, `${key} is not used by any verb in the bridge`).not.toBeNull();
    expect(frameKindOf(channel)).toBe(expected);
  });

  it('splits 99 call, 6 notify and 26 event', () => {
    const tally = { call: 0, notify: 0, event: 0 };
    for (const kind of Object.values(FRAME_KIND)) tally[kind] += 1;

    expect(tally).toEqual({ call: 99, notify: 6, event: 26 });
  });

  /**
   * The correction that reading the bridge forced.
   *
   * `EVENT_CHANNELS` is not the set of pushed channels — it is 20 of the 26.
   * `slack:socket-status` and the three `notifications:*` pushes are subscribed
   * without being listed there, `notifications:toast` is pushed to a main
   * process rather than a renderer at all, and `remote:link-status` (HIVE-150)
   * is raised by this process about itself and never carried. A remote client
   * that forwarded only `EVENT_CHANNELS` would show an empty inbox on a busy
   * server, so the asymmetry is asserted rather than left to be rediscovered.
   */
  it('covers EVENT_CHANNELS and the six pushes it omits', () => {
    for (const channel of EVENT_CHANNELS) expect(frameKindOf(channel)).toBe('event');

    const listed: ReadonlySet<string> = new Set(EVENT_CHANNELS);
    const pushed = Object.entries(FRAME_KIND)
      .filter(([, kind]) => kind === 'event')
      .map(([channel]) => channel);

    expect(pushed.filter((channel) => !listed.has(channel)).sort()).toEqual([
      'notifications:dismissed',
      'notifications:new',
      'notifications:read',
      'notifications:toast',
      /*
        HIVE-150, and it belongs on this list for a reason none of the others
        share: the rest are simply not carried in `EVENT_CHANNELS`, while this
        one must never cross a socket at all. `LOCAL_ONLY_EVENTS` is what
        enforces that, and the test below is what pins it.
      */
      'remote:link-status',
      'slack:socket-status',
    ]);
  });

  /**
   * A push about *this* window's own attachment, refused from a socket
   * (HIVE-150).
   *
   * The counterpart to `PROCESS_LOCAL` for pushes. A server that is itself
   * attached to a third machine would otherwise push its own reconnect state
   * down to every client, and each client's header chip would start describing
   * a socket it has no part in — the same defect `PROCESS_LOCAL` closed for
   * `app:info`.
   */
  it('keeps every local-only event graded as a push, and refuses it from the wire', () => {
    for (const channel of LOCAL_ONLY_EVENTS) {
      expect(frameKindOf(channel)).toBe('event');
      expect(isLocalOnlyEvent(channel)).toBe(true);
    }

    expect([...LOCAL_ONLY_EVENTS]).toEqual([CH.remoteLinkStatus]);
    // The channels a server may genuinely push are not caught by it.
    expect(isLocalOnlyEvent(CH.ptyData)).toBe(false);
    expect(isLocalOnlyEvent(CH.notificationsNew)).toBe(false);
  });
});

describe('remote contract: authorization', () => {
  /** The five the ticket pins, and the reason the table exists at all. */
  it.each([
    CH.ptySpawn,
    CH.ptyWrite,
    CH.fsWriteFile,
    CH.configSetRuntime,
    CH.agentsRun,
  ])('%s is execute', (channel) => {
    expect(authorizationOf(channel)).toBe('execute');
  });

  it('grades the 131 as 56 read, 43 mutate and 32 execute', () => {
    const tally = { read: 0, mutate: 0, execute: 0 };
    for (const authz of Object.values(CHANNEL_AUTHORIZATION)) tally[authz] += 1;

    expect(tally).toEqual({ read: 56, mutate: 43, execute: 32 });
  });

  /**
   * The regrades review forced, pinned so they cannot quietly slide back.
   *
   * Every one of these reads like a `read` and runs a process on the host. The
   * first pass graded them by the tone of the channel name; these assertions are
   * keyed to what the handler actually does, named in the comment beside each
   * entry in the table.
   */
  it.each([
    CH.configDiagnoseCommand,
    CH.configDiagnoseEnv,
    CH.githubPrs,
    CH.githubSearchPrs,
    CH.integrationsStatus,
    CH.integrationsLoginEnv,
    CH.slackStatus,
    CH.slackTest,
    CH.slackSignIn,
    CH.slackSignOut,
  ])('%s spawns a host process and is execute', (channel) => {
    expect(authorizationOf(channel)).toBe('execute');
  });

  /**
   * The escalation that made the diagnose grades a real hole rather than a
   * taxonomy quibble: `config:add-project` takes a path and is `mutate`, and
   * `config:diagnose-env` runs a login+interactive shell with `cwd` set to a
   * project's directory. Graded `read`, those two composed into arbitrary code
   * execution for a caller holding only `mutate`.
   */
  it('does not let a mutate grant reach a shell through the diagnostics', () => {
    expect(isAuthorized(CH.configAddProject, 'mutate')).toBe(true);
    expect(isAuthorized(CH.configDiagnoseEnv, 'mutate')).toBe(false);
    expect(isAuthorized(CH.configDiagnoseCommand, 'mutate')).toBe(false);
  });

  /** Two that read as passive and write. `session:pr` calls `history.record`. */
  it.each([CH.sessionPr, CH.sessionNote, CH.ptyAck, CH.ptyResize])(
    '%s changes host state and is at least mutate',
    (channel) => {
      expect(isAuthorized(channel, 'read')).toBe(false);
    },
  );

  /** `session:pr` is `session:note`'s sibling and must be graded like it. */
  it('grades session:pr exactly as session:note', () => {
    expect(authorizationOf(CH.sessionPr)).toBe(authorizationOf(CH.sessionNote));
  });

  /**
   * `pty:prompt` looks like a report of what the input box holds. It is also a
   * flush trigger that writes held ledger nudges into a running PTY, which is
   * the capability `ledger:post` is graded `execute` for.
   */
  it('grades pty:prompt like the other channels that deliver into a session', () => {
    expect(authorizationOf(CH.ptyPrompt)).toBe('execute');
    expect(authorizationOf(CH.ledgerPost)).toBe('execute');
  });

  /**
   * Stopping something is never `execute`, or the rule stops being re-derivable
   * from the grades. `pty:kill` and `agents:kill` must agree.
   */
  it('grades every kill as mutate, and every start as execute', () => {
    expect(authorizationOf(CH.ptyKill)).toBe('mutate');
    expect(authorizationOf(CH.agentsKill)).toBe('mutate');
    expect(authorizationOf(CH.agentsPause)).toBe('mutate');

    expect(authorizationOf(CH.ptySpawn)).toBe('execute');
    expect(authorizationOf(CH.ptyRestart)).toBe('execute');
    expect(authorizationOf(CH.agentsRun)).toBe('execute');
    expect(authorizationOf(CH.agentsResume)).toBe('execute');
  });

  it('classifies the server-mode channels (HIVE-142)', () => {
    expect(authorizationOf(CH.configSetServer)).toBe('mutate');
    expect(authorizationOf(CH.serverPair)).toBe('execute');
    expect(authorizationOf(CH.serverRevoke)).toBe('execute');
  });

  /** Network I/O is not process execution: these two really are what they say. */
  it('leaves the slack channels that start nothing alone', () => {
    expect(authorizationOf(CH.slackSocketState)).toBe('read');
    expect(authorizationOf(CH.slackSocketTest)).toBe('read');
  });

  it('grades every push as read — a client observes an event, never causes one', () => {
    for (const [channel, kind] of Object.entries(FRAME_KIND)) {
      if (kind !== 'event') continue;
      expect(authorizationOf(channel as Channel)).toBe('read');
    }
  });

  it('never grades a read-classified channel as one that writes to disk', () => {
    expect(authorizationOf(CH.fsReadFile)).toBe('read');
    expect(authorizationOf(CH.fsWriteFile)).not.toBe('read');
  });
});

describe('remote contract: default deny', () => {
  it.each([
    'pty:spwan',
    'config:set-everything',
    '',
    '__proto__',
    'constructor',
    'toString',
  ])('refuses the unlisted channel %j', (channel) => {
    expect(authorizationOf(channel)).toBeNull();
    expect(frameKindOf(channel)).toBeNull();
    expect(isAuthorized(channel, 'execute')).toBe(false);
  });

  /**
   * `__proto__` and `toString` are in that list for a reason: a lookup written
   * as `MAP[channel] ?? deny` would answer `[Function: toString]` for the last
   * one and inherit its way past the gate. `Object.hasOwn` is what makes the
   * deny real, and this asserts the property rather than the implementation.
   */
  it('does not inherit a classification from Object.prototype', () => {
    expect(Object.hasOwn(FRAME_KIND, 'toString')).toBe(false);
    expect(isAuthorized('toString', 'execute')).toBe(false);
  });
});

describe('remote contract: the authorization ladder', () => {
  it('lets execute cover mutate and read', () => {
    expect(isAuthorized(CH.configGet, 'execute')).toBe(true);
    expect(isAuthorized(CH.configSetJira, 'execute')).toBe(true);
    expect(isAuthorized(CH.ptySpawn, 'execute')).toBe(true);
  });

  it('lets mutate cover read but not execute', () => {
    expect(isAuthorized(CH.configGet, 'mutate')).toBe(true);
    expect(isAuthorized(CH.configSetJira, 'mutate')).toBe(true);
    expect(isAuthorized(CH.ptySpawn, 'mutate')).toBe(false);
  });

  it('lets read cover only read', () => {
    expect(isAuthorized(CH.configGet, 'read')).toBe(true);
    expect(isAuthorized(CH.configSetJira, 'read')).toBe(false);
    expect(isAuthorized(CH.fsWriteFile, 'read')).toBe(false);
  });
});

/**
 * The gap review found in the privilege check: it says nothing about direction.
 *
 * All 24 pushes are graded `read` and `read` is the grant every attached device
 * holds, so `isAuthorized` alone would let a client send a `call` naming
 * `pty:data`. `FRAME_KIND` always held what was needed to refuse that; nothing
 * consulted it.
 */
describe('remote contract: direction', () => {
  it('lets a client call a call channel and notify a notify channel', () => {
    expect(isClientFrameAllowed('call', CH.configGet, 'read')).toBe(true);
    expect(isClientFrameAllowed('notify', CH.ptyAck, 'mutate')).toBe(true);
  });

  it('refuses a client frame naming a server-to-client event channel', () => {
    expect(isAuthorized(CH.ptyData, 'read')).toBe(true);
    expect(isClientFrameAllowed('call', CH.ptyData, 'execute')).toBe(false);
    expect(isClientFrameAllowed('notify', CH.ptyData, 'execute')).toBe(false);
  });

  it('refuses every one of the 24 pushes as a client frame', () => {
    for (const [channel, kind] of Object.entries(FRAME_KIND)) {
      if (kind !== 'event') continue;
      expect(isClientFrameAllowed('call', channel, 'execute')).toBe(false);
      expect(isClientFrameAllowed('notify', channel, 'execute')).toBe(false);
    }
  });

  it('refuses a call that names a notify channel, and the reverse', () => {
    expect(isClientFrameAllowed('call', CH.ptyWrite, 'execute')).toBe(false);
    expect(isClientFrameAllowed('notify', CH.configGet, 'execute')).toBe(false);
  });

  it('still enforces privilege on a correctly-directed frame', () => {
    expect(isClientFrameAllowed('call', CH.ptySpawn, 'mutate')).toBe(false);
    expect(isClientFrameAllowed('call', CH.ptySpawn, 'execute')).toBe(true);
  });

  it('refuses an unlisted channel whatever the frame says', () => {
    expect(isClientFrameAllowed('call', 'toString', 'execute')).toBe(false);
    expect(isClientFrameAllowed('notify', 'pty:spwan', 'execute')).toBe(false);
  });
});

/**
 * `skills:file:drop` is graded `execute` — its ceiling — and is still refused
 * for every remote caller, because the grade assumes the call is genuine and
 * this channel's local safety argument (preload minted every `sources` entry)
 * is a fact the wire cannot carry (HIVE-148).
 */
describe('remote contract: channels refused over the wire regardless of grant', () => {
  it('refuses skills:file:drop even at execute, the grade it already holds', () => {
    expect(isClientFrameAllowed('call', CH.skillsFileDrop, 'execute')).toBe(false);
  });

  it('is graded execute by CHANNEL_AUTHORIZATION — the refusal is not a lower grade in disguise', () => {
    expect(authorizationOf(CH.skillsFileDrop)).toBe('execute');
    expect(isAuthorized(CH.skillsFileDrop, 'execute')).toBe(true);
  });

  it('does not refuse every skills bundle channel — only drop', () => {
    expect(REMOTE_REFUSED_CHANNELS.has(CH.skillsFileImport)).toBe(false);
    expect(isClientFrameAllowed('call', CH.skillsFileImport, 'execute')).toBe(true);
    expect(isClientFrameAllowed('call', CH.skillsFileWrite, 'execute')).toBe(true);
  });

  /**
   * The sentence, not only the boolean (HIVE-148 review). Before this,
   * `remote-dispatch.ts` had nothing to ask *why* `skills:file:drop` was
   * refused beyond `isClientFrameAllowed`'s own false, so the dispatcher
   * answered with the generic direction refusal's message — "is not a call
   * channel" — which is false: it is one, correctly directed, at the
   * highest grade a device holds. `remoteRefusedReason` is what gives the
   * true one, the same way `windowBoundReason` already does for its table.
   */
  it('gives a true reason for skills:file:drop, not the direction refusal\'s message', () => {
    const reason = remoteRefusedReason(CH.skillsFileDrop);

    expect(reason).not.toBeNull();
    expect(reason).not.toMatch(/is not a call channel/);
    expect(reason).toMatch(/preload/i);
  });

  it('answers null for a channel that is not remote-refused', () => {
    expect(remoteRefusedReason(CH.skillsFileImport)).toBeNull();
    expect(remoteRefusedReason(CH.skillsFileWrite)).toBeNull();
  });

  it('answers null for an unknown channel rather than throwing', () => {
    expect(remoteRefusedReason('not:a:channel')).toBeNull();
  });
});

describe('remote contract: the version handshake', () => {
  it('is a positive integer, so a mismatch is orderable', () => {
    expect(Number.isInteger(REMOTE_PROTOCOL_VERSION)).toBe(true);
    expect(REMOTE_PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it('is protocol 2, because a bare seq could not carry a generation (HIVE-144)', () => {
    expect(REMOTE_PROTOCOL_VERSION).toBe(2);
  });
});

describe('remote contract: the call deadline (HIVE-144)', () => {
  /**
   * `electron/remote-host/listener.ts`'s `dispatch.call` site names the
   * reason directly: the two numbers have to agree or the client gives up on
   * a call the server is still going to answer. A client whose own timeout
   * fires at or before the server's would abandon a call mid-flight instead
   * of waiting for the `CALL_TIMEOUT_CODE` error frame the server is already
   * about to send — the give-up point has to be strictly the later of the
   * two, not merely a different number.
   */
  it('gives the client strictly longer than the server\'s own deadline', () => {
    expect(CALL_GIVE_UP_MS).toBeGreaterThan(CALL_DEADLINE_MS);
  });
});

/**
 * `SNAPSHOT_CHANNELS` named literally, not read back off itself (HIVE-144
 * review). Every assertion in `tests/electron/remote-host/listener.test.ts`
 * and `tests/electron/main/ipc/remote-composition.test.ts` iterates this
 * array to build its own expectations, which makes membership self-certifying
 * there: commenting out `CH.githubPrs` at the source left `pnpm exec vitest
 * run tests/electron` fully green, because every one of those tests would
 * simply have iterated five channels instead of six and never noticed a sixth
 * was missing. This is the one test in the suite that names the six by hand,
 * so a channel silently dropped from the array — accidentally, or in a merge
 * conflict — has somewhere to be caught.
 */
describe('remote contract: the attach snapshot (HIVE-144)', () => {
  it('is exactly these six channels, in this order', () => {
    expect(SNAPSHOT_CHANNELS).toHaveLength(6);
    expect(SNAPSHOT_CHANNELS).toEqual([
      CH.sessionHistory,
      CH.agentsList,
      CH.ledgerList,
      CH.notificationsList,
      CH.githubPrs,
      CH.configGet,
    ]);
  });
});

describe('remote contract: an unclassified channel is a compile error', () => {
  it('rejects a map that omits a channel', () => {
    // @ts-expect-error — a Record<Channel, …> missing 113 of its 114 keys. This
    // line is the acceptance criterion: delete the directive and `pnpm
    // type-check` must fail, which is what proves the maps above cannot go
    // stale when `CH` grows.
    const partial: Record<Channel, 'read'> = { [CH.configGet]: 'read' };

    expect(partial[CH.configGet]).toBe('read');
  });
});

describe('WINDOW_BOUND', () => {
  it('names exactly the three refused channels', () => {
    expect(Object.keys(WINDOW_BOUND).sort()).toEqual(
      [
        CH.configChooseDirectory,
        CH.skillsFileImport,
        CH.configReveal,
      ].sort(),
    );
  });

  /**
   * `configReveal` (HIVE-144, Ruling 25) is the one entry that does not
   * dereference the Electron event — `shell.showItemInFolder` needs none —
   * which is exactly why it slipped past this table under its old, narrower
   * test. Proven here rather than merely asserted: `frameKindOf` still says
   * `'call'` for it (below, in `'only ever names a call channel'`), and
   * `remote-composition.test.ts`'s own event-dereference scan excludes it
   * explicitly, with the same reason stated on that side.
   */
  it('does not require configReveal to dereference the event, unlike its four siblings', () => {
    expect(WINDOW_BOUND[CH.configReveal]).toMatch(/Finder/);
    expect(WINDOW_BOUND[CH.configReveal]).toMatch(/server/);
  });

  it('tells a remote user what to do instead, for every entry', () => {
    /*
      This used to assert that three entries named HIVE-146, the ticket that
      would delete them. Two of those are gone — `theme:pick` and `theme:save`
      are not refused any more, they do not exist — and naming a closed ticket
      is worth nothing to whoever reads the refusal.

      What survives it is the property the ticket reference was standing in
      for: a refusal with no route forward is a dead end, and every entry here
      names a route. `config:choose-directory` names the channel that browses
      the server's disk, `skills:file:import` names the drop verb that carries
      the user's own files, and `config:reveal` explains that the config on
      screen is already the server's. That is checkable, and it stays true
      after the tickets are closed.
    */
    expect(WINDOW_BOUND[CH.configChooseDirectory]).toMatch(
      /config:browse-directory/,
    );
    expect(WINDOW_BOUND[CH.skillsFileImport]).toMatch(/drag/i);
    expect(WINDOW_BOUND[CH.configReveal]).toMatch(/already/i);
  });

  it('only ever names a call channel', () => {
    for (const channel of Object.keys(WINDOW_BOUND)) {
      expect(frameKindOf(channel)).toBe('call');
    }
  });

  it('does not name pty:prompt, which is adapted rather than refused', () => {
    expect(windowBoundReason(CH.ptyPrompt)).toBeNull();
  });

  it('returns null for a channel that is not window bound', () => {
    expect(windowBoundReason(CH.configGet)).toBeNull();
    expect(windowBoundReason('not:a:channel')).toBeNull();
  });

  it('returns the reason for one that is', () => {
    expect(windowBoundReason(CH.configChooseDirectory)).toMatch(
      /config:browse-directory/,
    );
  });
});

/**
 * `PROCESS_LOCAL` (HIVE-144, Ruling 24) — the opposite remedy from
 * `WINDOW_BOUND`, for the same underlying problem: a channel whose payload
 * is entirely about the running process, not the fleet, must not be
 * forwarded to whatever the far end happens to be. See `PROCESS_LOCAL`'s own
 * doc comment for the full test ("does every field describe the running
 * process?") and the sweep across every `'call'` channel that settled on
 * exactly these three — then on `config:set-remote` (Ruling 28), then on
 * `remote:pair` and `remote:forget` (HIVE-153), the two the wording already
 * admitted and nobody had applied it to.
 */
describe('PROCESS_LOCAL', () => {
  it('names exactly six channels', () => {
    expect([...PROCESS_LOCAL].sort()).toEqual(
      [
        CH.appInfo,
        CH.updatesStatus,
        CH.updatesCheck,
        CH.configSetRemote,
        CH.remotePair,
        CH.remoteForget,
      ].sort(),
    );
  });

  /*
    Named on its own, not merely counted (Ruling 28). `config:set-remote` is
    the one entry that is a *command* rather than a read, and it is the one a
    later sweep could most plausibly take back off this list on the grounds
    that a `mutate` channel "obviously" belongs on the wire. It does not: a
    client's detach forwarded to the server switches the server, writes the
    server's config, answers `{ ok: true }`, and leaves the client attached
    with its own file still saying `remote` — so it reattaches on the next
    launch and can never get out. Proved against two real apps in
    `tests/live/server-conformance.test.ts` (21g/21h).
  */
  it('answers config:set-remote locally, because attachment cannot live on the far end', () => {
    expect(isProcessLocal(CH.configSetRemote)).toBe(true);
  });

  /*
    Named on their own for the same reason, and against a sharper failure
    (HIVE-153). These two are `mutate` channels a sweep could just as
    plausibly hand back to the wire, and what forwarding them did was not
    subtle: a Forget click on an attached client ran on the server and cleared
    the *server's* credential, revoking the far machine's own pairing from the
    near machine's UI while the clicking user's credential stayed put.

    A client's device identity and the secret behind it are meaningless on the
    server, which minted them — that is why the far end can never answer these
    two, not merely why it should not.
  */
  it('answers remote:pair and remote:forget locally, because a credential is this machine\'s identity', () => {
    expect(isProcessLocal(CH.remotePair)).toBe(true);
    expect(isProcessLocal(CH.remoteForget)).toBe(true);
  });

  it('only ever names a call channel', () => {
    for (const channel of PROCESS_LOCAL) expect(frameKindOf(channel)).toBe('call');
  });

  /*
    Disjoint from `WINDOW_BOUND` by construction — the two lists answer a
    channel two different ways (a local answer vs. a local refusal), and a
    channel on both would leave `registerRemoteProxy` to pick one arbitrarily.
  */
  it('shares no channel with WINDOW_BOUND', () => {
    const windowBound = new Set(Object.keys(WINDOW_BOUND));
    for (const channel of PROCESS_LOCAL) expect(windowBound.has(channel)).toBe(false);
  });

  it('is true for each named channel and false for an ordinary fleet channel', () => {
    for (const channel of PROCESS_LOCAL) expect(isProcessLocal(channel)).toBe(true);
    expect(isProcessLocal(CH.configGet)).toBe(false);
    expect(isProcessLocal('not:a:channel')).toBe(false);
  });
});

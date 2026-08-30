// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTH_ENV_KEYS,
  DEFAULT_JIRA,
  DEFAULT_NOTIFICATIONS,
  type ConfigSnapshot,
} from '../../../../electron/shared/config-contract';
import type {
  HookAgentEvent,
  HookStatusEvent,
} from '../../../../electron/shared/hook-contract';
import { CH } from '../../../../electron/shared/ipc-contract';

import type { RunAsync } from '../../../../electron/main/integrations/github/run';
import type { PtyHostSupervisor } from '../../../../electron/main/pty-host/supervisor';
import {
  createSessions,
  type Sessions,
} from '../../../../electron/main/sessions';
import { MIN_INTERVAL_MS } from '../../../../electron/main/sessions/git';
import { createSessionHistory } from '../../../../electron/main/sessions/history';

/**
 * The sessions layer (story 096).
 *
 * `node-pty` never loads: the supervisor is a stub whose event streams the test
 * drives, so every rule below is asserted against spawn *arguments* and message
 * ordering rather than by starting processes. Terminal semantics get their own
 * runner under Electron's ABI (story 098).
 */

interface Sent {
  channel: string;
  payload: Record<string, unknown>;
}

let sent: Sent[];
let spawned: {
  sessionId: string;
  shell: string;
  args: string[];
  cwd: string;
  /** Absent for a command session, which has no authentication to decide. */
  stripEnv?: readonly string[];
}[];
let killed: string[];
let sessions: Sessions;
let supervisor: PtyHostSupervisor;
let emitData: (event: { sessionId: string; chunk: string }) => void;
let emitExit: (event: {
  sessionId: string;
  exitCode: number;
  signal?: number;
}) => void;
/** Story 102: a host-level failure, which is how a bad binary reports. */
let emitError: (event: { sessionId?: string; message: string }) => void;
let emitLost: (event: { sessionId: string }) => void;
let blocked: boolean;

const CONFIG: ConfigSnapshot = {
  configPath: '/home/dev/.hive/config.json',
  templateWritten: false,
  shell: '/bin/zsh',
  claudeCommand: 'claude',
  env: {},
  projects: [
    {
      id: 'nova-web',
      name: 'nova-web',
      path: '/repos/nova-web',
      icon: 'ph-folder',
      origin: 'local',
      status: 'ok',
      key: 'nw',
      isRepo: true,
    },
    {
      id: 'referral-api',
      name: 'referral-api',
      path: null,
      icon: 'ph-folder',
      origin: 'local',
      status: 'missing',
      key: 'ra',
      isRepo: false,
    },
  ],
  notifications: { ...DEFAULT_NOTIFICATIONS },
  jira: { ...DEFAULT_JIRA },
  subscriptionAuth: true,
  sessionMetrics: true,
  importLoginEnv: true,
  errors: [],
};

function fakeSupervisor(): PtyHostSupervisor {
  return {
    spawn: vi.fn(
      (request: {
        sessionId: string;
        shell: string;
        args: string[];
        cwd: string;
        stripEnv?: readonly string[];
      }) => {
        spawned.push(request);
      },
    ),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn((sessionId: string) => killed.push(sessionId)),
    pause: vi.fn(),
    resume: vi.fn(),
    onData: vi.fn((listener) => {
      emitData = listener;
      return () => {};
    }),
    onExit: vi.fn((listener) => {
      emitExit = listener;
      return () => {};
    }),
    onSpawned: vi.fn(() => () => {}),
    onError: vi.fn((listener) => {
      emitError = listener;
      return () => {};
    }),
    onSessionLost: vi.fn((listener) => {
      emitLost = listener;
      return () => {};
    }),
    shutdown: vi.fn(async () => {}),
    isRunning: vi.fn(() => true),
    isBlocked: vi.fn(() => blocked),
    sessionIds: vi.fn(() => []),
  } as unknown as PtyHostSupervisor;
}

const OPEN = { entityId: 'hero-refresh', projectId: 'nova-web', cols: 80, rows: 24 };

/** Pinned so the command line is a constant rather than a moving target. */
const TEST_UUID = '00000000-0000-4000-8000-000000000000';

/**
 * The bootstrap command line a plain spawn produces.
 *
 * **There is no `--name` on it, and that is load-bearing** (HIVE-108). HIVE-61
 * put the entity id there so the agent's prompt box and `/resume` entry agreed
 * with the rail; the flag also suppresses Claude Code's own titling outright, so
 * the price of that agreement was every context-derived name the app might have
 * had. A session now opens unnamed and titles itself.
 *
 * `--session-id` is pinned so the transcript path is deterministic. No
 * `--settings`, because this harness passes no hook runtime — which is itself
 * the "hooks unavailable" case, and it must still spawn.
 */
/**
 * The bootstrap line a plain spawn produces.
 *
 * The `unset` prefix is HIVE-79's: `stripEnv` sanitises the environment node-pty
 * is handed, but `claude` is typed into a **login shell**, which re-sources the
 * user's profile and re-exports anything they set there. Without this the whole
 * subscription-auth feature is a no-op for the population it exists for.
 */
const BOOT = `unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; claude --session-id ${TEST_UUID} && exit`;

/**
 * The same command line for a spawn that carries a task (HIVE-91).
 *
 * The task is a positional argument on `BOOT`, not a second thing written into
 * the pty after it — which is why there is a constant for it at all.
 */
const BOOT_WITH_TASK = `unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; claude --session-id ${TEST_UUID} 'fix the hero' && exit`;

/** How long after a stage's text its submitting `\r` follows (HIVE-63). */
const SUBMIT = 300;

/** The pty session id main minted for the current generation of an entity. */
const mintedFor = (entityId: string) =>
  spawned.filter((call) => call.sessionId.startsWith(entityId)).at(-1)!.sessionId;

/** Can the registry still address the newest generation it spawned? */
const registryReachable = () => {
  const latest = spawned.at(-1)!.sessionId;
  /**
   * Let the bootstrap finish first. Input written before it has run is held
   * deliberately (story 097) — otherwise a message routed to a session would be
   * executed by the bare login shell — so a probe sent into that window
   * measures the hold rather than the registry.
   */
  emitData({ sessionId: latest, chunk: '$ ' });
  vi.advanceTimersByTime(158 + SUBMIT);

  sessions.write('hero-refresh', 'probe');
  return vi.mocked(supervisor.write).mock.calls.some(
    (call) => call[0] === latest && call[1] === 'probe',
  );
};

/** Everything the renderer received on a channel. */
const on = (channel: string) => sent.filter((entry) => entry.channel === channel);

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  spawned = [];
  killed = [];
  blocked = false;
  supervisor = fakeSupervisor();
  sessions = createSessions({
    supervisor,
    send: (channel, payload) => sent.push({ channel, payload: payload as Record<string, unknown> }),
    config: () => CONFIG,
    /**
     * Pinned so the bootstrap command line is assertable (HIVE-61). A real
     * spawn generates a fresh uuid; what matters here is that one is passed,
     * and where.
     */
    newSessionUuid: () => TEST_UUID,
  });
});

afterEach(() => {
  sessions.dispose();
  vi.useRealTimers();
});

describe('what a session runs', () => {
  it('spawns a login shell in the resolved project directory', () => {
    sessions.open(OPEN);

    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.shell).toBe('/bin/zsh');
    /**
     * `-l` is not optional. It sources the user's full profile, which is what
     * puts `claude`, nvm-managed node and every shim on `PATH`. Without it the
     * failure is `claude: command not found` in an app whose entire purpose is
     * running `claude`.
     */
    expect(spawned[0]!.args).toEqual(['-l']);
    expect(spawned[0]!.cwd).toBe('/repos/nova-web');
  });

  it('writes the bootstrap as input after the shell speaks', () => {
    /**
     * Still input rather than `$SHELL -l -c claude`, and the `&& exit` does not
     * make those equivalent. `-c` exits the shell however `claude` ends, which
     * includes `command not found`; `&&` exits only on a clean one, so a
     * misconfigured `claudeCommand` still leaves a live shell with the error on
     * screen instead of a session that vanishes. See `sessionCommand`.
     */
    sessions.open(OPEN);
    const sessionId = mintedFor('hero-refresh');

    emitData({ sessionId, chunk: '$ ' });
    vi.advanceTimersByTime(8); // the batch flush
    vi.advanceTimersByTime(150); // the settling debounce

    vi.advanceTimersByTime(SUBMIT);
    expect(supervisor.write).toHaveBeenCalledWith(sessionId, BOOT);
    expect(supervisor.write).toHaveBeenLastCalledWith(sessionId, '\r');
  });

  /**
   * One settings file, asked for without a theme (HIVE-82).
   *
   * The theme used to travel from `localStorage` through the guard to a path on
   * a command line, and getting it wrong is what drew a user's submitted prompt
   * as a near-black bar across a light terminal. It no longer travels at all:
   * Claude is pinned to `dark-ansi`, whose colours are ANSI indices that xterm
   * resolves against the active palette at paint time.
   *
   * What this pins is that the caller stopped passing one. A `settingsPathFor`
   * still handed an argument would be a caller that thinks the file varies.
   */
  it('starts a session with the one settings file, asking for no theme', () => {
    let asked = 0;
    const themed = createSessions({
      supervisor,
      send: (channel, payload) =>
        sent.push({ channel, payload: payload as Record<string, unknown> }),
      config: () => CONFIG,
      newSessionUuid: () => TEST_UUID,
      hooks: {
        settingsPathFor: (...args: unknown[]) => {
          asked += 1;
          expect(args).toEqual([]);
          return '/userData/hive/claude-hooks.settings.json';
        },
        envFor: () => ({}),
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      } as unknown as Parameters<typeof createSessions>[0]['hooks'],
    });

    themed.open({ ...OPEN });
    const sessionId = mintedFor('hero-refresh');

    emitData({ sessionId, chunk: '$ ' });
    vi.advanceTimersByTime(8);
    vi.advanceTimersByTime(150);
    vi.advanceTimersByTime(SUBMIT);

    expect(asked).toBe(1);
    const written = vi
      .mocked(supervisor.write)
      .mock.calls.map(([, data]) => data)
      .join('');
    expect(written).toContain('claude-hooks.settings.json');
    expect(written).not.toContain('settings.light.json');
  });

  /**
   * The flag that used to suppress Claude Code's own titling (HIVE-108).
   *
   * Asserted on its own, and not merely implied by `BOOT`, because this is the
   * whole mechanism of the feature and it fails silently: a `--name` restored
   * here would not break a single other test, and the app would simply stop
   * inferring names again — the state it was in for its entire history before
   * this change, which nobody noticed because there was nothing to compare it
   * against.
   *
   * Measured cause, not inference: two arms of a real `claude` differing only in
   * this flag produced an `ai-title` and no `ai-title` respectively. The live
   * proof is `pnpm test:title`.
   */
  it('names nothing on an ordinary spawn, so the agent titles itself', () => {
    sessions.open(OPEN);
    const sessionId = mintedFor('hero-refresh');

    emitData({ sessionId, chunk: '$ ' });
    vi.advanceTimersByTime(8);
    vi.advanceTimersByTime(150);
    vi.advanceTimersByTime(SUBMIT);

    const line = vi.mocked(supervisor.write).mock.calls.at(0)?.[1] ?? '';
    expect(line).toContain('claude ');
    expect(line).not.toContain('--name');
  });

  it('delivers a spawn task as claude’s initial prompt, on the command line', () => {
    /**
     * One stage, not two (HIVE-91). Story 097 wrote the task as a *second*
     * stage once the TUI's output had settled, which meant a `claude` that
     * failed to start handed the user's instruction to the login shell to run
     * as a command. It is now an argument, so it cannot exist as pty input on
     * its own.
     */
    sessions.open({ ...OPEN, task: 'fix the hero' });
    const sessionId = mintedFor('hero-refresh');

    emitData({ sessionId, chunk: '$ ' });
    vi.advanceTimersByTime(8);
    vi.advanceTimersByTime(150);
    expect(supervisor.write).toHaveBeenLastCalledWith(sessionId, BOOT_WITH_TASK);

    vi.advanceTimersByTime(SUBMIT);
    expect(supervisor.write).toHaveBeenLastCalledWith(sessionId, '\r');

    /**
     * The TUI paints — the signal the removed second stage waited for. Nothing
     * further may be written, however long we wait.
     */
    emitData({ sessionId, chunk: '╭─ claude ─╮' });
    vi.advanceTimersByTime(6_000);

    // The whole exchange, in order: one command, one carriage return.
    expect(vi.mocked(supervisor.write).mock.calls.map((call) => call[1]).join('')).toBe(
      `${BOOT_WITH_TASK}\r`,
    );
  });

  it('never writes the task as a line of its own', () => {
    /**
     * The reported defect, pinned at the layer that assembles the command. A
     * bare `fix the hero` reaching the pty is a task the shell will run if
     * `claude` is not there to read it.
     */
    sessions.open({ ...OPEN, task: 'fix the hero' });
    const sessionId = mintedFor('hero-refresh');

    emitData({ sessionId, chunk: '$ ' });
    vi.advanceTimersByTime(158 + SUBMIT);
    emitData({ sessionId, chunk: 'zsh: command not found: claude' });
    vi.advanceTimersByTime(6_000);

    expect(
      vi.mocked(supervisor.write).mock.calls.filter(
        (call) => call[1] === 'fix the hero',
      ),
    ).toHaveLength(0);
  });

  it('does not deliver the task again when a surface reattaches', () => {
    sessions.open({ ...OPEN, task: 'fix the hero' });
    const sessionId = mintedFor('hero-refresh');

    emitData({ sessionId, chunk: '$ ' });
    vi.advanceTimersByTime(158 + SUBMIT);
    emitData({ sessionId, chunk: 'ready' });
    vi.advanceTimersByTime(158 + SUBMIT);

    // Attach-never-respawn: every tab switch re-subscribes a transport.
    sessions.open({ ...OPEN, task: 'fix the hero' });
    vi.advanceTimersByTime(6_000);

    expect(
      vi.mocked(supervisor.write).mock.calls.filter(
        (call) => call[1] === BOOT_WITH_TASK,
      ),
    ).toHaveLength(1);
  });

  it('holds input written before the bootstrap has finished', () => {
    /**
     * Until the bootstrap has run, the pty is a bare login shell. A message
     * routed there (story 097) would be executed by the *shell* as a command
     * line instead of reaching the agent — the user sees `command not found`
     * where they expected an answer. The renderer cannot know the difference:
     * it can see that a process exists, not what is running inside it.
     */
    sessions.open(OPEN);
    const sessionId = mintedFor('hero-refresh');

    sessions.write('hero-refresh', 'y\r');
    expect(vi.mocked(supervisor.write).mock.calls).toHaveLength(0);

    emitData({ sessionId, chunk: '$ ' });
    vi.advanceTimersByTime(8);
    vi.advanceTimersByTime(150);
    vi.advanceTimersByTime(SUBMIT);

    // The bootstrap first, then the held input — in that order.
    expect(vi.mocked(supervisor.write).mock.calls).toEqual([
      [sessionId, BOOT],
      [sessionId, '\r'],
      [sessionId, 'y\r'],
    ]);
  });

  it('releases held input in the order it was written', () => {
    sessions.open(OPEN);
    const sessionId = mintedFor('hero-refresh');

    sessions.write('hero-refresh', 'first\r');
    sessions.write('hero-refresh', 'second\r');

    emitData({ sessionId, chunk: '$ ' });
    vi.advanceTimersByTime(158 + SUBMIT);

    vi.advanceTimersByTime(SUBMIT);

    /**
     * The held input follows the bootstrap's **carriage return**, not merely
     * its text (HIVE-63). Releasing it between the two would append the user's
     * keystrokes to the command line itself and the session would never start.
     */
    expect(vi.mocked(supervisor.write).mock.calls.map((call) => call[1])).toEqual([
      BOOT,
      '\r',
      'first\r',
      'second\r',
    ]);
  });

  it('delivers input directly once the bootstrap is done', () => {
    sessions.open(OPEN);
    const sessionId = mintedFor('hero-refresh');
    emitData({ sessionId, chunk: '$ ' });
    vi.advanceTimersByTime(158 + SUBMIT);

    sessions.write('hero-refresh', 'later\r');

    expect(vi.mocked(supervisor.write).mock.calls.at(-1)).toEqual([
      sessionId,
      'later\r',
    ]);
  });

  it('drops held input when the session dies before the bootstrap runs', () => {
    sessions.open(OPEN);
    const sessionId = mintedFor('hero-refresh');

    sessions.write('hero-refresh', 'never\r');
    emitExit({ sessionId, exitCode: 0 });
    vi.advanceTimersByTime(6_000);

    expect(
      vi.mocked(supervisor.write).mock.calls.some((call) => call[1] === 'never\r'),
    ).toBe(false);
  });

  it('writes the bootstrap exactly once', () => {
    sessions.open(OPEN);
    const sessionId = mintedFor('hero-refresh');

    for (let i = 0; i < 5; i += 1) {
      emitData({ sessionId, chunk: `chunk ${i}` });
      vi.advanceTimersByTime(200);
    }

    // Two writes, one stage: the command text and the `\r` that submits it.
    expect(vi.mocked(supervisor.write).mock.calls).toHaveLength(2);
  });
});

describe('lifecycle', () => {
  it('attaches to a live session instead of respawning it', () => {
    /**
     * The invariant that makes the product work. The user navigates between
     * sessions constantly and every navigation re-subscribes a transport; a
     * respawn on any of them would discard a running agent's context.
     */
    sessions.open(OPEN);
    sessions.open(OPEN);
    sessions.open(OPEN);

    expect(spawned).toHaveLength(1);
  });

  it('kills without clearing the transcript', () => {
    sessions.open(OPEN);
    const sessionId = mintedFor('hero-refresh');

    sessions.kill('hero-refresh');

    expect(killed).toEqual([sessionId]);
  });

  it('restarts as an ordering: kill, wait for the exit, then spawn', async () => {
    /**
     * Asserted as an ordering rather than a set. Spawning before the old
     * process is reaped means two `claude` instances in one repository writing
     * the same files.
     */
    sessions.open(OPEN);
    const first = mintedFor('hero-refresh');

    const restarted = sessions.restart(OPEN);
    await Promise.resolve();

    // Killed, and *not* yet respawned.
    expect(killed).toEqual([first]);
    expect(spawned).toHaveLength(1);

    emitExit({ sessionId: first, exitCode: 0 });
    vi.advanceTimersByTime(8);
    await restarted;

    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.sessionId).not.toBe(first);
  });

  it('does not replay the spawn task on restart', async () => {
    /**
     * A restart discards a running agent's context on purpose. Re-delivering
     * an instruction the previous generation may already have acted on — files
     * edited, a PR opened — would make "start again" mean "do it twice".
     */
    sessions.open(OPEN);
    const first = mintedFor('hero-refresh');

    const restarted = sessions.restart({ ...OPEN, task: 'fix the hero' });
    await Promise.resolve();
    emitExit({ sessionId: first, exitCode: 0 });
    vi.advanceTimersByTime(8);
    await restarted;

    const second = spawned[1]!.sessionId;
    emitData({ sessionId: second, chunk: '$ ' });
    vi.advanceTimersByTime(158 + SUBMIT);
    emitData({ sessionId: second, chunk: 'ready' });
    vi.advanceTimersByTime(6_000);

    expect(vi.mocked(supervisor.write).mock.calls).not.toContainEqual([
      second,
      'fix the hero\r',
    ]);
  });

  it('drops output from the generation that was restarted away', async () => {
    /**
     * The reason session ids are minted at all. The old process's last bytes
     * can still be in flight when the new one starts; delivered, they would put
     * the tail of the old conversation into the terminal the user restarted to
     * get a clean one.
     */
    sessions.open(OPEN);
    const stale = mintedFor('hero-refresh');

    const restarted = sessions.restart(OPEN);
    await Promise.resolve();
    emitExit({ sessionId: stale, exitCode: 0 });
    vi.advanceTimersByTime(8);
    await restarted;

    const before = on(CH.ptyData).length;
    emitData({ sessionId: stale, chunk: 'from the old process' });
    vi.advanceTimersByTime(8);

    expect(on(CH.ptyData)).toHaveLength(before);
  });

  it('restarts a session whose process already exited', async () => {
    sessions.open(OPEN);
    const first = mintedFor('hero-refresh');
    emitExit({ sessionId: first, exitCode: 0 });
    vi.advanceTimersByTime(8);

    await sessions.restart(OPEN);

    expect(spawned).toHaveLength(2);
  });
});

describe('identity: the renderer only ever sees entity ids', () => {
  it('translates output back to the entity id', () => {
    sessions.open(OPEN);
    const sessionId = mintedFor('hero-refresh');
    expect(sessionId).not.toBe('hero-refresh');

    emitData({ sessionId, chunk: 'hello' });
    vi.advanceTimersByTime(8);

    expect(on(CH.ptyData).at(-1)!.payload.sessionId).toBe('hero-refresh');
  });

  it('translates exit back to the entity id', () => {
    sessions.open(OPEN);
    emitExit({ sessionId: mintedFor('hero-refresh'), exitCode: 3 });
    vi.advanceTimersByTime(8);

    expect(on(CH.ptyExit).at(-1)!.payload).toMatchObject({
      sessionId: 'hero-refresh',
      exitCode: 3,
    });
  });

  it('accepts entity ids on the way in', () => {
    sessions.open(OPEN);
    const sessionId = mintedFor('hero-refresh');

    // Past the bootstrap first: input written before it has run is held on
    // purpose (story 097). The translation is the subject here, not the timing.
    emitData({ sessionId, chunk: '$ ' });
    vi.advanceTimersByTime(158 + SUBMIT);

    sessions.write('hero-refresh', 'ls\n');
    sessions.resize('hero-refresh', 120, 40);

    expect(supervisor.write).toHaveBeenCalledWith(sessionId, 'ls\n');
    expect(supervisor.resize).toHaveBeenCalledWith(sessionId, 120, 40);
  });

  it('ignores verbs for an entity with no session', () => {
    expect(() => sessions.write('ghost', 'x')).not.toThrow();
    expect(() => sessions.resize('ghost', 80, 24)).not.toThrow();
    expect(() => sessions.kill('ghost')).not.toThrow();
    expect(supervisor.write).not.toHaveBeenCalled();
  });
});

/**
 * A sessions instance whose hook receiver the test drives directly (HIVE-83).
 *
 * Built the same way the `hooked` instances further down build theirs —
 * `hooks.start` captured rather than really started — but hoisted here because
 * the tracker tests need both `onEvent` and `onCleared` out of that same
 * capture, and reading status back by entity is exactly what `on()` already
 * does for the suite's default instance.
 */
function harness(onIdle?: (entityId: string) => void): {
  hook: (
    event: { entityId: string; event: HookStatusEvent['event'] } & Partial<
      Omit<HookStatusEvent, 'entityId' | 'event' | 'status'>
    >,
  ) => void;
  cleared: (entityId: string) => void;
  lastStatus: (entityId: string) => unknown;
  lastEvent: (entityId: string) => Record<string, unknown>;
  /** The instance itself, for the queries that are not events (HIVE-113). */
  sessions: Sessions;
} {
  let onEvent: ((event: HookStatusEvent) => void) | undefined;
  let onCleared: ((entityId: string) => void) | undefined;
  const localSent: Sent[] = [];

  const instance = createSessions({
    supervisor,
    send: (channel, payload) =>
      localSent.push({ channel, payload: payload as Record<string, unknown> }),
    config: () => CONFIG,
    newSessionUuid: () => TEST_UUID,
    ...(onIdle === undefined ? {} : { onIdle }),
    hooks: {
      settingsPathFor: () => undefined,
      envFor: () => ({}),
      start: (opts: {
        onEvent: (event: HookStatusEvent) => void;
        onCleared: (entityId: string) => void;
      }) => {
        onEvent = opts.onEvent;
        onCleared = opts.onCleared;
        return Promise.resolve();
      },
      stop: () => Promise.resolve(),
    } as unknown as Parameters<typeof createSessions>[0]['hooks'],
  });

  const statusFor = (entityId: string) =>
    localSent
      .filter(
        (entry) => entry.channel === CH.sessionStatus && entry.payload.entityId === entityId,
      )
      .at(-1)!.payload;

  return {
    // `status` is a required field on the wire contract but unread by
    // `onEvent` — the tracker derives it — so a fixed fallback here is
    // never observed downstream.
    hook: (event) => onEvent!({ status: 'working', ...event } as HookStatusEvent),
    cleared: (entityId) => onCleared!(entityId),
    lastStatus: (entityId) => statusFor(entityId).status,
    lastEvent: (entityId) => statusFor(entityId),
    sessions: instance,
  };
}

describe('status', () => {
  it('reports working, then idle, then terminated', () => {
    sessions.open(OPEN);
    const sessionId = mintedFor('hero-refresh');

    emitData({ sessionId, chunk: 'building' });
    vi.advanceTimersByTime(8);
    expect(on(CH.sessionStatus).at(-1)!.payload).toEqual({
      entityId: 'hero-refresh',
      status: 'working',
    });

    vi.advanceTimersByTime(2_000);
    expect(on(CH.sessionStatus).at(-1)!.payload.status).toBe('idle');

    emitExit({ sessionId, exitCode: 0 });
    vi.advanceTimersByTime(8);
    expect(on(CH.sessionStatus).at(-1)!.payload.status).toBe('terminated');
  });

  it('never sends waiting', () => {
    // The guard against someone adding a heuristic later. A pty cannot tell a
    // TUI that asked a question from one that is thinking.
    sessions.open(OPEN);
    const sessionId = mintedFor('hero-refresh');
    emitData({ sessionId, chunk: 'anything?' });
    vi.advanceTimersByTime(10_000);
    emitExit({ sessionId, exitCode: 0 });
    vi.advanceTimersByTime(8);

    expect(
      on(CH.sessionStatus).some((entry) => entry.payload.status === 'waiting'),
    ).toBe(false);
  });

  it('addresses status by entity id, never by session id', () => {
    sessions.open(OPEN);
    emitData({ sessionId: mintedFor('hero-refresh'), chunk: 'x' });
    vi.advanceTimersByTime(8);

    expect(on(CH.sessionStatus).at(-1)!.payload.entityId).toBe('hero-refresh');
  });

  /**
   * HIVE-81: `idle_prompt` reports `idle`, not `waiting` (`NOTIFICATION_TYPE_STATUS`
   * in `hook-contract.ts`). This layer does not compute that mapping — the
   * receiver does — but it must pass whatever the receiver decided straight
   * through rather than reinterpreting it.
   */
  it('reports idle, not waiting, for an idle_prompt notification', () => {
    let onEvent: ((event: HookStatusEvent) => void) | undefined;
    const hooked = createSessions({
      supervisor,
      send: (channel, payload) =>
        sent.push({ channel, payload: payload as Record<string, unknown> }),
      config: () => CONFIG,
      newSessionUuid: () => TEST_UUID,
      hooks: {
        settingsPathFor: () => undefined,
        envFor: () => ({}),
        start: (opts: { onEvent: (event: HookStatusEvent) => void }) => {
          onEvent = opts.onEvent;
          return Promise.resolve();
        },
        stop: () => Promise.resolve(),
      } as unknown as Parameters<typeof createSessions>[0]['hooks'],
    });

    // Drive the hook receiver's onEvent with what it reports for an idle
    // prompt, and assert the published SessionStatusEvent carries status
    // 'idle' rather than reinterpreting it as 'waiting'.
    onEvent!({
      entityId: 'hero-refresh',
      status: 'idle',
      event: 'Notification',
      notificationType: 'idle_prompt',
    });

    expect(sent.at(-1)).toEqual({
      channel: CH.sessionStatus,
      payload: {
        entityId: 'hero-refresh',
        status: 'idle',
        event: 'Notification',
        notificationType: 'idle_prompt',
      },
    });

    hooked.dispose();
  });

  /**
   * `PostToolUse` is the first **per-tool-call** hook this app subscribes
   * (HIVE-81 review, finding 14).
   *
   * `onEvent` reads a branch for any event carrying a `cwd`, so a `git`
   * spawn is now reachable once per tool call — and Claude routinely runs
   * tools in parallel batches. The only thing between that and a spawn storm
   * is the reader's own floor, so this pins the composition rather than
   * trusting `git.ts`'s unit tests to be wired up the way they are read.
   *
   * Two properties, both of which have to hold:
   *
   * - Events arriving **together** share one in-flight read, so a batch of
   *   eight parallel `PostToolUse`s is one `git rev-parse`.
   * - Events arriving **after** it settles but inside {@link MIN_INTERVAL_MS}
   *   are served from cache, so a fast serial batch is also one spawn.
   *
   * `PostToolUse` deliberately does not pass `fresh` — only `Stop` does, and
   * `Stop` fires once per turn.
   */
  it('spawns git once for a parallel batch of PostToolUse events', async () => {
    let onEvent: ((event: HookStatusEvent) => void) | undefined;
    const run = vi.fn<RunAsync>().mockResolvedValue({
      code: 0,
      stdout: 'feat/x\n',
      stderr: '',
      timedOut: false,
    });
    const clock = { t: 0 };

    const hooked = createSessions({
      supervisor,
      send: (channel, payload) =>
        sent.push({ channel, payload: payload as Record<string, unknown> }),
      config: () => CONFIG,
      newSessionUuid: () => TEST_UUID,
      branchReader: {
        run,
        gitPath: () => '/usr/bin/git',
        now: () => clock.t,
      },
      hooks: {
        settingsPathFor: () => undefined,
        envFor: () => ({}),
        start: (opts: { onEvent: (event: HookStatusEvent) => void }) => {
          onEvent = opts.onEvent;
          return Promise.resolve();
        },
        stop: () => Promise.resolve(),
      } as unknown as Parameters<typeof createSessions>[0]['hooks'],
    });

    /** Let the reader's promise chain settle without leaving fake timers. */
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    };

    const toolFinished = () =>
      onEvent!({
        entityId: 'hero-refresh',
        status: 'working',
        event: 'PostToolUse',
        cwd: '/home/dev/repos/hero-refresh',
      } as HookStatusEvent);

    // Eight tools in one batch, all reporting within the same tick.
    for (let i = 0; i < 8; i += 1) toolFinished();
    await flush();

    expect(run).toHaveBeenCalledTimes(1);

    // Another eight, a second later — still inside the two-second floor.
    clock.t = MIN_INTERVAL_MS - 1;
    for (let i = 0; i < 8; i += 1) toolFinished();
    await flush();

    expect(run).toHaveBeenCalledTimes(1);

    // Past the floor, one more read — the ceiling is one spawn per directory
    // per interval, whatever the tool-call rate above it.
    clock.t = MIN_INTERVAL_MS;
    toolFinished();
    await flush();

    expect(run).toHaveBeenCalledTimes(2);

    hooked.dispose();
  });

  /**
   * The branch is the second ticket signal.
   *
   * A prompt names the ticket once, and only if the user phrased it a way the
   * scanner recognises. The branch goes on saying it for as long as the work
   * lasts, which is what covers a session resumed onto `feat/hive-111-ledger`
   * days later having never said the key here at all.
   *
   * The emit sits inside `publishBranch`, **after** its change check — so a
   * candidate goes out once per distinct branch rather than once per hook
   * event. That placement is the only thing between this and a Jira read on
   * every tool call the agent makes, so it is pinned rather than assumed.
   */
  const branchHarness = (stdout: string) => {
    let onEvent: ((event: HookStatusEvent) => void) | undefined;
    let onCleared: ((entityId: string) => void) | undefined;
    const clock = { t: 0 };
    const run = vi.fn<RunAsync>().mockResolvedValue({
      code: 0,
      stdout,
      stderr: '',
      timedOut: false,
    });

    const hooked = createSessions({
      supervisor,
      send: (channel, payload) =>
        sent.push({ channel, payload: payload as Record<string, unknown> }),
      config: () => CONFIG,
      newSessionUuid: () => TEST_UUID,
      branchReader: { run, gitPath: () => '/usr/bin/git', now: () => clock.t },
      hooks: {
        settingsPathFor: () => undefined,
        envFor: () => ({}),
        start: (opts: {
          onEvent: (event: HookStatusEvent) => void;
          onCleared: (entityId: string) => void;
        }) => {
          onEvent = opts.onEvent;
          onCleared = opts.onCleared;
          return Promise.resolve();
        },
        stop: () => Promise.resolve(),
      } as unknown as Parameters<typeof createSessions>[0]['hooks'],
    });

    /*
      Opened, not merely created. `publishBranch` checks the registry after its
      await and returns for a row that is gone — so an unopened session reads a
      branch and then silently publishes nothing, which would make every
      assertion below pass for the wrong reason.
    */
    hooked.open(OPEN);

    const flush = async (): Promise<void> => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    };

    const turnEnded = () =>
      onEvent!({
        entityId: 'hero-refresh',
        status: 'idle',
        event: 'Stop',
        cwd: '/home/dev/repos/hero-refresh',
      } as HookStatusEvent);

    const cleared = () => onCleared!('hero-refresh');

    const all = () =>
      sent
        .filter((entry) => entry.channel === CH.sessionTicketIntent)
        .map((entry) => entry.payload);

    /*
      Opening the session reads a branch of its own, in the project's directory
      rather than the one the hook names — a different cwd, so a legitimately
      separate publish. `mark` draws the line under it so each test asserts on
      what its *own* action produced instead of counting from zero and quietly
      depending on how many reads `open` happens to do.
    */
    let baseline = 0;
    const mark = () => {
      baseline = all().length;
    };
    const intents = () => all().slice(baseline);

    return { hooked, flush, turnEnded, cleared, intents, mark, clock };
  };

  it('publishes a ticket candidate read from the branch', async () => {
    // The shape this app's own worktrees produce, lowercase as git leaves it.
    const h = branchHarness('worktree-feat+hive-111-ledger\n');
    await h.flush();
    h.mark();

    h.turnEnded();
    await h.flush();

    expect(h.intents()).toEqual([
      { entityId: 'hero-refresh', keys: ['HIVE-111'], source: 'branch' },
    ]);

    h.hooked.dispose();
  });

  it('offers every candidate a branch carries, best-first', async () => {
    /*
      The leftmost key-shaped token is routinely not the issue. Sending only it
      let a node major permanently shadow the real ticket — Jira rejected the
      shadow, and the branch signal associated nothing.
    */
    const h = branchHarness('chore/bump-node-22-hive-118\n');
    await h.flush();
    h.mark();

    h.turnEnded();
    await h.flush();

    expect(h.intents()).toEqual([
      {
        entityId: 'hero-refresh',
        keys: ['NODE-22', 'HIVE-118'],
        source: 'branch',
      },
    ]);

    h.hooked.dispose();
  });

  it('publishes nothing for a branch carrying no key', async () => {
    /*
      The generic session, and the case that must stay quiet: a terminal opened
      to look around, standing on `main`. No candidate, so no Jira read on the
      other side, so no association — an empty answer is the right one here, and
      the common one.
    */
    const h = branchHarness('main\n');
    await h.flush();
    h.mark();

    h.turnEnded();
    await h.flush();

    expect(h.intents()).toEqual([]);

    h.hooked.dispose();
  });

  it('offers the successor its branch again after /clear', async () => {
    /**
     * `/clear` retires the conversation and keeps the pty, so `settleExit` —
     * the only place that forgot a branch — never runs. The dedupe entry stayed
     * primed for a row that no longer exists, the successor's branch never
     * republished, and no candidate was ever offered for it.
     *
     * That landed exactly on the case this signal is justified by: a session
     * cleared and continued on `feat/hive-111-ledger` would never reach the
     * HIVE-111 card unless the user said the key out loud again.
     */
    const h = branchHarness('feat/hive-111-ledger\n');
    await h.flush();

    h.turnEnded();
    await h.flush();
    h.mark();

    h.cleared();
    // Past the reader's floor, so this is a real re-read rather than the cache.
    h.clock.t = MIN_INTERVAL_MS;
    h.turnEnded();
    await h.flush();

    expect(h.intents()).toEqual([
      { entityId: 'hero-refresh', keys: ['HIVE-111'], source: 'branch' },
    ]);

    h.hooked.dispose();
  });

  it('publishes one candidate per branch, not one per event', async () => {
    /*
      `publishBranch` returns early when neither branch nor cwd changed, and the
      emit sits after that check. Without it, every `Stop` in a session on a
      ticket branch would be one more confirmed Jira read for an association
      that already exists.
    */
    const h = branchHarness('feat/hive-111-ledger\n');
    await h.flush();
    h.mark();

    h.turnEnded();
    await h.flush();
    // Past the reader's floor, so the second turn genuinely re-reads git rather
    // than being served the cache — the dedupe under test is the branch one.
    h.clock.t = MIN_INTERVAL_MS;
    h.turnEnded();
    await h.flush();

    expect(h.intents()).toHaveLength(1);

    h.hooked.dispose();
  });

  /**
   * HIVE-83: the whole reason `hooks/tracker.ts` exists. `Bash` (A) and
   * `AskUserQuestion` (B) run in parallel; A's `PostToolUse` — a sibling
   * finishing — must not clear the block B's `PermissionRequest` is holding.
   * Only B's own `PostToolUse` may release it.
   */
  it('holds waiting while a sibling tool finishes, then releases on the blocked one', () => {
    const h = harness();

    h.hook({ entityId: 'sess-a', event: 'UserPromptSubmit' });
    h.hook({ entityId: 'sess-a', event: 'PreToolUse', toolUseId: 'A', toolName: 'Bash' });
    h.hook({
      entityId: 'sess-a',
      event: 'PreToolUse',
      toolUseId: 'B',
      toolName: 'AskUserQuestion',
    });
    h.hook({
      entityId: 'sess-a',
      event: 'PermissionRequest',
      toolName: 'AskUserQuestion',
    });
    h.hook({ entityId: 'sess-a', event: 'PostToolUse', toolUseId: 'A', toolName: 'Bash' });

    expect(h.lastStatus('sess-a')).toBe('waiting');

    h.hook({
      entityId: 'sess-a',
      event: 'PostToolUse',
      toolUseId: 'B',
      toolName: 'AskUserQuestion',
    });
    expect(h.lastStatus('sess-a')).toBe('working');
  });

  /**
   * HIVE-83: `/clear` keeps the pty and opens a successor row. Without
   * `statusTracker.reset` on `onCleared`, the successor would inherit the
   * retired conversation's live subagent and sit on `idle (agents)` forever.
   */
  it('withdraws the history uuid when the conversation is cleared (HIVE-88)', () => {
    const written: { id: string; patch: Record<string, unknown> }[] = [];
    let clear: ((entityId: string) => void) | undefined;
    createSessions({
      supervisor,
      send: () => {},
      config: () => CONFIG,
      newSessionUuid: () => TEST_UUID,
      hooks: {
        settingsPathFor: () => undefined,
        envFor: () => ({}),
        start: (opts: { onCleared: (entityId: string) => void }) => {
          clear = opts.onCleared;
          return Promise.resolve();
        },
        stop: () => Promise.resolve(),
      } as unknown as Parameters<typeof createSessions>[0]['hooks'],
      history: {
        begin: (id, patch) => written.push({ id, patch: { ...patch } }),
        record: (id, patch) => written.push({ id, patch: { ...patch } }),
        resumable: () => undefined,
        all: () => [],
        flush: () => {},
        dispose: () => {},
      },
    });

    clear!('sess-b');

    const last = written.filter((entry) => entry.id === 'sess-b').at(-1);
    expect(last).toBeDefined();
    expect(last!.patch).toHaveProperty('sessionUuid');
    expect(last!.patch.sessionUuid).toBeUndefined();
  });

  it('clears tracker state when the conversation is cleared', () => {
    const h = harness();

    h.hook({ entityId: 'sess-b', event: 'UserPromptSubmit' });
    h.hook({ entityId: 'sess-b', event: 'SubagentStart', agentId: 'X' });
    h.hook({ entityId: 'sess-b', event: 'Stop' });
    expect(h.lastEvent('sess-b')).toMatchObject({ idleDetail: 'agents' });

    h.cleared('sess-b');
    h.hook({ entityId: 'sess-b', event: 'Stop' });
    expect(h.lastEvent('sess-b').idleDetail).toBeUndefined();
  });
});

describe('spawn preconditions', () => {
  it('names the project and the file to edit when it is unmapped', () => {
    expect(() =>
      sessions.open({ ...OPEN, projectId: 'referral-api' }),
    ).toThrow('referral-api is not mapped — add it to /home/dev/.hive/config.json');
  });

  it('refuses a project the config never mentions', () => {
    expect(() => sessions.open({ ...OPEN, projectId: 'unknown-repo' })).toThrow(
      'unknown-repo is not mapped — add it to /home/dev/.hive/config.json',
    );
  });

  it('refuses past the session cap', () => {
    const capped = createSessions({
      supervisor,
      send: (channel, payload) =>
        sent.push({ channel, payload: payload as Record<string, unknown> }),
      config: () => CONFIG,
      maxSessions: 2,
    });

    capped.open({ ...OPEN, entityId: 'a' });
    capped.open({ ...OPEN, entityId: 'b' });

    expect(() => capped.open({ ...OPEN, entityId: 'c' })).toThrow(
      'session limit reached (2)',
    );
    capped.dispose();
  });

  it('says the host is unavailable rather than blaming the config', () => {
    /**
     * A crash-blocked host cannot start anything. Saying "not mapped" would
     * send the user to edit a config file that is perfectly correct.
     */
    blocked = true;

    expect(() => sessions.open(OPEN)).toThrow(
      'pty host unavailable — see the activity feed',
    );
  });

  it('starts nothing when it refuses', () => {
    blocked = true;
    expect(() => sessions.open(OPEN)).toThrow();
    expect(spawned).toEqual([]);
    expect(sessions.entities()).toEqual([]);
  });
});

describe('restart: the defects the self review found', () => {
  it('lets a restarted session report status again', async () => {
    /**
     * The regression, and it was subtle. `done` is deliberately sticky —
     * output after an exit must not resurrect a dead session — but that guard
     * is keyed on the *entity*, and a restart gives the same entity a new
     * process. Without forgetting the old generation, the fresh shell's output
     * hits the guard, the status never leaves `terminated`, and the entity drops out
     * of the attention model for the rest of the app's life.
     */
    sessions.open(OPEN);
    const first = mintedFor('hero-refresh');

    emitExit({ sessionId: first, exitCode: 0 });
    vi.advanceTimersByTime(8);
    expect(on(CH.sessionStatus).at(-1)!.payload.status).toBe('terminated');

    await sessions.restart(OPEN);
    emitData({ sessionId: mintedFor('hero-refresh'), chunk: 'alive again' });
    vi.advanceTimersByTime(8);

    expect(on(CH.sessionStatus).at(-1)!.payload).toEqual({
      entityId: 'hero-refresh',
      status: 'working',
    });
  });

  it('joins a concurrent restart instead of racing it', async () => {
    /**
     * Two simultaneous restarts used to be destructive rather than redundant:
     * both read the same live session id, both awaited the same exit, and both
     * spawned. The second `registry.open` overwrote the first's mapping, so the
     * first new shell was orphaned — still running, uncounted, unaddressable,
     * and invisible until the app quit.
     */
    sessions.open(OPEN);
    const first = mintedFor('hero-refresh');

    const a = sessions.restart(OPEN);
    const b = sessions.restart(OPEN);
    await Promise.resolve();

    // One kill, not two: the second request joined the first.
    expect(killed).toEqual([first]);

    emitExit({ sessionId: first, exitCode: 0 });
    vi.advanceTimersByTime(8);
    await Promise.all([a, b]);

    // One new generation, and the registry can address it.
    expect(spawned).toHaveLength(2);
    expect(registryReachable()).toBe(true);
  });

  it('allows a fresh restart once the first has finished', async () => {
    sessions.open(OPEN);

    const first = mintedFor('hero-refresh');
    const one = sessions.restart(OPEN);
    await Promise.resolve();
    emitExit({ sessionId: first, exitCode: 0 });
    vi.advanceTimersByTime(8);
    await one;

    const second = mintedFor('hero-refresh');
    const two = sessions.restart(OPEN);
    await Promise.resolve();
    emitExit({ sessionId: second, exitCode: 0 });
    vi.advanceTimersByTime(8);
    await two;

    expect(spawned).toHaveLength(3);
  });

  it('rejects rather than hanging when the old process never exits', async () => {
    /**
     * The promise is awaited across an `invoke`. Without a bound of its own, a
     * wedged host would leave the renderer's `restart()` pending forever — a
     * spinner with no error and no timeout. It rejects rather than spawning
     * anyway, because spawning would mint a fresh id the supervisor would
     * accept, leaving two live shells in one repository.
     */
    sessions.open(OPEN);

    const restarted = sessions.restart(OPEN);
    const settled = restarted.then(
      () => 'resolved',
      (cause: Error) => cause.message,
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expect(await settled).toContain('did not exit');
    // Nothing new was started.
    expect(spawned).toHaveLength(1);
  });
});

/**
 * A PTY that runs a command rather than a session (story 102).
 *
 * Everything `open` resolves — a project, a login shell, a `claude` bootstrap —
 * is absent here on purpose. The only caller is the clone flow, whose cwd is a
 * directory it validated and whose child does not exist yet.
 */
describe('openCommand', () => {
  const CLONE = {
    entityId: 'hive.clone',
    cwd: '/Users/me/Projects',
    file: 'git',
    args: ['clone', '--progress', '--', 'https://x/y.git', 'y'],
    cols: 80,
    rows: 24,
  };

  it('spawns the given file and args in the given cwd', () => {
    sessions.openCommand({ ...CLONE, onExit: () => {} });

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      shell: 'git',
      args: ['clone', '--progress', '--', 'https://x/y.git', 'y'],
      cwd: '/Users/me/Projects',
    });
  });

  /**
   * The regression that matters most: arming the bootstrap would type `claude`
   * into a `git clone`, in a directory that does not exist yet.
   */
  it('does not arm the claude bootstrap', () => {
    sessions.openCommand({ ...CLONE, onExit: () => {} });

    emitData({ sessionId: mintedFor('hive.clone'), chunk: "Cloning into 'y'...\r\n" });
    vi.advanceTimersByTime(5_000);

    expect(supervisor.write).not.toHaveBeenCalled();
  });

  it('publishes no session status for an entity the store never heard of', () => {
    sessions.openCommand({ ...CLONE, onExit: () => {} });

    emitData({ sessionId: mintedFor('hive.clone'), chunk: 'receiving objects\r\n' });
    vi.advanceTimersByTime(5_000);

    expect(on(CH.sessionStatus)).toHaveLength(0);
  });

  it('calls onExit with the exit code', () => {
    const onExit = vi.fn();
    sessions.openCommand({ ...CLONE, onExit });

    emitExit({ sessionId: mintedFor('hive.clone'), exitCode: 0 });

    expect(onExit).toHaveBeenCalledWith({ exitCode: 0, signal: 0, lost: false });
  });

  it('calls onExit with lost when the host dies under it', () => {
    const onExit = vi.fn();
    sessions.openCommand({ ...CLONE, onExit });

    emitLost({ sessionId: mintedFor('hive.clone') });

    expect(onExit).toHaveBeenCalledWith({ exitCode: -1, signal: 0, lost: true });
  });

  /**
   * node-pty failing to start a binary emits a host `error` and **no exit**, so
   * for a command session this is the only signal that will ever arrive.
   * Without it, `git` missing from PATH leaves the caller waiting forever.
   */
  it('calls onExit when the binary could not start', () => {
    const onExit = vi.fn();
    sessions.openCommand({ ...CLONE, onExit });

    emitError({
      sessionId: mintedFor('hive.clone'),
      message: 'could not start git in /Users/me/Projects: ENOENT',
    });

    expect(onExit).toHaveBeenCalledWith({
      exitCode: -1,
      signal: 0,
      lost: false,
      message: 'could not start git in /Users/me/Projects: ENOENT',
    });
  });

  /** A signalled process reports its signal separately from its code. */
  it('carries the signal through, so a killed command is not a success', () => {
    const onExit = vi.fn();
    sessions.openCommand({ ...CLONE, onExit });

    emitExit({ sessionId: mintedFor('hive.clone'), exitCode: 0, signal: 15 });

    expect(onExit).toHaveBeenCalledWith({
      exitCode: 0,
      signal: 15,
      lost: false,
    });
  });

  it('calls onExit exactly once', () => {
    const onExit = vi.fn();
    sessions.openCommand({ ...CLONE, onExit });

    const sessionId = mintedFor('hive.clone');
    emitExit({ sessionId, exitCode: 1 });
    emitExit({ sessionId, exitCode: 1 });

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('routes write to the command session, so prompts are answerable', () => {
    sessions.openCommand({ ...CLONE, onExit: () => {} });

    sessions.write('hive.clone', 'hunter2\r');

    expect(supervisor.write).toHaveBeenCalledWith(
      mintedFor('hive.clone'),
      'hunter2\r',
    );
  });

  it('refuses when the host is blocked', () => {
    blocked = true;
    expect(() =>
      sessions.openCommand({ ...CLONE, onExit: () => {} }),
    ).toThrow();
  });

  it('refuses when the session cap is reached', () => {
    const capped = createSessions({
      supervisor,
      send: () => {},
      config: () => CONFIG,
      maxSessions: 0,
    });

    expect(() =>
      capped.openCommand({ ...CLONE, onExit: () => {} }),
    ).toThrow(/capacity|limit/i);

    capped.dispose();
  });
});


/**
 * Which credentials a session inherits (HIVE-79).
 *
 * The removal itself happens in the pty host's `buildEnv`; what is asserted
 * here is the **decision** — that main reads the config and tells the host
 * which names to drop. The two halves are tested apart because only this one
 * knows about a config file and only that one knows about an environment.
 *
 * This is a billing change, which is why the "off" case matters as much as the
 * default: a user who sets `subscriptionAuth: false` must get exactly the
 * environment they got before this feature existed.
 */
describe('session authentication', () => {
  it('strips the API credentials by default, so rate limits are reported', () => {
    sessions.open(OPEN);

    // Without this, `claude` bills the API account and its status line carries
    // no `rate_limits` at all — the header's two limit gauges stay empty for
    // the whole life of the session, with nothing on screen to explain it.
    expect(spawned[0]!.stripEnv).toEqual(AUTH_ENV_KEYS);
  });

  it('inherits them when the user has turned subscription auth off', () => {
    const off = createSessions({
      supervisor,
      send: (channel, payload) =>
        sent.push({ channel, payload: payload as Record<string, unknown> }),
      config: () => ({ ...CONFIG, subscriptionAuth: false }),
      newSessionUuid: () => TEST_UUID,
    });

    off.open(OPEN);

    expect(spawned[0]!.stripEnv).toEqual([]);
    off.dispose();
  });

  /**
   * A clone runs `git`, not `claude`. It has no authentication to make a
   * decision about, and naming credentials for it would be cargo cult.
   */
  it('says nothing about a command session', () => {
    sessions.openCommand({
      entityId: 'clone-1',
      cwd: '/tmp',
      file: 'git',
      args: ['clone'],
      cols: 80,
      rows: 24,
      onExit: () => {},
    });

    expect(spawned[0]!.stripEnv).toBeUndefined();
  });
});

/**
 * What reaches the history (HIVE-87).
 *
 * The history itself is tested against a real file in `history.test.ts`; these
 * pin the *wiring* — that each moment main knows something worth keeping
 * actually hands it over, and that a build without a history is unaffected. A
 * fake rather than the real one, for the reason the supervisor is faked: a unit
 * test that wrote into `userData` would leave state behind.
 */
describe('the history', () => {
  interface Written {
    id: string;
    patch: Record<string, unknown>;
  }

  const withHistory = (written: Written[], resumable?: Record<string, string>) =>
    createSessions({
      supervisor,
      send: (channel, payload) =>
        sent.push({ channel, payload: payload as Record<string, unknown> }),
      config: () => CONFIG,
      newSessionUuid: () => TEST_UUID,
      history: {
        /*
          Both verbs land in one list. What these tests assert is *what main
          hands over and when*; which of the two carried it is the history's own
          concern and is covered in `history.test.ts`.
        */
        begin: (id, patch, options) => {
          written.push({ id, patch: { ...patch, ...(options ?? {}) } });
        },
        record: (id, patch) => {
          written.push({ id, patch: { ...patch } });
        },
        resumable: (id) => resumable?.[id],
        all: () => [],
        flush: () => {},
        dispose: () => {},
      },
    });

  /** Every patch written for an entity, in order — records merge. */
  const patchesFor = (written: Written[], id: string) =>
    written.filter((entry) => entry.id === id).map((entry) => entry.patch);

  it('records the session at spawn, carrying the uuid it pinned', () => {
    const written: Written[] = [];
    withHistory(written).open(OPEN);

    expect(patchesFor(written, 'hero-refresh')[0]).toMatchObject({
      project: 'nova-web',
      status: 'working',
      sessionUuid: TEST_UUID,
    });
  });

  it('writes the same uuid to the history and to the command line', () => {
    // The whole point of hoisting it out of the sessionCommand call: two calls
    // to newSessionUuid() would leave the history naming a transcript that does
    // not exist, which is the one thing recording it is meant to make possible.
    //
    // The command line is *typed into* the pty rather than passed as spawn
    // args — `claude` runs inside a login shell — so this reads the bootstrap
    // write, exactly as the BOOT assertions above do.
    const written: Written[] = [];
    const withIt = withHistory(written);
    withIt.open(OPEN);
    const sessionId = mintedFor('hero-refresh');

    emitData({ sessionId, chunk: '$ ' });
    vi.advanceTimersByTime(8);
    vi.advanceTimersByTime(150);
    vi.advanceTimersByTime(SUBMIT);

    const recorded = patchesFor(written, 'hero-refresh')[0]?.sessionUuid;
    expect(supervisor.write).toHaveBeenCalledWith(
      sessionId,
      expect.stringContaining(`--session-id ${String(recorded)}`) as unknown as string,
    );
  });

  it('records the model and effort a session was started as', () => {
    const written: Written[] = [];
    withHistory(written).open({ ...OPEN, model: 'haiku', effort: 'low' });

    expect(patchesFor(written, 'hero-refresh')[0]).toMatchObject({
      model: 'haiku',
      effort: 'low',
    });
  });

  it('omits a name nobody supplied rather than storing an empty one', () => {
    const written: Written[] = [];
    withHistory(written).open(OPEN);

    expect(patchesFor(written, 'hero-refresh')[0]).not.toHaveProperty('name');
  });

  it('records the ending when the pty exits', () => {
    const written: Written[] = [];
    withHistory(written).open(OPEN);

    emitExit({ sessionId: mintedFor('hero-refresh'), exitCode: 0 });

    const ending = patchesFor(written, 'hero-refresh').at(-1);
    expect(ending).toMatchObject({ status: 'terminated' });
    expect(typeof ending?.endedAt).toBe('number');
  });

  /**
   * The title stream against a pinned name, over a **real** history (HIVE-107,
   * relaxed by HIVE-108).
   *
   * Both halves are pinned on their own — `history.test.ts` owns the merge rule,
   * and the tests above own the fact that `readTitle` records what it reads —
   * but the bug lived in the seam, so this is the one place they are composed.
   * A session renamed mid-conversation goes on painting the name Claude knows it
   * by, several times a second, and every one of those repaints reaches
   * `record`. The file underneath the row used to go back to `sess-01` before
   * the user had finished reading the rename, and the file is what the next
   * launch restores from.
   *
   * What the pin defends is now the **key**, not the whole name: the agent's
   * title is taken and `HIVE-104` is kept in front of it. The regression this
   * guards against is the same one either way — the ticket falling off the
   * front on the next repaint.
   */
  it('keeps a pinned key in front of the agent’s own repaints', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-pin-'));
    const file = join(dir, 'sessions.json');
    try {
      const history = createSessionHistory(file, () => 1000);
      const withIt = createSessions({
        supervisor,
        send: (channel, payload) =>
          sent.push({ channel, payload: payload as Record<string, unknown> }),
        config: () => CONFIG,
        newSessionUuid: () => TEST_UUID,
        history,
      });
      withIt.open(OPEN);
      const sessionId = mintedFor('hero-refresh');
      // Past the bootstrap, which is the window `readTitle` refuses to read in.
      emitData({ sessionId, chunk: '$ ' });
      vi.advanceTimersByTime(158 + SUBMIT);

      // The user names a ticket mid-session; the renderer's note arrives.
      history.record('hero-refresh', { ticket: 'HIVE-104', name: 'HIVE-104', namePinned: true });

      // And Claude, which was never told, goes on painting what it knows.
      emitData({ sessionId, chunk: '\u001b]0;✳ hero-refresh\u0007' });
      vi.advanceTimersByTime(8);
      history.flush();

      expect(history.all()[0]).toMatchObject({
        name: 'HIVE-104-hero-refresh',
        namePinned: true,
        ticket: 'HIVE-104',
      });
      /*
        The renderer is told the *raw* title and applies the same pin itself —
        main's job on this channel is to report what the terminal said, not to
        decide what the row is called. The two arrive at one answer because they
        run one function, which is what `history.ts` and `renameSession` each say
        in their own words.
      */
      expect(on(CH.sessionName).at(-1)?.payload).toMatchObject({
        name: 'hero-refresh',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says nothing about a command session, which has no history to keep', () => {
    // Same reason the activity tracker is not told: a clone's ending is not a
    // session's, and a `clone-1` row in the fleet list would be a fiction.
    const written: Written[] = [];
    withHistory(written).openCommand({
      entityId: 'clone-1',
      cwd: '/tmp',
      file: 'git',
      args: ['clone'],
      cols: 80,
      rows: 24,
      onExit: () => {},
    });

    expect(patchesFor(written, 'clone-1')).toEqual([]);
  });

  /**
   * Picking a previous run's conversation back up (HIVE-88).
   *
   * The renderer asks; the history decides whether it can; the command line and
   * the record both follow that decision. The resumed uuid must reach
   * `--resume` on the command line, the same uuid must be what the history is
   * told, and the opening instruction must not be delivered again.
   */
  describe('resume', () => {
    const PRIOR = '11111111-1111-4111-8111-111111111111';

    const settle = (sessionId: string) => {
      emitData({ sessionId, chunk: '$ ' });
      vi.advanceTimersByTime(8);
      vi.advanceTimersByTime(150);
      vi.advanceTimersByTime(SUBMIT);
    };

    it('resumes the conversation the history names, and says nothing twice', () => {
      const written: Written[] = [];
      withHistory(written, { 'hero-refresh': PRIOR }).open({
        ...OPEN,
        task: 'fix the hero',
        resume: true,
      });
      settle(mintedFor('hero-refresh'));

      expect(supervisor.write).toHaveBeenCalledWith(
        mintedFor('hero-refresh'),
        `unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; claude --resume ${PRIOR} && exit`,
      );
      expect(patchesFor(written, 'hero-refresh')[0]).toMatchObject({
        sessionUuid: PRIOR,
        resume: true,
      });
      expect(patchesFor(written, 'hero-refresh')[0]).not.toHaveProperty('task');
    });

    /**
     * The name the conversation already has is the one it keeps (HIVE-107).
     *
     * `--name` on a `--resume` is not a label on a new session, it is a
     * **rename of the old one**: measured against Claude Code 2.1.247, a resume
     * carrying `--name probe-beta` reopened a conversation stored as
     * `probe-alpha` and painted `✳ probe-beta` — and the next resume, with no
     * flag at all, still said `probe-beta`. The override is written into the
     * transcript.
     *
     * So the entity-id fallback, which is right for a spawn, was the whole bug:
     * every resumed session was renamed to `sess-0n` on its way back, the title
     * stream reported that as the agent's own choice, and `readTitle` wrote it
     * through to the history — so `troubleshooting-crawling` became `sess-0n`
     * permanently, having survived the quit that was supposed to be the risky
     * part.
     */
    it('leaves the resumed conversation the name it already has', () => {
      const written: Written[] = [];
      withHistory(written, { 'hero-refresh': PRIOR }).open({ ...OPEN, resume: true });
      settle(mintedFor('hero-refresh'));

      const line = vi.mocked(supervisor.write).mock.calls.at(0)?.[1] ?? '';
      expect(line).not.toContain('--name');
    });

    /**
     * A caller that *does* name a resume is obeyed, because it is saying
     * something the history cannot: this conversation should now be called this.
     * Nothing asks for that today — `resumeSession` and `resolveTransport` both
     * send `resume` and no name — and the flag is dropped only where the
     * alternative was inventing one.
     */
    it('still renames a resume the caller named on purpose', () => {
      const written: Written[] = [];
      withHistory(written, { 'hero-refresh': PRIOR }).open({
        ...OPEN,
        resume: true,
        name: 'HIVE-73',
      });
      settle(mintedFor('hero-refresh'));

      expect(supervisor.write).toHaveBeenCalledWith(
        mintedFor('hero-refresh'),
        `unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; claude --name HIVE-73 --resume ${PRIOR} && exit`,
      );
    });

    /**
     * A spawn that degrades to fresh is a beginning, and produces the ordinary
     * bootstrap line — which since HIVE-108 names nothing, so that Claude can
     * name the session from the conversation instead.
     */
    it('falls back to a fresh session when there is nothing to resume', () => {
      // A record older than uuids, or an id this run already began: the
      // renderer's request is honest but unanswerable, and the spawn is the
      // one it would have been without the flag.
      const written: Written[] = [];
      withHistory(written).open({ ...OPEN, resume: true });
      settle(mintedFor('hero-refresh'));

      expect(supervisor.write).toHaveBeenCalledWith(mintedFor('hero-refresh'), BOOT);
      expect(patchesFor(written, 'hero-refresh')[0]).toMatchObject({
        sessionUuid: TEST_UUID,
        resume: false,
        task: '',
      });
    });

    it('never resumes unasked, however well the history knows the id', () => {
      const written: Written[] = [];
      withHistory(written, { 'hero-refresh': PRIOR }).open(OPEN);
      settle(mintedFor('hero-refresh'));

      expect(supervisor.write).toHaveBeenCalledWith(mintedFor('hero-refresh'), BOOT);
      expect(patchesFor(written, 'hero-refresh')[0]).toMatchObject({
        sessionUuid: TEST_UUID,
      });
    });

    it('works without a history: resume degrades to a plain spawn', () => {
      sessions.open({ ...OPEN, resume: true });
      settle(mintedFor('hero-refresh'));

      expect(supervisor.write).toHaveBeenCalledWith(mintedFor('hero-refresh'), BOOT);
    });
  });

  it('keeps the history status current as the session reports it', () => {
    // `status` is documented as the last known one (HIVE-88). A renderer that
    // starts in front of a running pty reads it, so it has to be true.
    const written: Written[] = [];
    const withIt = withHistory(written);
    withIt.open(OPEN);
    const sessionId = mintedFor('hero-refresh');
    emitData({ sessionId, chunk: 'building' });
    vi.advanceTimersByTime(8);
    vi.advanceTimersByTime(2_000);

    const statuses = patchesFor(written, 'hero-refresh')
      .map((patch) => patch.status)
      .filter((status) => status !== undefined);
    expect(statuses.at(-1)).toBe('idle');
  });

  it('works with no history at all — absent is supported, not degraded', () => {
    expect(() => {
      sessions.open(OPEN);
      emitExit({ sessionId: mintedFor('hero-refresh'), exitCode: 0 });
    }).not.toThrow();
  });
});

/**
 * `/done` — a session declaring itself finished (HIVE-93).
 *
 * The whole feature is one bit of state and what it changes: whether the app
 * owes this terminal an exit, and whether the ending is recorded as `done` or
 * `terminated`. Both are asserted here against the seam that actually decides
 * them, because after the `/exit` is written **nothing downstream can tell the
 * two endings apart** — the app's `/exit` and a user's are the same bytes.
 *
 * The receiver's half — that a POST is authenticated and correlated before any
 * of this runs — is `hooks/receiver.test.ts`.
 */
describe('/done', () => {
  interface Written {
    id: string;
    patch: Record<string, unknown>;
  }

  function finished(): {
    open: () => string;
    done: (entityId: string) => void;
    hook: (entityId: string, event: HookStatusEvent['event']) => void;
    cleared: (entityId: string) => void;
    restart: () => Promise<void>;
    patches: (entityId: string) => Record<string, unknown>[];
    statusOf: (entityId: string) => unknown;
    finishedFor: (entityId: string) => number;
    lastFinished: (entityId: string) => Record<string, unknown> | undefined;
  } {
    const written: Written[] = [];
    const local: Sent[] = [];
    let onEvent!: (event: HookStatusEvent) => void;
    let onDone!: (entityId: string) => void;
    let onCleared!: (entityId: string) => void;

    const instance = createSessions({
      supervisor,
      send: (channel, payload) =>
        local.push({ channel, payload: payload as Record<string, unknown> }),
      config: () => CONFIG,
      newSessionUuid: () => TEST_UUID,
      hooks: {
        settingsPathFor: () => undefined,
        envFor: () => ({}),
        doneUrl: () => null,
        start: (opts: {
          onEvent: (event: HookStatusEvent) => void;
          onDone: (entityId: string) => void;
          onCleared: (entityId: string) => void;
        }) => {
          onEvent = opts.onEvent;
          onDone = opts.onDone;
          onCleared = opts.onCleared;
          return Promise.resolve();
        },
        stop: () => Promise.resolve(),
      } as unknown as Parameters<typeof createSessions>[0]['hooks'],
      /**
       * A fake that **reflects what it has been told**, rather than answering a
       * constant (HIVE-93).
       *
       * `resumable: () => undefined` is what let a real bug through a green
       * suite: `publishFinished` asks the history whether the conversation can be
       * reopened, and it was asking *before* `settleExit` recorded the ending —
       * so every `/done` shipped `resumable: false` and the Resume control never
       * appeared. A stub that always says "no" agrees with a broken ordering and
       * a correct one alike, which makes it worse than no assertion at all.
       *
       * So this mirrors the real rule — a record is resumable once it has a uuid
       * and has ended — and the ordering becomes something a test can see.
       *
       * What it deliberately does **not** model is the real history's
       * `startedThisRun` half. That branch only decides an *unended, same-run*
       * record, which the rule above already refuses, so modelling it would add
       * nothing here. It would matter to a test that exercised `resumable`
       * across a restart — this harness has no restart, and a fake that quietly
       * diverges from the real rule in a case a future test does reach is the
       * exact shape of the stub this replaced.
       */
      history: {
        begin: (id, patch, options) => {
          written.push({ id, patch: { ...patch, ...(options ?? {}) } });
        },
        record: (id, patch) => {
          written.push({ id, patch: { ...patch } });
        },
        resumable: (id) => {
          const merged = written
            .filter((entry) => entry.id === id)
            .reduce<Record<string, unknown>>(
              (acc, entry) => ({ ...acc, ...entry.patch }),
              {},
            );
          const ended =
            merged.endedAt !== undefined ||
            merged.status === 'done' ||
            merged.status === 'terminated';
          return ended && typeof merged.sessionUuid === 'string'
            ? merged.sessionUuid
            : undefined;
        },
        all: () => [],
        flush: () => {},
        dispose: () => {},
      },
    });

    return {
      open: () => {
        instance.open(OPEN);
        // The bootstrap's own writes are not what these tests are about.
        vi.mocked(supervisor.write).mockClear();
        return mintedFor('hero-refresh');
      },
      done: (entityId) => onDone(entityId),
      hook: (entityId, event) =>
        onEvent({ entityId, event, status: 'working' } as HookStatusEvent),
      cleared: (entityId) => onCleared(entityId),
      restart: () => instance.restart(OPEN),
      patches: (entityId) =>
        written.filter((entry) => entry.id === entityId).map((entry) => entry.patch),
      statusOf: (entityId) =>
        local
          .filter(
            (entry) =>
              entry.channel === CH.sessionStatus && entry.payload.entityId === entityId,
          )
          .at(-1)?.payload.status,
      finishedFor: (entityId) =>
        local.filter(
          (entry) =>
            entry.channel === CH.sessionFinished &&
            entry.payload.entityId === entityId,
        ).length,
      lastFinished: (entityId) =>
        local
          .filter(
            (entry) =>
              entry.channel === CH.sessionFinished &&
              entry.payload.entityId === entityId,
          )
          .at(-1)?.payload,
    };
  }

  /** Every chunk written into the pty since the session opened. */
  const writes = () => vi.mocked(supervisor.write).mock.calls.map((call) => call[1]);

  it('closes the terminal with /exit rather than a signal', () => {
    const h = finished();
    const sessionId = h.open();

    h.done('hero-refresh');
    h.hook('hero-refresh', 'Stop');

    /*
      The assertion is the *mechanism*, not just the effect. `bootstrap.ts`
      starts sessions as `claude … && exit`, so only a clean exit retires the
      row — a signal would make `claude` exit non-zero, short-circuit the `&&`,
      and leave a live login shell wrapped around a dead agent.
    */
    expect(writes()).toEqual(['/exit\r']);
    expect(killed).not.toContain(sessionId);
  });

  it('waits for the turn to end rather than writing into a working pty', () => {
    const h = finished();
    h.open();

    h.done('hero-refresh');

    /*
      The POST arrives *during* a turn — it is a tool call the agent is in the
      middle of. Five characters written into a REPL that is still working land
      somewhere nobody can predict.
    */
    expect(writes()).toEqual([]);
  });

  it('records done where a bare exit records terminated', () => {
    const h = finished();
    const sessionId = h.open();

    h.done('hero-refresh');
    h.hook('hero-refresh', 'Stop');
    emitExit({ sessionId, exitCode: 0 });

    expect(h.patches('hero-refresh').at(-1)).toMatchObject({ status: 'done' });
    /*
      Announced on its own channel, not as a status (HIVE-93). The renderer's
      answer to a finish is structural — end the row, mint no successor, fall
      back to the orchestrator — and a `terminated` status arriving beside it
      would overwrite the ending the user asked for with the mechanism that
      delivered it.
    */
    expect(h.finishedFor('hero-refresh')).toBe(1);
    expect(h.statusOf('hero-refresh')).not.toBe('terminated');
  });

  it('reports the finish as resumable, so the row can offer Resume', () => {
    const h = finished();
    const sessionId = h.open();

    h.done('hero-refresh');
    h.hook('hero-refresh', 'Stop');
    emitExit({ sessionId, exitCode: 0 });

    /*
      The ordering assertion, and the reason it is worth its own test: the
      history is asked this question *during* `settleExit`, so it has to have
      been told the session ended before anything asks. Recorded second, it
      answered "no" for every `/done` — the transcript still on disk, the uuid
      still in the history, and nothing on screen able to reach either.
    */
    expect(h.lastFinished('hero-refresh')).toMatchObject({ resumable: true });
  });

  it('records terminated for an exit nobody declared', () => {
    const h = finished();
    const sessionId = h.open();

    // The same clean exit, the same bytes, no declaration in front of it.
    emitExit({ sessionId, exitCode: 0 });

    expect(h.patches('hero-refresh').at(-1)).toMatchObject({
      status: 'terminated',
    });
    expect(h.statusOf('hero-refresh')).toBe('terminated');
  });

  it('withdraws the declaration when the user goes back to work', () => {
    const h = finished();
    const sessionId = h.open();

    h.done('hero-refresh');
    h.hook('hero-refresh', 'UserPromptSubmit');
    h.hook('hero-refresh', 'Stop');

    // Nothing written, and the ending that eventually comes is not `done`.
    expect(writes()).toEqual([]);
    emitExit({ sessionId, exitCode: 0 });
    expect(h.patches('hero-refresh').at(-1)).toMatchObject({
      status: 'terminated',
    });
  });

  it('does not treat a subagent finishing as the end of the turn', () => {
    const h = finished();
    h.open();

    h.done('hero-refresh');
    h.hook('hero-refresh', 'SubagentStop');

    expect(writes()).toEqual([]);
  });

  it('kills the terminal when /exit is ignored', () => {
    const h = finished();
    const sessionId = h.open();

    h.done('hero-refresh');
    h.hook('hero-refresh', 'Stop');
    expect(killed).not.toContain(sessionId);

    vi.advanceTimersByTime(10_000);

    expect(killed).toContain(sessionId);
  });

  it('does not kill a terminal that took the /exit', () => {
    const h = finished();
    const sessionId = h.open();

    h.done('hero-refresh');
    h.hook('hero-refresh', 'Stop');
    emitExit({ sessionId, exitCode: 0 });

    // The timer has to go with the session, or it fires against a closed
    // registry entry ten seconds later.
    vi.advanceTimersByTime(10_000);

    expect(killed).not.toContain(sessionId);
  });

  it('never writes a second /exit however often /done is invoked', () => {
    const h = finished();
    h.open();

    h.done('hero-refresh');
    h.done('hero-refresh');
    h.hook('hero-refresh', 'Stop');
    h.hook('hero-refresh', 'Stop');

    expect(writes()).toEqual(['/exit\r']);
  });

  it('withdraws the declaration when the conversation is cleared', () => {
    const h = finished();
    h.open();

    h.done('hero-refresh');
    h.cleared('hero-refresh');
    h.hook('hero-refresh', 'Stop');

    /*
      `/clear` retires the conversation that declared itself finished and opens
      a successor on the same terminal. Acting on it afterwards would close a
      session the user has only just started.
    */
    expect(writes()).toEqual([]);
  });

  it('ignores a declaration from a session it does not have', () => {
    const h = finished();
    h.open();

    expect(() => h.done('sess-gone')).not.toThrow();
    expect(writes()).toEqual([]);
  });

  it('calls off the force-kill when a new turn starts after the /exit', () => {
    const h = finished();
    const sessionId = h.open();

    h.done('hero-refresh');
    h.hook('hero-refresh', 'Stop');
    expect(writes()).toEqual(['/exit\r']);

    /*
      `/exit\r` goes into a pty, not to a REPL that promised to act on it. With
      a half-typed draft at the prompt those five characters append to it and
      submit it as an ordinary prompt — so the session goes back to work, and
      this event is the proof. Left armed, the backstop would destroy the pty
      ten seconds into that turn and file it as `done`.
    */
    h.hook('hero-refresh', 'UserPromptSubmit');
    vi.advanceTimersByTime(10_000);

    expect(killed).not.toContain(sessionId);
  });

  it('does not record a restarted generation as done', async () => {
    const h = finished();
    const first = h.open();

    h.done('hero-refresh');
    // Restart before the turn ends, so the declaration is still on file.
    const restarted = h.restart();
    await Promise.resolve();
    emitExit({ sessionId: first, exitCode: 0 });
    vi.advanceTimersByTime(8);
    await restarted;

    /*
      A restart is not an ending. The user interrupted this generation; filing
      it as `done` would claim it finished, and the row would flash `done` on
      its way to respawning.
    */
    const statuses = h
      .patches('hero-refresh')
      .map((patch) => patch.status)
      .filter((status) => status !== undefined);
    expect(statuses).not.toContain('done');
  });
});

/**
 * The idle signal the ledger's delivery rule reads (HIVE-113).
 *
 * Two shapes of the same question. `onIdle` is the push — main telling a
 * consumer a prompt just came free — and `isIdle` is the pull, for a caller
 * that arrives between events and has to ask.
 */
describe('the idle signal', () => {
  it('fires when a session goes idle with nothing running behind it', () => {
    const onIdle = vi.fn();
    const h = harness(onIdle);
    h.sessions.open(OPEN);

    h.hook({ entityId: 'hero-refresh', event: 'Stop', backgroundShells: [] });

    expect(onIdle).toHaveBeenCalledWith('hero-refresh');
  });

  it('stays quiet while a background shell is still running', () => {
    /*
      `Stop` with a live background shell still derives `idle` — with
      `detail: 'script'` — so the status alone would say yes to a session that
      is still working. This is the case the `bgShells` half of the guard is
      for.
    */
    const onIdle = vi.fn();
    const h = harness(onIdle);
    h.sessions.open(OPEN);

    h.hook({ entityId: 'hero-refresh', event: 'Stop', backgroundShells: ['shell-1'] });

    expect(onIdle).not.toHaveBeenCalled();
  });

  it('stays quiet for a session waiting on a permission prompt', () => {
    // `waiting` is not `idle`; writing here would be writing mid-turn.
    const onIdle = vi.fn();
    const h = harness(onIdle);
    h.sessions.open(OPEN);

    h.hook({ entityId: 'hero-refresh', event: 'PermissionRequest', toolName: 'Bash' });

    expect(onIdle).not.toHaveBeenCalled();
  });

  it('reports isIdle only for a live session at an empty prompt', () => {
    const h = harness();

    // No pty yet: not idle, whatever any hook has said.
    expect(h.sessions.isIdle('hero-refresh')).toBe(false);

    h.sessions.open(OPEN);
    h.hook({ entityId: 'hero-refresh', event: 'Stop', backgroundShells: [] });
    expect(h.sessions.isIdle('hero-refresh')).toBe(true);

    // `UserPromptSubmit` derives `working` — the turn started again.
    h.hook({ entityId: 'hero-refresh', event: 'UserPromptSubmit' });
    expect(h.sessions.isIdle('hero-refresh')).toBe(false);
  });

  it('does not report isIdle while a background shell is running', () => {
    const h = harness();
    h.sessions.open(OPEN);

    h.hook({ entityId: 'hero-refresh', event: 'Stop', backgroundShells: ['shell-1'] });

    expect(h.sessions.isIdle('hero-refresh')).toBe(false);
  });
});

/**
 * What this layer supplies for the *agent* id space (HIVE-115).
 *
 * `receiver.test.ts` proves the socket keeps the two apart. This proves the
 * other half of the wiring: that the two answers this file hands the receiver —
 * "is this a name I have a definition for" and "an agent's hook arrived" — are
 * built the way the receiver's guarantee assumes, and that neither of them ends
 * in a `session:status` push.
 */
describe('the agent id space (HIVE-115)', () => {
  const AGENT = 'slack-watcher';
  const UUID = 'f9589d3c-8987-4f7d-ba2f-537952d2633c';

  const agentHarness = (): {
    knowsAgent: (entityId: string) => boolean;
    agentEvent: (event: Partial<HookAgentEvent> & { event: HookAgentEvent['event'] }) => void;
    sessionEvent: (event: HookStatusEvent['event']) => void;
    turnsEnded: ReturnType<typeof vi.fn>;
    names: Set<string>;
    sent: Sent[];
    sessions: Sessions;
  } => {
    let knowsAgent: ((entityId: string) => boolean) | undefined;
    let onAgentEvent: ((event: HookAgentEvent) => void) | undefined;
    let onEvent: ((event: HookStatusEvent) => void) | undefined;
    const localSent: Sent[] = [];
    /*
      Mutated after `createSessions` has run, which is the point: a user can
      write a definition while the app is open, so a set captured at
      construction would be wrong by the time the agent's first hook lands.
    */
    const names = new Set<string>();
    const turnsEnded = vi.fn();

    const instance = createSessions({
      supervisor,
      send: (channel, payload) =>
        localSent.push({ channel, payload: payload as Record<string, unknown> }),
      config: () => CONFIG,
      newSessionUuid: () => TEST_UUID,
      agentNames: () => names,
      onAgentTurnEnded: turnsEnded,
      hooks: {
        settingsPathFor: () => undefined,
        envFor: () => ({}),
        start: (opts: {
          knowsAgent: (entityId: string) => boolean;
          onAgentEvent: (event: HookAgentEvent) => void;
          onEvent: (event: HookStatusEvent) => void;
        }) => {
          knowsAgent = opts.knowsAgent;
          onAgentEvent = opts.onAgentEvent;
          onEvent = opts.onEvent;
          return Promise.resolve();
        },
        stop: () => Promise.resolve(),
      } as unknown as Parameters<typeof createSessions>[0]['hooks'],
    });

    return {
      knowsAgent: (entityId) => knowsAgent!(entityId),
      // `status` is required on the wire contract and unread here.
      agentEvent: (event) =>
        onAgentEvent!({ entityId: AGENT, status: 'idle', ...event } as HookAgentEvent),
      sessionEvent: (event: HookStatusEvent['event']) =>
        onEvent!({ entityId: 'hero-refresh', status: 'idle', event } as HookStatusEvent),
      turnsEnded,
      names,
      sent: localSent,
      sessions: instance,
    };
  };

  it('answers knowsAgent from the register as it stands, not as it was', () => {
    const h = agentHarness();

    expect(h.knowsAgent(AGENT)).toBe(false);

    // Written while the app is running — the case a snapshot would miss.
    h.names.add(AGENT);

    expect(h.knowsAgent(AGENT)).toBe(true);
    expect(h.knowsAgent('nobody-at-all')).toBe(false);

    h.sessions.dispose();
  });

  it('forwards a Stop with the session uuid that came with it', () => {
    const h = agentHarness();

    h.agentEvent({ event: 'Stop', sessionUuid: UUID });

    expect(h.turnsEnded).toHaveBeenCalledWith(AGENT, UUID);

    h.sessions.dispose();
  });

  /**
   * Absent, not invented. The tracker reads a missing uuid as "cannot
   * correlate" and decides for itself; substituting anything here would be
   * this layer asserting a match it has no evidence for.
   */
  it('forwards a Stop with no uuid as undefined', () => {
    const h = agentHarness();

    h.agentEvent({ event: 'Stop' });

    expect(h.turnsEnded).toHaveBeenCalledWith(AGENT, undefined);

    h.sessions.dispose();
  });

  it.each(['SessionStart', 'PreToolUse', 'PostToolUse', 'SubagentStop'] as const)(
    'accepts %s from an agent and acts on none of it',
    (event) => {
      const h = agentHarness();

      h.agentEvent({ event, sessionUuid: UUID });

      expect(h.turnsEnded).not.toHaveBeenCalled();

      h.sessions.dispose();
    },
  );

  /**
   * The guarantee the second callback exists for, stated where it can be
   * observed: no agent event, of any kind, puts a row on the fleet.
   *
   * The session event at the end is the control. Without it this would pass on
   * a harness that publishes nothing at all, which is the shape of a test that
   * is green for the wrong reason.
   */
  it('never publishes a session status for an agent, though a session does', () => {
    const h = agentHarness();

    for (const event of ['SessionStart', 'PreToolUse', 'Stop'] as const) {
      h.agentEvent({ event, sessionUuid: UUID });
    }

    expect(h.sent.filter((entry) => entry.channel === CH.sessionStatus)).toEqual([]);

    h.sessionEvent('Stop');

    expect(
      h.sent
        .filter((entry) => entry.channel === CH.sessionStatus)
        .map((entry) => entry.payload['entityId']),
    ).toEqual(['hero-refresh']);

    h.sessions.dispose();
  });
});

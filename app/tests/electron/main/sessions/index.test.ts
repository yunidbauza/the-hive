// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTH_ENV_KEYS,
  DEFAULT_JIRA,
  DEFAULT_NOTIFICATIONS,
  type ConfigSnapshot,
} from '../../../../electron/shared/config-contract';
import { CH } from '../../../../electron/shared/ipc-contract';

import type { PtyHostSupervisor } from '../../../../electron/main/pty-host/supervisor';
import {
  createSessions,
  type Sessions,
} from '../../../../electron/main/sessions';

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
  projects: [
    {
      id: 'apfm-web',
      name: 'apfm-web',
      path: '/repos/apfm-web',
      icon: 'ph-folder',
      origin: 'local',
      status: 'ok',
      isRepo: true,
    },
    {
      id: 'referral-api',
      name: 'referral-api',
      path: null,
      icon: 'ph-folder',
      origin: 'local',
      status: 'missing',
      isRepo: false,
    },
  ],
  notifications: { ...DEFAULT_NOTIFICATIONS },
  jira: { ...DEFAULT_JIRA },
  subscriptionAuth: true,
  sessionMetrics: true,
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

const OPEN = { entityId: 'hero-refresh', projectId: 'apfm-web', cols: 80, rows: 24 };

/** Pinned so the command line is a constant rather than a moving target. */
const TEST_UUID = '00000000-0000-4000-8000-000000000000';

/**
 * The bootstrap command line a plain spawn produces.
 *
 * `--name` is the entity id (HIVE-61), so the agent's prompt box and `/resume`
 * entry agree with the rail. `--session-id` is pinned so the transcript path is
 * deterministic. No `--settings`, because this harness passes no hook runtime —
 * which is itself the "hooks unavailable" case, and it must still spawn.
 */
/**
 * The bootstrap line a plain spawn produces.
 *
 * The `unset` prefix is HIVE-79's: `stripEnv` sanitises the environment node-pty
 * is handed, but `claude` is typed into a **login shell**, which re-sources the
 * user's profile and re-exports anything they set there. Without this the whole
 * subscription-auth feature is a no-op for the population it exists for.
 */
const BOOT = `unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; claude --name hero-refresh --session-id ${TEST_UUID} && exit`;

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
    expect(spawned[0]!.cwd).toBe('/repos/apfm-web');
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
   * The theme picks which settings file the session is started with.
   *
   * The last link in a chain that starts in `localStorage`: the renderer
   * resolves the app's theme, the guard admits it, and this is where it becomes
   * a path on a command line. `claude` paints its own chrome from that file, so
   * getting it wrong is what drew a user's submitted prompt as a near-black bar
   * across a light terminal.
   */
  it('starts a session with the settings file for its theme', () => {
    const asked: (string | undefined)[] = [];
    const themed = createSessions({
      supervisor,
      send: (channel, payload) =>
        sent.push({ channel, payload: payload as Record<string, unknown> }),
      config: () => CONFIG,
      newSessionUuid: () => TEST_UUID,
      hooks: {
        settingsPathFor: (theme?: string) => {
          asked.push(theme);
          return `/userData/hive/claude-hooks.settings.${theme ?? 'dark'}.json`;
        },
        envFor: () => ({}),
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      } as unknown as Parameters<typeof createSessions>[0]['hooks'],
    });

    themed.open({ ...OPEN, theme: 'light' });
    const sessionId = mintedFor('hero-refresh');

    emitData({ sessionId, chunk: '$ ' });
    vi.advanceTimersByTime(8);
    vi.advanceTimersByTime(150);
    vi.advanceTimersByTime(SUBMIT);

    expect(asked).toEqual(['light']);
    const written = vi
      .mocked(supervisor.write)
      .mock.calls.map(([, data]) => data)
      .join('');
    expect(written).toContain('claude-hooks.settings.light.json');
    expect(written).not.toContain('claude-hooks.settings.dark.json');
  });

  it('delivers a spawn task as the session’s first message', () => {
    /**
     * Two stages, one mechanism (story 097): the shell settles and `claude`
     * goes in, then the TUI settles and the task goes in. Timed here rather
     * than in the renderer, which has no signal for "the TUI is ready".
     */
    sessions.open({ ...OPEN, task: 'fix the hero' });
    const sessionId = mintedFor('hero-refresh');

    emitData({ sessionId, chunk: '$ ' });
    vi.advanceTimersByTime(8);
    vi.advanceTimersByTime(150);
    expect(supervisor.write).toHaveBeenLastCalledWith(sessionId, BOOT);

    /**
     * Stage one's `\r` first. Stage two is armed inside the submit timer, so
     * until this elapses there is no second stage to settle — the ordering that
     * keeps the task off the command line (HIVE-63).
     */
    vi.advanceTimersByTime(SUBMIT);
    expect(supervisor.write).toHaveBeenLastCalledWith(sessionId, '\r');

    emitData({ sessionId, chunk: '╭─ claude ─╮' });
    vi.advanceTimersByTime(8);
    vi.advanceTimersByTime(150);

    expect(supervisor.write).toHaveBeenLastCalledWith(sessionId, 'fix the hero');
    vi.advanceTimersByTime(SUBMIT);
    expect(supervisor.write).toHaveBeenLastCalledWith(sessionId, '\r');

    // And the whole exchange, in order.
    expect(vi.mocked(supervisor.write).mock.calls.map((call) => call[1]).join('')).toBe(
      `${BOOT}\rfix the hero\r`,
    );
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
        (call) => call[1] === 'fix the hero',
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

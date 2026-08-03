// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfigSnapshot } from '../../../../electron/shared/config-contract';
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
let spawned: { sessionId: string; shell: string; args: string[]; cwd: string }[];
let killed: string[];
let sessions: Sessions;
let supervisor: PtyHostSupervisor;
let emitData: (event: { sessionId: string; chunk: string }) => void;
let emitExit: (event: { sessionId: string; exitCode: number }) => void;
let blocked: boolean;

const CONFIG: ConfigSnapshot = {
  configPath: '/home/dev/.hive/config.json',
  templateWritten: false,
  shell: '/bin/zsh',
  claudeCommand: 'claude',
  projects: [
    { id: 'apfm-web', path: '/repos/apfm-web', status: 'ok' },
    { id: 'referral-api', path: null, status: 'missing' },
  ],
  errors: [],
};

function fakeSupervisor(): PtyHostSupervisor {
  return {
    spawn: vi.fn((request: { sessionId: string; shell: string; args: string[]; cwd: string }) => {
      spawned.push(request);
    }),
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
    onError: vi.fn(() => () => {}),
    onSessionLost: vi.fn(() => () => {}),
    shutdown: vi.fn(async () => {}),
    isRunning: vi.fn(() => true),
    isBlocked: vi.fn(() => blocked),
    sessionIds: vi.fn(() => []),
  } as unknown as PtyHostSupervisor;
}

const OPEN = { entityId: 'hero-refresh', projectId: 'apfm-web', cols: 80, rows: 24 };

/** The pty session id main minted for the current generation of an entity. */
const mintedFor = (entityId: string) =>
  spawned.filter((call) => call.sessionId.startsWith(entityId)).at(-1)!.sessionId;

/** Can the registry still address the newest generation it spawned? */
const registryReachable = () => {
  const latest = spawned.at(-1)!.sessionId;
  sessions.write('hero-refresh', 'probe');
  return vi.mocked(supervisor.write).mock.calls.some(
    (call) => call[0] === latest,
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
     * Not `$SHELL -l -c claude`, which would run `claude` as the shell's only
     * job and exit with it — leaving the user looking at a corpse in the middle
     * of a repository they were working in.
     */
    sessions.open(OPEN);
    const sessionId = mintedFor('hero-refresh');

    emitData({ sessionId, chunk: '$ ' });
    vi.advanceTimersByTime(8); // the batch flush
    vi.advanceTimersByTime(150); // the settling debounce

    expect(supervisor.write).toHaveBeenCalledWith(sessionId, 'claude\r');
  });

  it('writes the bootstrap exactly once', () => {
    sessions.open(OPEN);
    const sessionId = mintedFor('hero-refresh');

    for (let i = 0; i < 5; i += 1) {
      emitData({ sessionId, chunk: `chunk ${i}` });
      vi.advanceTimersByTime(200);
    }

    expect(vi.mocked(supervisor.write).mock.calls).toHaveLength(1);
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
  it('reports working, then idle, then done', () => {
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
    expect(on(CH.sessionStatus).at(-1)!.payload.status).toBe('done');
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
     * hits the guard, the status never leaves `done`, and the entity drops out
     * of the attention model for the rest of the app's life.
     */
    sessions.open(OPEN);
    const first = mintedFor('hero-refresh');

    emitExit({ sessionId: first, exitCode: 0 });
    vi.advanceTimersByTime(8);
    expect(on(CH.sessionStatus).at(-1)!.payload.status).toBe('done');

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

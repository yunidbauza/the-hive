// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPtyHostSupervisor,
  type HostChild,
  type PtyHostSupervisor,
} from '../../../../electron/main/pty-host/supervisor';
import type {
  HostCommand,
  HostMessage,
} from '../../../../electron/shared/pty-host-protocol';

/**
 * The pty-host supervisor (story 091).
 *
 * Every dependency is injected, so this file asserts the whole supervision
 * story — lazy start, heartbeat timeout, crash fan-out, the crash-loop guard,
 * shutdown escalation — without forking a process or waiting a real second.
 *
 * What it deliberately cannot prove: that a real host actually crashes the way
 * this fake does. `kill -9` on a genuine `utilityProcess` belongs to story 098,
 * which can crash a real one on purpose.
 */

/** A recording fake of the slice of `UtilityProcess` the supervisor uses. */
class FakeHost implements HostChild {
  readonly pid = 1234;
  readonly sent: HostCommand[] = [];
  readonly kill = vi.fn(() => {
    this.killed = true;
    return true;
  });

  killed = false;

  private readonly listeners = {
    message: [] as ((message: HostMessage) => void)[],
    exit: [] as ((code: number) => void)[],
    spawn: [] as (() => void)[],
  };

  postMessage(message: HostCommand): void {
    this.sent.push(message);
  }

  on(event: 'message', listener: (message: HostMessage) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(event: 'spawn', listener: () => void): void;
  on(event: 'message' | 'exit' | 'spawn', listener: never): void {
    this.listeners[event].push(listener);
  }

  /** Test-only: the child finished starting. */
  ready(): void {
    for (const listener of [...this.listeners.spawn]) listener();
  }

  /** Test-only: the child sent something up. */
  emit(message: HostMessage): void {
    for (const listener of [...this.listeners.message]) listener(message);
  }

  /** Test-only: the child died. */
  die(code = 1): void {
    for (const listener of [...this.listeners.exit]) listener(code);
  }

  /** Answer every ping received so far, as a healthy host would. */
  answerPings(): void {
    for (const command of this.sent) {
      if (command.type === 'ping') this.emit({ type: 'pong', seq: command.seq });
    }
  }

  commandsOfType(type: HostCommand['type']): HostCommand[] {
    return this.sent.filter((command) => command.type === type);
  }
}

const SPAWN = {
  sessionId: 'hero-refresh',
  shell: '/bin/zsh',
  args: [],
  cwd: '/repos/nova-web',
  env: { TERM: 'xterm-256color' },
  cols: 80,
  rows: 24,
};

let hosts: FakeHost[];
let clock: number;
let supervisor: PtyHostSupervisor;

function build(overrides: Parameters<typeof createPtyHostSupervisor>[0] extends infer T ? Partial<T> : never = {}) {
  hosts = [];
  return createPtyHostSupervisor({
    fork: () => {
      const host = new FakeHost();
      hosts.push(host);
      return host;
    },
    now: () => clock,
    ...overrides,
  });
}

/** The most recent host, asserted to exist. */
const host = (): FakeHost => {
  const last = hosts.at(-1);
  if (!last) throw new Error('no host was forked');
  return last;
};

/** Fork + finish starting, which is what a healthy launch looks like. */
function spawnSession(request = SPAWN): FakeHost {
  supervisor.spawn(request);
  host().ready();
  return host();
}

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_000_000;
  supervisor = build();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('lazy start', () => {
  it('forks nothing until the first session is requested', () => {
    // Most launches land on the orchestrator console, which owns no PTY.
    expect(hosts).toHaveLength(0);
    expect(supervisor.isRunning()).toBe(false);

    supervisor.spawn(SPAWN);

    expect(hosts).toHaveLength(1);
    expect(supervisor.isRunning()).toBe(true);
  });

  it('reuses the one host for every later session — one host, many PTYs', () => {
    spawnSession();
    supervisor.spawn({ ...SPAWN, sessionId: 'lead-form' });

    expect(hosts).toHaveLength(1);
    expect(supervisor.sessionIds()).toEqual(['hero-refresh', 'lead-form']);
  });

  it('queues commands issued before the child finished starting, in order', () => {
    supervisor.spawn(SPAWN);
    supervisor.write('hero-refresh', 'ls\r');

    // Nothing can be posted yet — the child's port is not attached.
    expect(host().sent).toEqual([]);

    host().ready();

    expect(host().sent.map((command) => command.type)).toEqual([
      'spawn',
      'write',
    ]);
  });

  it('refuses a session id it already owns', () => {
    const errors = vi.fn();
    supervisor.onError(errors);
    spawnSession();

    supervisor.spawn(SPAWN);

    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('already exists') }),
    );
    expect(host().commandsOfType('spawn')).toHaveLength(1);
  });
});

describe('session ownership', () => {
  it.each(['write', 'resize', 'kill'] as const)(
    'rejects %s for an unknown session rather than forwarding it',
    (verb) => {
      const errors = vi.fn();
      supervisor.onError(errors);
      spawnSession();
      const before = host().sent.length;

      if (verb === 'write') supervisor.write('ghost', 'x');
      if (verb === 'resize') supervisor.resize('ghost', 80, 24);
      if (verb === 'kill') supervisor.kill('ghost');

      expect(host().sent).toHaveLength(before);
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'ghost',
          message: expect.stringContaining('unknown session'),
        }),
      );
    },
  );

  it('drops inbound data for a session it does not own', () => {
    const data = vi.fn();
    supervisor.onData(data);
    spawnSession();

    host().emit({ type: 'data', sessionId: 'ghost', chunk: 'boo' });
    expect(data).not.toHaveBeenCalled();

    host().emit({ type: 'data', sessionId: 'hero-refresh', chunk: 'hi' });
    expect(data).toHaveBeenCalledTimes(1);
  });

  it('forgets a session that exits normally, without treating it as a crash', () => {
    const exits = vi.fn();
    const lost = vi.fn();
    supervisor.onExit(exits);
    supervisor.onSessionLost(lost);
    spawnSession();

    host().emit({ type: 'exit', sessionId: 'hero-refresh', exitCode: 0 });

    expect(exits).toHaveBeenCalledTimes(1);
    expect(lost).not.toHaveBeenCalled();
    expect(supervisor.sessionIds()).toEqual([]);
    // The host is still alive — one session ending is not a host failure.
    expect(supervisor.isRunning()).toBe(true);
  });
});

describe('heartbeat', () => {
  it('pings once started and stays quiet while the host answers', () => {
    spawnSession();

    for (let beat = 0; beat < 10; beat += 1) {
      vi.advanceTimersByTime(2_000);
      host().answerPings();
    }

    expect(host().commandsOfType('ping')).toHaveLength(10);
    expect(host().killed).toBe(false);
    expect(supervisor.isRunning()).toBe(true);
  });

  it('treats a run of unanswered pings as a crash and kills the hung host', () => {
    const lost = vi.fn();
    supervisor.onSessionLost(lost);
    const hung = spawnSession();

    // Three pings go out unanswered; the fourth tick condemns it. A host that
    // hangs without exiting is indistinguishable from a dead terminal unless
    // something is watching.
    vi.advanceTimersByTime(2_000 * 4);

    expect(hung.killed).toBe(true);
    expect(supervisor.isRunning()).toBe(false);
    expect(lost).toHaveBeenCalledWith({
      sessionId: 'hero-refresh',
      reason: 'host-crashed',
    });
  });

  it('answers a ping from the host with a pong, not another ping', () => {
    spawnSession();

    host().emit({ type: 'ping', seq: 5 });

    // Replying with a ping would ask the question back instead of answering
    // it, and the two sides would sit there interrogating each other.
    expect(host().sent).toContainEqual({ type: 'pong', seq: 5 });
    expect(host().commandsOfType('ping')).toHaveLength(0);
  });

  it('does not condemn a host for a single slow tick', () => {
    const lost = vi.fn();
    supervisor.onSessionLost(lost);
    spawnSession();

    vi.advanceTimersByTime(2_000 * 2);
    host().answerPings();
    vi.advanceTimersByTime(2_000 * 3);

    expect(lost).not.toHaveBeenCalled();
    expect(supervisor.isRunning()).toBe(true);
  });
});

describe('crash handling', () => {
  it('marks every owned session lost, once each', () => {
    const lost = vi.fn();
    supervisor.onSessionLost(lost);
    spawnSession();
    supervisor.spawn({ ...SPAWN, sessionId: 'lead-form' });
    supervisor.spawn({ ...SPAWN, sessionId: 'webhooks' });

    host().die(9);

    expect(lost.mock.calls.map(([event]) => event.sessionId)).toEqual([
      'hero-refresh',
      'lead-form',
      'webhooks',
    ]);
    expect(supervisor.sessionIds()).toEqual([]);
  });

  it('does not restart eagerly — the next spawn is what brings a host back', () => {
    spawnSession();
    host().die();

    expect(hosts).toHaveLength(1);
    expect(supervisor.isRunning()).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(hosts).toHaveLength(1);

    supervisor.spawn({ ...SPAWN, sessionId: 'lead-form' });
    expect(hosts).toHaveLength(2);
  });

  it('never resurrects the sessions the dead host owned', () => {
    spawnSession();
    host().die();

    supervisor.spawn({ ...SPAWN, sessionId: 'lead-form' });
    host().ready();

    // A restarted host has no memory of the old one's children — those
    // processes are gone, and re-running `claude` unasked could redo work.
    expect(supervisor.sessionIds()).toEqual(['lead-form']);
    expect(host().commandsOfType('spawn')).toHaveLength(1);
  });

  it('stops the heartbeat with the host, so a dead host is pinged no further', () => {
    const dead = spawnSession();
    dead.die();
    const sentAtDeath = dead.sent.length;

    vi.advanceTimersByTime(2_000 * 10);

    expect(dead.sent).toHaveLength(sentAtDeath);
  });
});

describe('crash-loop guard', () => {
  /** Crash the host `times` times, restarting between each. */
  function crash(times: number, sessionId = 'hero-refresh'): void {
    for (let attempt = 0; attempt < times; attempt += 1) {
      supervisor.spawn({ ...SPAWN, sessionId: `${sessionId}-${attempt}` });
      host().ready();
      host().die();
    }
  }

  it('stops restarting at the fourth crash inside the window', () => {
    const errors = vi.fn();
    supervisor.onError(errors);

    crash(3);
    expect(supervisor.isBlocked()).toBe(false);

    crash(1, 'again');

    expect(supervisor.isBlocked()).toBe(true);
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('not restarting'),
      }),
    );

    // An unbounded restart loop against a reproducible segfault burns CPU and
    // floods the feed, so the next request must not fork a fifth host.
    const forked = hosts.length;
    supervisor.spawn({ ...SPAWN, sessionId: 'blocked' });
    expect(hosts).toHaveLength(forked);
    expect(supervisor.sessionIds()).toEqual([]);
  });

  it('reports a clear refusal rather than failing silently', () => {
    const errors = vi.fn();
    supervisor.onError(errors);
    crash(4);
    errors.mockClear();

    supervisor.spawn({ ...SPAWN, sessionId: 'blocked' });

    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'blocked',
        message: expect.stringContaining('crashed repeatedly'),
      }),
    );
  });

  it('only counts crashes inside the window — an app up for days is not condemned', () => {
    crash(3);
    // Three crashes, then a quiet hour.
    clock += 60_000 * 60;
    crash(1, 'much-later');

    expect(supervisor.isBlocked()).toBe(false);
  });
});

describe('shutdown', () => {
  it('resolves immediately when no host was ever started', async () => {
    await expect(supervisor.shutdown()).resolves.toBeUndefined();
    expect(hosts).toHaveLength(0);
  });

  it('asks the host to exit and waits for it, without force-killing', async () => {
    const running = spawnSession();

    const pending = supervisor.shutdown();
    expect(running.commandsOfType('shutdown')).toHaveLength(1);

    running.die(0);
    await pending;

    // Graceful: it left on request, so it was never killed.
    expect(running.kill).not.toHaveBeenCalled();
    expect(supervisor.isRunning()).toBe(false);
    expect(supervisor.sessionIds()).toEqual([]);
  });

  it('force-kills a host that will not leave, so the app can still quit', async () => {
    const stuck = spawnSession();

    const pending = supervisor.shutdown();
    expect(stuck.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    await pending;

    expect(stuck.kill).toHaveBeenCalledTimes(1);
  });

  it('does not report a deliberate shutdown as a crash', async () => {
    const lost = vi.fn();
    const errors = vi.fn();
    supervisor.onSessionLost(lost);
    supervisor.onError(errors);
    const running = spawnSession();

    const pending = supervisor.shutdown();
    running.die(0);
    await pending;

    expect(lost).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(supervisor.isBlocked()).toBe(false);
  });
});

describe('listeners', () => {
  it('stops delivering to a listener that unsubscribed', () => {
    const data = vi.fn();
    const dispose = supervisor.onData(data);
    spawnSession();

    dispose();
    host().emit({ type: 'data', sessionId: 'hero-refresh', chunk: 'hi' });

    expect(data).not.toHaveBeenCalled();
  });

  it('forwards spawned and error messages from the host verbatim', () => {
    const spawned = vi.fn();
    const errors = vi.fn();
    supervisor.onSpawned(spawned);
    supervisor.onError(errors);
    spawnSession();

    host().emit({ type: 'spawned', sessionId: 'hero-refresh', pid: 999 });
    host().emit({ type: 'error', message: 'something went wrong' });

    expect(spawned).toHaveBeenCalledWith({
      type: 'spawned',
      sessionId: 'hero-refresh',
      pid: 999,
    });
    expect(errors).toHaveBeenCalledWith({
      type: 'error',
      message: 'something went wrong',
    });
  });
});

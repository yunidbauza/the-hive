// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPtyIpc, type PtyIpc } from '../../../../electron/main/ipc/pty';
import type { PtyHostSupervisor } from '../../../../electron/main/pty-host/supervisor';
import {
  CH,
  type DataEvent,
  type ExitEvent,
} from '../../../../electron/shared/ipc-contract';

/**
 * PTY IPC: batching, flow control, sequencing (story 093).
 *
 * **Fake timers throughout — no real waits, per `AGENTS.md`.** Every rule here
 * is a timing rule, and asserting them by flooding a real terminal would be
 * slow, flaky, and would prove nothing about the boundaries.
 *
 * The acceptance criteria that need a live terminal — `yes` not freezing the
 * window, Ctrl-C landing within a few hundred milliseconds, stable RSS over a
 * 60-second flood — are **deferred to stories 094/095**, which own the
 * renderer half of the ack loop. They are unprovable without one: the ack that
 * drives all of this comes from xterm's write callback.
 */

interface Sent {
  channel: string;
  payload: DataEvent | ExitEvent;
}

let sent: Sent[];
let supervisor: PtyHostSupervisor;
let ipc: PtyIpc;
let emitData: (event: { sessionId: string; chunk: string }) => void;
let emitExit: (event: ExitEvent) => void;
let emitError: (event: { sessionId?: string; message: string }) => void;
let emitLost: (event: { sessionId: string; reason: string }) => void;

const SPAWN = {
  sessionId: 'a',
  shell: '/bin/zsh',
  args: [] as string[],
  cwd: '/repos/apfm-web',
  env: {},
  cols: 80,
  rows: 24,
};

/** A supervisor stub that lets the test drive its event streams. */
function fakeSupervisor(): PtyHostSupervisor {
  return {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
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
    isBlocked: vi.fn(() => false),
    sessionIds: vi.fn(() => []),
  } as unknown as PtyHostSupervisor;
}

const dataEvents = (sessionId?: string): DataEvent[] =>
  sent
    .filter((entry) => entry.channel === CH.ptyData)
    .map((entry) => entry.payload as DataEvent)
    .filter((event) => sessionId === undefined || event.sessionId === sessionId);

const exitEvents = (): ExitEvent[] =>
  sent
    .filter((entry) => entry.channel === CH.ptyExit)
    .map((entry) => entry.payload as ExitEvent);

function build(overrides: Partial<Parameters<typeof createPtyIpc>[0]> = {}) {
  supervisor = fakeSupervisor();
  return createPtyIpc({
    supervisor,
    send: (channel, payload) => {
      sent.push({ channel, payload: payload as DataEvent | ExitEvent });
    },
    ...overrides,
  });
}

/**
 * Push `bytes` of output at a session and let it reach the wire.
 *
 * The timer advance matters: only a payload past the size cap flushes on its
 * own, so a small one would otherwise still be sitting in the batch buffer and
 * every assertion about acks would be measuring nothing.
 */
const flood = (sessionId: string, bytes: number): void => {
  emitData({ sessionId, chunk: 'x'.repeat(bytes) });
  vi.advanceTimersByTime(8);
};

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  ipc = build();
  ipc.spawn(SPAWN);
});

afterEach(() => {
  ipc.dispose();
  vi.useRealTimers();
});

describe('batching', () => {
  it('coalesces everything inside the window into one message', () => {
    for (let i = 0; i < 10; i += 1) emitData({ sessionId: 'a', chunk: `${i}` });

    // Nothing goes out until the window closes.
    expect(dataEvents()).toHaveLength(0);

    vi.advanceTimersByTime(8);

    expect(dataEvents()).toHaveLength(1);
    expect(dataEvents()[0]?.chunk).toBe('0123456789');
  });

  it('flushes immediately past the size cap, without waiting for the timer', () => {
    flood('a', 64 * 1024);

    // A firehose must not build a large string before the timer fires.
    expect(dataEvents()).toHaveLength(1);
    expect(dataEvents()[0]?.chunk).toHaveLength(64 * 1024);
  });

  it('batches per session — a noisy session does not delay another echo', () => {
    ipc.spawn({ ...SPAWN, sessionId: 'b' });

    emitData({ sessionId: 'a', chunk: 'noisy' });
    vi.advanceTimersByTime(4);
    emitData({ sessionId: 'b', chunk: 'echo' });

    // A's window opened first, so it closes first — B is not dragged onto A's
    // schedule, and B's own window has not elapsed yet.
    vi.advanceTimersByTime(4);
    expect(dataEvents('a')).toHaveLength(1);
    expect(dataEvents('b')).toHaveLength(0);

    vi.advanceTimersByTime(4);
    expect(dataEvents('b')).toHaveLength(1);
  });

  it('sends nothing at all when a session is idle', () => {
    vi.advanceTimersByTime(1_000);

    expect(sent).toEqual([]);
  });

  it('numbers batches monotonically, per session', () => {
    emitData({ sessionId: 'a', chunk: 'one' });
    vi.advanceTimersByTime(8);
    emitData({ sessionId: 'a', chunk: 'two' });
    vi.advanceTimersByTime(8);

    // The renderer asserts monotonicity and writes a gap marker on a break, so
    // these must never restart or skip.
    expect(dataEvents().map((event) => event.seq)).toEqual([1, 2]);
  });

  it('restarts sequencing for a re-spawned session id', () => {
    emitData({ sessionId: 'a', chunk: 'old' });
    vi.advanceTimersByTime(8);

    ipc.spawn(SPAWN);
    emitData({ sessionId: 'a', chunk: 'new' });
    vi.advanceTimersByTime(8);

    // A fresh accounting window: carrying the old one's unacked bytes into a
    // session that never sent them would pause it for no reason.
    expect(dataEvents().map((event) => event.seq)).toEqual([1, 1]);
  });
});

describe('flow control', () => {
  it('pauses the pty once unacked bytes cross the high-water mark', () => {
    flood('a', 600 * 1024);

    // Real backpressure: the host stops reading the fd, the kernel pty buffer
    // fills, and the producing process blocks on write.
    expect(supervisor.pause).toHaveBeenCalledWith('a');
  });

  it('does not pause below the mark', () => {
    flood('a', 100 * 1024);
    vi.advanceTimersByTime(8);

    expect(supervisor.pause).not.toHaveBeenCalled();
    expect(supervisor.resume).not.toHaveBeenCalled();
  });

  it('pauses once, not on every batch above the mark', () => {
    flood('a', 600 * 1024);
    flood('a', 600 * 1024);

    expect(supervisor.pause).toHaveBeenCalledTimes(1);
  });

  it('resumes only once the ack brings it under the low-water mark', () => {
    flood('a', 600 * 1024);
    expect(supervisor.pause).toHaveBeenCalledTimes(1);

    // An ack that releases the first batch but leaves 200 KB outstanding —
    // still above the low-water mark, so the producer stays stopped.
    flood('a', 200 * 1024);
    ipc.ack('a', 1);
    expect(supervisor.resume).not.toHaveBeenCalled();

    ipc.ack('a', 2);
    expect(supervisor.resume).toHaveBeenCalledWith('a');
  });

  it('stays paused while no ack arrives — no ack, no resume', () => {
    flood('a', 600 * 1024);

    vi.advanceTimersByTime(10_000);

    // This is the assertion that separates acknowledgement from batching. Time
    // passing is not progress; only the renderer parsing is.
    expect(supervisor.resume).not.toHaveBeenCalled();
  });

  it('releases exactly the bytes an ack covers, and no more', () => {
    flood('a', 10);
    flood('a', 20);
    flood('a', 30);

    ipc.ack('a', 2);

    const stats = ipc.diagnostics().find((entry) => entry.sessionId === 'a')!;
    expect(stats.bytesAcked).toBe(30);
    expect(stats.unacked).toBe(30);
  });

  it('ignores an ack for a sequence already released', () => {
    flood('a', 10);
    ipc.ack('a', 1);
    ipc.ack('a', 1);

    const stats = ipc.diagnostics().find((entry) => entry.sessionId === 'a')!;
    // A duplicate ack must not release bytes twice and open the window wider
    // than the renderer has actually consumed.
    expect(stats.bytesAcked).toBe(10);
    expect(stats.unacked).toBe(0);
  });

  it('ignores an ack for a session it does not know', () => {
    expect(() => ipc.ack('ghost', 1)).not.toThrow();
  });
});

describe('resize throttling', () => {
  it('applies the first resize immediately', () => {
    ipc.resize('a', 100, 30);

    // The leading edge: a single deliberate resize must not wait 50ms.
    expect(supervisor.resize).toHaveBeenCalledWith('a', 100, 30);
  });

  it('collapses a drag into at most one call per window', () => {
    for (let cols = 100; cols < 140; cols += 1) ipc.resize('a', cols, 30);

    // Every resize is a SIGWINCH to a process that redraws on each one.
    expect(supervisor.resize).toHaveBeenCalledTimes(1);
  });

  it('always lands the final geometry, via the trailing call', () => {
    for (let cols = 100; cols < 140; cols += 1) ipc.resize('a', cols, 30);

    vi.advanceTimersByTime(50);

    // Without the trailing call a drag ends on a stale size, and `stty size`
    // disagrees with what is rendered until the next resize.
    expect(supervisor.resize).toHaveBeenLastCalledWith('a', 139, 30);
    expect(supervisor.resize).toHaveBeenCalledTimes(2);
  });

  it('stops calling once the drag stops', () => {
    ipc.resize('a', 100, 30);
    ipc.resize('a', 120, 30);
    vi.advanceTimersByTime(50);
    expect(supervisor.resize).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(5_000);

    expect(supervisor.resize).toHaveBeenCalledTimes(2);
  });

  it('ignores a resize for an unknown session', () => {
    ipc.resize('ghost', 100, 30);

    expect(supervisor.resize).not.toHaveBeenCalled();
  });
});

describe('exit ordering', () => {
  it('delivers exit only after the final data has been flushed', () => {
    emitData({ sessionId: 'a', chunk: 'the error you needed to read' });
    emitExit({ sessionId: 'a', exitCode: 1 });

    // Delivering exit early truncates the last output — usually the error.
    expect(sent.map((entry) => entry.channel)).toEqual([CH.ptyData, CH.ptyExit]);
    expect(dataEvents()[0]?.chunk).toBe('the error you needed to read');
  });

  it('does not wait out the batch window when the process is already gone', () => {
    emitData({ sessionId: 'a', chunk: 'bye' });
    emitExit({ sessionId: 'a', exitCode: 0 });

    // Nothing more is coming to coalesce with, so the flush is immediate.
    expect(exitEvents()).toHaveLength(1);
  });

  it('delivers exit for a session that produced no output at all', () => {
    emitExit({ sessionId: 'a', exitCode: 0 });

    expect(exitEvents()).toEqual([{ sessionId: 'a', exitCode: 0 }]);
  });
});

describe('dropping', () => {
  it('drops data for an exited session and counts it', () => {
    emitExit({ sessionId: 'a', exitCode: 0 });
    sent = [];

    emitData({ sessionId: 'a', chunk: 'too late' });
    vi.advanceTimersByTime(8);

    // The ordinary race: a session killed while output is still in flight.
    expect(dataEvents()).toHaveLength(0);
    const stats = ipc.diagnostics().find((entry) => entry.sessionId === 'a')!;
    expect(stats.dropped).toBe(1);
  });

  it('drops data for a session it never knew about, under a synthetic row', () => {
    emitData({ sessionId: 'ghost', chunk: 'boo' });
    vi.advanceTimersByTime(8);

    expect(dataEvents()).toHaveLength(0);
    const unknown = ipc
      .diagnostics()
      .find((entry) => entry.sessionId === '(unknown)');
    // Main and the host disagreeing about what exists is worth seeing rather
    // than silently discarding.
    expect(unknown?.dropped).toBe(1);
  });
});

describe('errors and lost sessions', () => {
  it('logs a host error rather than dropping it on the floor', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    emitError({ sessionId: 'a', message: 'could not start /bin/zsh' });

    // There is no renderer error channel yet — story 095 owns that surface.
    // Until then, a session that silently fails to start is indistinguishable
    // from one that started and produced nothing.
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('could not start /bin/zsh'),
    );
  });

  it('stops delivering output to a session whose host died', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    emitLost({ sessionId: 'a', reason: 'host-crashed' });
    emitData({ sessionId: 'a', chunk: 'from a dead host' });
    vi.advanceTimersByTime(8);

    expect(dataEvents()).toHaveLength(0);
  });

  it('reports an exit only once, however many arrive', () => {
    emitExit({ sessionId: 'a', exitCode: 0 });
    emitExit({ sessionId: 'a', exitCode: 0 });

    expect(exitEvents()).toHaveLength(1);
  });
});

describe('diagnostics', () => {
  it('reports the counters flow-control bugs are otherwise guessed at', () => {
    flood('a', 1_000);
    ipc.ack('a', 1);
    flood('a', 600 * 1024);

    const stats = ipc.diagnostics().find((entry) => entry.sessionId === 'a')!;

    expect(stats).toMatchObject({
      sessionId: 'a',
      bytesIn: 1_000 + 600 * 1024,
      bytesAcked: 1_000,
      pauses: 1,
      batches: 2,
      paused: true,
    });
  });

  it('shows a batch count of one per flush while idle-ish', () => {
    emitData({ sessionId: 'a', chunk: 'k' });
    vi.advanceTimersByTime(8);

    const stats = ipc.diagnostics().find((entry) => entry.sessionId === 'a')!;
    // The signal the story asks for: batches of 1 when nothing is flooding.
    expect(stats.batches).toBe(1);
    expect(stats.bytesIn).toBe(1);
  });

  it('is empty before anything has run', () => {
    const fresh = build();
    expect(fresh.diagnostics()).toEqual([]);
    fresh.dispose();
  });
});

describe('pass-through', () => {
  it('forwards a write without touching it', () => {
    ipc.write('a', '\x03');

    // Ctrl-C is a byte. Interpreting it here would take SIGINT away from the
    // pty, which is the thing that makes it work.
    expect(supervisor.write).toHaveBeenCalledWith('a', '\x03');
  });

  it('forwards spawn and kill to the supervisor', () => {
    ipc.kill('a');

    expect(supervisor.spawn).toHaveBeenCalledWith(SPAWN);
    expect(supervisor.kill).toHaveBeenCalledWith('a');
  });
});

describe('dispose', () => {
  it('drops every pending timer so nothing fires after teardown', () => {
    emitData({ sessionId: 'a', chunk: 'pending' });
    ipc.resize('a', 100, 30);

    ipc.dispose();
    sent = [];
    vi.advanceTimersByTime(1_000);

    expect(sent).toEqual([]);
    expect(ipc.diagnostics()).toEqual([]);
  });
});

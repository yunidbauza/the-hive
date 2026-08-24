import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionMetricsEvent } from '@shared/metrics-contract';
import type {
  SessionBranchEvent,
  SessionClearedEvent,
  SessionFinishedEvent,
  SessionNameEvent,
  SessionStatusEvent,
  SessionTicketIntentEvent,
} from '@shared/session-contract';
import type { SessionNoteRequest } from '@shared/session-history-contract';

import { isSession } from '@/types/entity';

import { useSessionStatus } from '@features/sessions/hooks/use-session-status';
import { useHiveStore } from '@stores/hive-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

/**
 * The renderer half of story 096's status path.
 *
 * Note what is *not* here: a transcript. With a real PTY the output goes
 * straight to xterm through the transport and never touches a store, which is
 * what keeps a build log from re-rendering the shell. Only the status comes
 * back.
 */

let listeners: ((event: SessionStatusEvent) => void)[];
let nameListeners: ((event: SessionNameEvent) => void)[];
let clearedListeners: ((event: SessionClearedEvent) => void)[];
let finishedListeners: ((event: SessionFinishedEvent) => void)[];
let branchListeners: ((event: SessionBranchEvent) => void)[];
let metricsListeners: ((event: SessionMetricsEvent) => void)[];
let intentListeners: ((event: SessionTicketIntentEvent) => void)[];
let disposals: number;
/** What the hook handed to `session.note` (HIVE-87). */
let notedTickets: SessionNoteRequest[];

/**
 * What `jira.issue` answers (HIVE-78).
 *
 * Replaced per test, because the whole point of the intent path is that a
 * key-shaped string is only acted on when Jira confirms it exists.
 */
let issueReply: unknown = null;
let issueCalls: string[];

function withBridge() {
  (window as { hive?: unknown }).hive = {
    jira: {
      issue: ({ key }: { key: string }) => {
        issueCalls.push(key);
        return Promise.resolve(issueReply);
      },
    },
    session: {
      onStatus: (callback: (event: SessionStatusEvent) => void) => {
        listeners.push(callback);
        return () => {
          disposals += 1;
        };
      },
      onName: (callback: (event: SessionNameEvent) => void) => {
        nameListeners.push(callback);
        return () => {
          disposals += 1;
        };
      },
      onCleared: (callback: (event: SessionClearedEvent) => void) => {
        clearedListeners.push(callback);
        return () => {
          disposals += 1;
        };
      },
      onFinished: (callback: (event: SessionFinishedEvent) => void) => {
        finishedListeners.push(callback);
        return () => {
          disposals += 1;
        };
      },
      onBranch: (callback: (event: SessionBranchEvent) => void) => {
        branchListeners.push(callback);
        return () => {
          disposals += 1;
        };
      },
      onTicketIntent: (callback: (event: SessionTicketIntentEvent) => void) => {
        intentListeners.push(callback);
        return () => {
          disposals += 1;
        };
      },
      onMetrics: (callback: (event: SessionMetricsEvent) => void) => {
        metricsListeners.push(callback);
        return () => {
          disposals += 1;
        };
      },
      /*
        HIVE-87. The hook now tells main about a ticket it has confirmed, so
        this stub has to answer that verb too. Recorded rather than ignored:
        `notedTickets` is what the association test asserts against.
      */
      history: () => Promise.resolve([]),
      note: (request: SessionNoteRequest) => {
        notedTickets.push(request);
        return Promise.resolve();
      },
    },
  };
}

const emit = (event: SessionStatusEvent) =>
  act(() => {
    for (const listener of listeners) listener(event);
  });

const emitName = (event: SessionNameEvent) =>
  act(() => {
    for (const listener of nameListeners) listener(event);
  });

const emitBranch = (event: SessionBranchEvent) =>
  act(() => {
    for (const listener of branchListeners) listener(event);
  });

const emitMetrics = (event: SessionMetricsEvent) =>
  act(() => {
    for (const listener of metricsListeners) listener(event);
  });

/**
 * Emit an intent and let the Jira confirmation settle.
 *
 * `async act` rather than the synchronous one the other emitters use: this is
 * the only listener that awaits before it writes, so a synchronous `act` would
 * return before the store had been touched and every assertion would read the
 * state as it was a microtask ago.
 */
const emitIntent = async (event: SessionTicketIntentEvent) => {
  await act(async () => {
    for (const listener of intentListeners) listener(event);
    await Promise.resolve();
  });
};

beforeEach(() => {
  listeners = [];
  nameListeners = [];
  clearedListeners = [];
  finishedListeners = [];
  branchListeners = [];
  metricsListeners = [];
  intentListeners = [];
  notedTickets = [];
  issueCalls = [];
  issueReply = null;
  disposals = 0;
  useHiveStore.getState().reset();
    seedDemoFleet();
});

afterEach(() => {
  delete (window as { hive?: unknown }).hive;
  vi.clearAllMocks();
});

describe('useSessionStatus', () => {
  it('applies a status pushed from main', () => {
    withBridge();
    renderHook(() => useSessionStatus());

    // `terminated` is the ending main can actually observe — a pty exited.
    // `done` is a judgement about the work and is not main's to make (108).
    emit({ entityId: 'hero-refresh', status: 'terminated' });

    expect(useHiveStore.getState().entities['hero-refresh']!.status).toBe(
      'terminated',
    );
  });

  it('subscribes exactly once', () => {
    // One broadcast channel: a per-session hook would mean thirteen listeners
    // racing to ignore twelve messages each.
    withBridge();
    renderHook(() => useSessionStatus());

    expect(listeners).toHaveLength(1);
  });

  it('unsubscribes every channel on unmount', () => {
    withBridge();
    const { unmount } = renderHook(() => useSessionStatus());

    unmount();

    // Status, name (HIVE-61), cleared, finished (HIVE-93), branch, metrics and
    // ticket-intent (HIVE-78) — a leaked listener on any of them would keep
    // writing to a store the unmounted shell no longer renders, the cleared one
    // would go on minting sessions, and the finished one would go on bouncing
    // the user back to the orchestrator.
    expect(disposals).toBe(7);
  });

  it('applies a rename pushed from main', () => {
    /**
     * The pull half of HIVE-61: the name came off the agent's terminal title,
     * so a `/rename` inside Claude renames the row in the fleet view.
     */
    withBridge();
    renderHook(() => useSessionStatus());

    emitName({ entityId: 'hero-refresh', name: 'fix the login bug' });

    const entity = useHiveStore.getState().entities['hero-refresh'];
    if (!entity || !isSession(entity)) throw new Error('expected a fixture session');
    expect(entity.name).toBe('fix the login bug');
  });

  it('subscribes to names exactly once', () => {
    withBridge();
    renderHook(() => useSessionStatus());

    expect(nameListeners).toHaveLength(1);
  });

  it('records the usage a session reported', () => {
    withBridge();
    renderHook(() => useSessionStatus());

    emitMetrics({
      entityId: 'hero-refresh',
      metrics: { contextPct: 46, fiveHourPct: 12, sevenDayPct: 63 },
    });

    expect(useHiveStore.getState().metrics['hero-refresh']).toEqual({
      contextPct: 46,
      fiveHourPct: 12,
      sevenDayPct: 63,
    });
  });

  /**
   * Each status line payload is a complete observation, but its fields drop in
   * and out independently — `rate_limits` is absent until the first API
   * response. A later report that carries only context must not erase limits
   * the chip already knows.
   */
  it('merges a later partial report rather than replacing what it knows', () => {
    withBridge();
    renderHook(() => useSessionStatus());

    emitMetrics({ entityId: 'hero-refresh', metrics: { fiveHourPct: 12 } });
    emitMetrics({ entityId: 'hero-refresh', metrics: { contextPct: 46 } });

    expect(useHiveStore.getState().metrics['hero-refresh']).toEqual({
      fiveHourPct: 12,
      contextPct: 46,
    });
  });

  it('applies the branch main observed', () => {
    /**
     * The replacement for `feat/<id>` (HIVE-78). Main read this with
     * `git rev-parse` in the directory a hook payload named, so it is the
     * branch the agent is genuinely on rather than one the app invented.
     */
    withBridge();
    renderHook(() => useSessionStatus());

    emitBranch({
      entityId: 'hero-refresh',
      branch: 'feat/incorp-332-adhoc-scrape',
      cwd: '/repo/.claude/worktrees/incorp-332',
    });

    const entity = useHiveStore.getState().entities['hero-refresh'];
    if (!entity || !isSession(entity)) throw new Error('expected a fixture session');
    expect(entity.branch).toBe('feat/incorp-332-adhoc-scrape');
    expect(entity.cwd).toBe('/repo/.claude/worktrees/incorp-332');
  });

  it('renames and associates a session whose prompt named a real issue', async () => {
    /**
     * The whole mid-session path: the user typed "work on ABC-123" at their
     * agent, main matched the shape, Jira confirmed the issue, and the row is
     * now on that ticket's card in WORK under its key.
     */
    withBridge();
    issueReply = { ok: true, value: { key: 'HIVE-73' } };
    renderHook(() => useSessionStatus());

    await emitIntent({ entityId: 'rails-upgrade', key: 'HIVE-73' });

    const entity = useHiveStore.getState().entities['rails-upgrade'];
    if (!entity || !isSession(entity)) throw new Error('expected a fixture session');
    expect(entity.ticket).toBe('HIVE-73');
    expect(entity.name).toBe('HIVE-73');
    expect(issueCalls).toEqual(['HIVE-73']);
    /*
      And main was told, so the link survives a quit (HIVE-87). This is the only
      moment it can be: main matched the shape but does not decide whether the
      key is real, and the confirmation exists only on this side.
    */
    expect(notedTickets).toEqual([
      { entityId: 'rails-upgrade', ticket: 'HIVE-73' },
    ]);
  });

  it('ignores a key-shaped string Jira does not know', async () => {
    /**
     * `HTTP-404` passes the shape test perfectly, which is exactly why main is
     * not allowed to be the one that decides. A session silently renamed and
     * filed under a ticket that does not exist is a mistake with no visible
     * cause.
     */
    withBridge();
    issueReply = { ok: false, error: 'not found' };
    renderHook(() => useSessionStatus());

    await emitIntent({ entityId: 'rails-upgrade', key: 'HTTP-404' });

    const entity = useHiveStore.getState().entities['rails-upgrade'];
    if (!entity || !isSession(entity)) throw new Error('expected a fixture session');
    expect(entity.ticket).toBeUndefined();
    // It was still *asked* — the refusal is Jira's answer, not a skipped call.
    expect(issueCalls).toEqual(['HTTP-404']);
  });

  it('ignores an intent when the bridge itself failed', async () => {
    // `null` is the channel failing, which is not evidence about the issue.
    withBridge();
    issueReply = null;
    renderHook(() => useSessionStatus());

    await emitIntent({ entityId: 'rails-upgrade', key: 'HIVE-73' });

    const entity = useHiveStore.getState().entities['rails-upgrade'];
    if (!entity || !isSession(entity)) throw new Error('expected a fixture session');
    expect(entity.ticket).toBeUndefined();
  });

  it('does nothing at all in the browser build', () => {
    // No bridge is the demo surface, where every transcript is a recording and
    // no process exists to have a status.
    const { unmount } = renderHook(() => useSessionStatus());

    expect(listeners).toHaveLength(0);
    expect(() => unmount()).not.toThrow();
  });
});

describe('setSessionStatus', () => {
  it('leaves an unknown entity alone', () => {
    const before = useHiveStore.getState().entities;
    act(() => useHiveStore.getState().setSessionStatus('ghost', 'done'));

    expect(useHiveStore.getState().entities).toBe(before);
  });

  it('ignores agents, which have no pty this epic', () => {
    const before = useHiveStore.getState().entities['slack-agent'];
    act(() => useHiveStore.getState().setSessionStatus('slack-agent', 'done'));

    expect(useHiveStore.getState().entities['slack-agent']).toBe(before);
  });

  it('does not touch state when the status is unchanged', () => {
    // Identity matters: a no-op write would re-render every consumer of the
    // entity map on every idle tick.
    const id = 'hero-refresh';
    const entity = useHiveStore.getState().entities[id];
    if (!entity || !isSession(entity)) throw new Error('expected a fixture session');
    const before = useHiveStore.getState().entities;

    act(() => useHiveStore.getState().setSessionStatus(id, entity.status));

    expect(useHiveStore.getState().entities).toBe(before);
  });

  it('leaves the transcript untouched', () => {
    const id = 'hero-refresh';
    const lines = useHiveStore.getState().entities[id]!.lines;

    act(() => useHiveStore.getState().setSessionStatus(id, 'idle'));

    expect(useHiveStore.getState().entities[id]!.lines).toBe(lines);
  });
});

describe('renameSession', () => {
  it('leaves an unknown entity alone', () => {
    const before = useHiveStore.getState().entities;
    act(() => useHiveStore.getState().renameSession('ghost', 'whatever'));

    expect(useHiveStore.getState().entities).toBe(before);
  });

  it('ignores agents, which have no agent-set name', () => {
    const before = useHiveStore.getState().entities['slack-agent'];
    act(() => useHiveStore.getState().renameSession('slack-agent', 'nope'));

    expect(useHiveStore.getState().entities['slack-agent']).toBe(before);
  });

  it('does not touch state when the name is unchanged', () => {
    /**
     * Claude re-emits its title on repaint, so an unchanged name arrives
     * constantly. A write per repaint would re-render every consumer of the
     * entity map for a value that did not move.
     */
    const id = 'hero-refresh';
    act(() => useHiveStore.getState().renameSession(id, 'steady'));
    const before = useHiveStore.getState().entities;

    act(() => useHiveStore.getState().renameSession(id, 'steady'));

    expect(useHiveStore.getState().entities).toBe(before);
  });

  it('accepts a name the command line would refuse', () => {
    /**
     * The `--name` pattern governs what the app is willing to *send*. A name
     * read back off a terminal title is only ever rendered, so a sentence a
     * user typed into `/rename` must survive intact.
     */
    const id = 'hero-refresh';
    act(() => useHiveStore.getState().renameSession(id, 'fix "login" & logout'));

    const entity = useHiveStore.getState().entities[id];
    if (!entity || !isSession(entity)) throw new Error('expected a fixture session');
    expect(entity.name).toBe('fix "login" & logout');
  });

  it('leaves the id and branch alone', () => {
    // A name is a label; the id is an identity, and rekeying on a rename would
    // strand every reference to the session.
    const id = 'hero-refresh';
    const before = useHiveStore.getState().entities[id];
    if (!before || !isSession(before)) throw new Error('expected a fixture session');

    act(() => useHiveStore.getState().renameSession(id, 'renamed'));

    const after = useHiveStore.getState().entities[id];
    if (!after || !isSession(after)) throw new Error('expected a fixture session');
    expect(after.id).toBe(id);
    expect(after.branch).toBe(before.branch);
  });
});

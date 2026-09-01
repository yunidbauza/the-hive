import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isSession, terminalOf, type Session } from '@/types/entity';
import { isDesktop } from '@config/runtime';
import { requestSpawn } from '@lib/terminal/pty-transport';
import { sendToSession } from '@lib/terminal/session-input';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet, seedDemoProjectConfig } from '@tests/support/demo-fleet';

vi.mock('@config/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@config/runtime')>()),
  isDesktop: vi.fn(() => true),
}));

vi.mock('@lib/terminal/pty-transport', () => ({
  requestSpawn: vi.fn(() => Promise.resolve({ ok: true })),
  sessionChannelState: vi.fn(() => 'live'),
}));

vi.mock('@lib/terminal/session-input', () => ({
  sendToSession: vi.fn(() => ({ ok: true })),
}));

/**
 * `/clear` — the conversation ended, the terminal did not.
 *
 * The distinction this whole action exists to draw: `/exit` kills the process
 * and main reports `terminated`; `/clear` leaves the process running and Claude
 * starts a fresh conversation in it. Probed against real claude 2.1.225 —
 * `SessionEnd{reason:'clear'}` fires on a session sitting alive at its prompt,
 * and a new `session_id` follows it.
 */
const state = () => useHiveStore.getState();

const sessionAt = (id: string): Session => {
  const entity = state().entities[id];
  if (entity === undefined || !isSession(entity)) {
    throw new Error(`${id} is not a session`);
  }
  return entity;
};

describe('clearSession', () => {
  beforeEach(() => {
    state().reset();
    seedDemoFleet();
    seedDemoProjectConfig();
    useUiStore.getState().reset();
    vi.clearAllMocks();
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(requestSpawn).mockResolvedValue({ ok: true });
  });

  it('retires the session as done rather than terminated', () => {
    state().clearSession('hero-refresh');

    // Not `terminated`: nothing died. The user finished a piece of work.
    expect(sessionAt('hero-refresh').status).toBe('done');
  });

  it('opens a successor with a new id', () => {
    const successorId = state().clearSession('hero-refresh');

    expect(successorId).not.toBeNull();
    expect(successorId).not.toBe('hero-refresh');
    expect(sessionAt(successorId!).status).toBe('idle');
  });

  /**
   * The load-bearing assertion. Both rows name one pty, which is what stops the
   * successor spawning a second process in the same directory — and what lets
   * `center-stage.tsx` keep the same xterm instance across the swap instead of
   * wiping the user's terminal the instant they type `/clear`.
   */
  it('puts the successor in the same terminal', () => {
    const successorId = state().clearSession('hero-refresh')!;

    expect(terminalOf(sessionAt(successorId))).toBe('hero-refresh');
    expect(terminalOf(sessionAt('hero-refresh'))).toBe('hero-refresh');
  });

  it('never reuses an id the fleet is still showing', () => {
    /**
     * The reported bug: two rows called `sess-01`, one `done` and one live.
     *
     * `spawnCounter` is module state and the entities are store state, so the
     * two can fall out of step — a module re-evaluation (dev HMR does exactly
     * this) puts the counter back to `0` while the rows it already named are
     * still on screen. The next id minted is then one that is already taken.
     *
     * Which is worse than a cosmetic clash: `entities` is keyed by id, so a
     * successor colliding with the session it just retired overwrites that
     * session with its own replacement, and `order` carries one id twice.
     *
     * Simulated by spawning up to the ids the seeded fleet already holds, which
     * is what a stale counter produces, rather than by reaching into module
     * state the store does not expose.
     */
    const taken = new Set(Object.keys(state().entities));

    const first = state().spawnSession('nova-web', 'one');
    const cleared = state().clearSession(first!)!;
    const second = state().spawnSession('nova-web', 'two');

    for (const id of [first, cleared, second]) {
      expect(id).not.toBeNull();
      expect(taken.has(id!)).toBe(false);
      taken.add(id!);
    }

    // Every row is still reachable under its own key — nothing was overwritten.
    expect(new Set(state().order).size).toBe(state().order.length);
    expect(sessionAt(first!).status).toBe('done');
    expect(sessionAt(cleared!).status).not.toBe('done');
  });

  it('skips an id already on the fleet, however it got there', () => {
    /**
     * The collision reproduced directly rather than inferred.
     *
     * A row is planted under the exact id a counter starting from zero will
     * mint first — which is the state dev HMR leaves behind when it
     * re-evaluates the store module and the rows outlive the counter. Without
     * the guard, `spawnSession` returns `sess-01`, writes over the planted row,
     * and the fleet shows one name twice.
     */
    const planted = sessionAt('hero-refresh');
    useHiveStore.setState((current) => ({
      entities: { ...current.entities, 'sess-01': { ...planted, id: 'sess-01' } },
      order: [...current.order, 'sess-01'],
    }));

    const spawned = state().spawnSession('nova-web', 'after the collision')!;

    expect(spawned).not.toBe('sess-01');
    // The planted row survived rather than being overwritten by its namesake.
    expect(sessionAt('sess-01').task).toBe(planted.task);
  });

  it('never asks for a process — there already is one', () => {
    state().clearSession('hero-refresh');

    expect(requestSpawn).not.toHaveBeenCalled();
  });

  it('carries the terminal’s properties to the successor', () => {
    const before = sessionAt('hero-refresh');
    const successor = sessionAt(state().clearSession('hero-refresh')!);

    // These describe the terminal, and `/clear` changes none of them.
    expect(successor.project).toBe(before.project);
    expect(successor.branch).toBe(before.branch);
  });

  /**
   * The successor is a *new conversation*. Carrying the old name or task
   * forward would make it look like a continuation of work it cannot see —
   * Claude has just wiped its own context.
   *
   * **The PR left this list with the field** (HIVE-100). It used to assert
   * `successor.pr` was null, and that assertion was only ever true because
   * nothing wrote `Session.pr` in the first place. A pull request belongs to a
   * *branch*, and the test above pins that the successor keeps the branch — so
   * the honest answer is that it owns the same PR, which is what resolving from
   * the live list now produces. Name and task are the two things that really do
   * belong to the conversation rather than the terminal.
   */
  it('does not carry the finished conversation’s name or task', () => {
    useHiveStore.setState((current) => ({
      entities: {
        ...current.entities,
        'hero-refresh': {
          ...sessionAt('hero-refresh'),
          name: 'fix the login bug',
        },
      },
    }));

    const successor = sessionAt(state().clearSession('hero-refresh')!);

    expect(successor.name).toBeUndefined();
    expect(successor.task).toBe('');
    expect(successor.lines).toEqual([]);
  });

  /**
   * The rails read `order` positionally. A terminal the user has had open all
   * day jumping to the bottom of the list because they typed `/clear` would be
   * a navigation surprise with no visible cause.
   */
  it('puts the successor where the retired session sat', () => {
    const before = state().order.indexOf('hero-refresh');
    const successorId = state().clearSession('hero-refresh')!;

    expect(state().order.indexOf(successorId)).toBe(before);
    expect(state().order.indexOf('hero-refresh')).toBe(before + 1);
  });

  it('moves the user to the successor when the retired row was on screen', () => {
    useUiStore.getState().openTab('hero-refresh');

    const successorId = state().clearSession('hero-refresh')!;

    // The user is looking at this terminal — they just typed into it.
    expect(useUiStore.getState().activeTab).toBe(successorId);
  });

  it('leaves the view alone when the user was looking elsewhere', () => {
    useUiStore.getState().openTab('lead-form');

    state().clearSession('hero-refresh');

    expect(useUiStore.getState().activeTab).toBe('lead-form');
  });

  it('names the retired session in the console, the only place left that does', () => {
    state().clearSession('hero-refresh');

    const transcript = state()
      .orchLines.map((entry) => entry.text)
      .join('\n');
    expect(transcript).toContain('done — cleared');
  });

  it('does not name the successor by id — it has no name yet (HIVE-91)', () => {
    const successorId = state().clearSession('hero-refresh')!;

    const transcript = state()
      .orchLines.map((entry) => entry.text)
      .join('\n');
    expect(transcript).toContain('started in the same terminal');
    expect(transcript).not.toContain(successorId);
  });

  describe('the cases it refuses', () => {
    /**
     * A hook can arrive for a row the user removed a moment earlier. The honest
     * answer to that race is to do nothing.
     */
    it('is a no-op for an unknown id', () => {
      const before = state().order.length;

      expect(state().clearSession('no-such-session')).toBeNull();
      expect(state().order).toHaveLength(before);
    });

    it('is a no-op for an agent', () => {
      expect(state().clearSession('slack-agent')).toBeNull();
    });

    it('is a no-op for a session that already ended', () => {
      state().setSessionStatus('hero-refresh', 'terminated');

      expect(state().clearSession('hero-refresh')).toBeNull();
      expect(sessionAt('hero-refresh').status).toBe('terminated');
    });

    it('is a no-op for a terminal whose last session ended', () => {
      const successorId = state().clearSession('hero-refresh')!;
      state().setSessionStatus(successorId, 'terminated');

      // Nothing live is left in this terminal to retire.
      expect(state().clearSession('hero-refresh')).toBeNull();
    });
  });

  /**
   * Every hook a session sends carries the id its pty was spawned with, and
   * that value never changes — the pty never restarts. So a terminal cleared
   * twice names the *first* row both times, and the app has to resolve that to
   * whichever row is live.
   *
   * This is what `/clear` doing nothing looked like: `SessionEnd{clear}` marked
   * the row done, and the `SessionStart{source:'clear'}` immediately behind it
   * mapped to `idle` and un-marked it — leaving two idle rows, both openable,
   * one of them showing a blank stage.
   */
  describe('events keep arriving under the original id', () => {
    it('does not let the SessionStart behind a clear un-retire the row', () => {
      const successorId = state().clearSession('hero-refresh')!;

      // What Claude sends a beat later, on the same header.
      state().setSessionStatus('hero-refresh', 'idle');

      expect(sessionAt('hero-refresh').status).toBe('done');
      expect(sessionAt(successorId).status).toBe('idle');
    });

    it('routes later statuses to the successor, not the retired row', () => {
      const successorId = state().clearSession('hero-refresh')!;

      state().setSessionStatus('hero-refresh', 'working');

      expect(sessionAt(successorId).status).toBe('working');
      expect(sessionAt('hero-refresh').status).toBe('done');
    });

    it('routes a rename to the successor — the old name is history', () => {
      const successorId = state().clearSession('hero-refresh')!;

      state().renameSession('hero-refresh', 'something-new');

      expect(sessionAt(successorId).name).toBe('something-new');
      expect(sessionAt('hero-refresh').name).toBeUndefined();
    });
  });

  /**
   * Claude names a session by writing it into the terminal *title*, and repaints
   * that title continuously. `/clear` starts an unnamed conversation but does
   * not reset the title, so the finished session's name keeps arriving — and
   * without a guard the successor inherits the identity of the work that just
   * ended.
   */
  describe('the title a cleared conversation leaves behind', () => {
    const named = (id: string, name: string) => {
      useHiveStore.setState((current) => ({
        entities: { ...current.entities, [id]: { ...sessionAt(id), name } },
      }));
    };

    it('does not give the successor the finished session’s name', () => {
      named('hero-refresh', 'lolo');
      const successorId = state().clearSession('hero-refresh')!;

      // The title stream, still advertising the old name.
      state().renameSession('hero-refresh', 'lolo');

      expect(sessionAt(successorId).name).toBeUndefined();
    });

    /**
     * Suppressed until something *different* arrives, not merely once — the
     * title repaints many times a second, so a one-shot guard would let the
     * second emission straight through.
     */
    it('keeps refusing it however many times it repeats', () => {
      named('hero-refresh', 'lolo');
      const successorId = state().clearSession('hero-refresh')!;

      for (let i = 0; i < 5; i += 1) {
        state().renameSession('hero-refresh', 'lolo');
      }

      expect(sessionAt(successorId).name).toBeUndefined();
    });

    it('accepts the name once the agent really renames itself', () => {
      named('hero-refresh', 'lolo');
      const successorId = state().clearSession('hero-refresh')!;
      state().renameSession('hero-refresh', 'lolo');

      state().renameSession('hero-refresh', 'pepe');

      expect(sessionAt(successorId).name).toBe('pepe');
    });

    /**
     * And stops being suspicious afterwards. A user who renames to `pepe` and
     * then back to `lolo` means it, and the terminal is no longer stale.
     */
    it('stops suppressing once the terminal has moved on', () => {
      named('hero-refresh', 'lolo');
      const successorId = state().clearSession('hero-refresh')!;
      state().renameSession('hero-refresh', 'pepe');

      /*
        A different name released the suppression, so `lolo` is no longer
        withheld from the successor. It arrives here as a `/rename` because the
        successor is by now named `pepe`, and only a deliberate rename may
        replace a real name — the suppression being released is what this test is
        about, and it is what the assertion still turns on.
      */
      state().renameSession('hero-refresh', 'lolo', 'rename');

      expect(sessionAt(successorId).name).toBe('lolo');
    });

    it('goes on suppressing it against the agent’s own repaints', () => {
      // The guard's original job, unchanged: the retired conversation's title
      // must not name its successor, however many times Claude repaints it.
      named('hero-refresh', 'lolo');
      const successorId = state().clearSession('hero-refresh')!;

      state().renameSession('hero-refresh', 'lolo');
      state().renameSession('hero-refresh', 'lolo');

      expect(sessionAt(successorId).name).toBeUndefined();
    });

    it('leaves the retired row’s own name intact', () => {
      named('hero-refresh', 'lolo');
      state().clearSession('hero-refresh');

      // ENDED still says what the finished work was called.
      expect(sessionAt('hero-refresh').name).toBe('lolo');
    });

    /**
     * A pty exit still lands. `terminated` arrives on the same header as
     * everything else, and it belongs to whichever conversation was running.
     */
    it('routes a pty exit to the successor', () => {
      const successorId = state().clearSession('hero-refresh')!;

      state().setSessionStatus('hero-refresh', 'terminated');

      expect(sessionAt(successorId).status).toBe('terminated');
      expect(sessionAt('hero-refresh').status).toBe('done');
    });

    it('retires the successor when the terminal is cleared again', () => {
      const first = state().clearSession('hero-refresh')!;
      const second = state().clearSession('hero-refresh')!;

      expect(second).not.toBe(first);
      expect(sessionAt(first).status).toBe('done');
      expect(sessionAt(second).status).toBe('idle');
      expect(terminalOf(sessionAt(second))).toBe('hero-refresh');
    });
  });

  /**
   * Everything that reaches the pty must address the **terminal**.
   *
   * `pty-transport` keys its channels by the id `createPtyTransport` was given,
   * which is `terminalOf(session)`. A successor's row id is not that id, so any
   * path still passing the row id talks to a channel that does not exist.
   */
  describe('addressing the pty after a clear', () => {
    it('sends a message on the terminal id, not the row id', () => {
      const successorId = state().clearSession('hero-refresh')!;
      vi.mocked(sendToSession).mockClear();

      state().sendToEntity(successorId, 'hello');

      /**
       * `sess-01`, not `sess-02`. Addressed by row id this refused every
       * message — "has no live session — open it to start one" — for a pty that
       * was running and perfectly typable.
       */
      expect(sendToSession).toHaveBeenCalledWith('hero-refresh', 'hello');
    });
  });

  /**
   * A terminal cleared every twenty minutes for a working day is twenty rows of
   * history in a table whose job is showing what is running.
   */
  describe('the done cap', () => {
    it('drops the oldest done rows past the cap', () => {
      let current = 'hero-refresh';
      for (let i = 0; i < 25; i += 1) {
        current = state().clearSession(current)!;
      }

      const done = state().order.filter((id) => {
        const entity = state().entities[id];
        return entity !== undefined && isSession(entity) && entity.status === 'done';
      });

      expect(done).toHaveLength(20);
    });

    it('drops the dropped rows’ entities too, rather than leaking them', () => {
      let current = 'hero-refresh';
      for (let i = 0; i < 25; i += 1) {
        current = state().clearSession(current)!;
      }

      // An entity nothing lists is a leak. `order` is the only index.
      const listed = new Set(state().order);
      for (const id of Object.keys(state().entities)) {
        if (state().agentOrder.includes(id)) continue;
        expect(listed.has(id)).toBe(true);
      }
    });

    /**
     * Only `done` rows are capped. A `terminated` row is the only record that a
     * process existed and died; a cleared session's successor is right there.
     */
    it('never drops a terminated row', () => {
      state().setSessionStatus('lead-form', 'terminated');

      let current = 'hero-refresh';
      for (let i = 0; i < 25; i += 1) {
        current = state().clearSession(current)!;
      }

      expect(state().order).toContain('lead-form');
    });
  });
});

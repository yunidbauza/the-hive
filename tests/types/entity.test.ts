import { describe, expect, it } from 'vitest';

import {
  endedReason,
  entityLabel,
  isEnded,
  isTerminated,
  recencyOf,
  type Agent,
  type Session,
} from '@/types/entity';

/**
 * What a session is called on screen (HIVE-61).
 *
 * One function behind every label site, so the fallback is decided once. Its
 * failure mode is quiet and total — a wrong `??` renders an empty label and
 * every session row in the app goes blank — which is why it is pinned here as
 * well as driven in a browser.
 */

const session = (over: Partial<Session> = {}): Session => ({
  kind: 'session',
  id: 'sess-01',
  project: 'nova-web',
  branch: 'feat/sess-01',
  status: 'idle',
  task: '',
  cost: '$0.00',
  lines: [],
  ...over,
});

const agent: Agent = {
  kind: 'agent',
  id: 'slack-agent',
  icon: 'ph-slack-logo',
  sub: '#eng',
  task: '',
  status: 'sleeping',
  wake: { on: [] },
  lines: [],
};

describe('entityLabel', () => {
  it('falls back to the id when the agent has reported no name', () => {
    // Every fixture, and every real session in its first second.
    expect(entityLabel(session())).toBe('sess-01');
  });

  it('prefers the name once one arrives', () => {
    expect(entityLabel(session({ name: 'fix the login bug' }))).toBe(
      'fix the login bug',
    );
  });

  it('keeps a name the command line would refuse', () => {
    /**
     * `SESSION_NAME_PATTERN` governs what may be *sent* as `--name`. A name read
     * back off a terminal title is only ever rendered, so a sentence typed into
     * `/rename` must survive whole.
     */
    expect(entityLabel(session({ name: 'fix "login" & logout' }))).toBe(
      'fix "login" & logout',
    );
  });

  it('falls back for an empty name rather than rendering nothing', () => {
    // The blank-label failure this function exists to make impossible.
    expect(entityLabel(session({ name: '' }))).toBe('sess-01');
  });

  it('uses an agent’s id — agents have no agent-set name', () => {
    expect(entityLabel(agent)).toBe('slack-agent');
  });
});

/**
 * Two endings, three reasons (HIVE-87, HIVE-93).
 *
 * `closed` used to be a third status, carrying an affordance ("click me to
 * resume") alongside a retention rule. Both were moved off the status — the
 * affordance to a `resume` control driven by `resumable`, the "how" to
 * `endedBy` — so the user-facing vocabulary is two words while the code keeps
 * every distinction it needs. These assert that the distinctions survived the
 * fold rather than being lost with the word.
 */
describe('endings', () => {
  it('counts both as endings', () => {
    expect(isEnded('done')).toBe(true);
    expect(isEnded('terminated')).toBe(true);
  });

  it('leaves live statuses alone', () => {
    expect(isEnded('working')).toBe(false);
    expect(isEnded('waiting')).toBe(false);
    expect(isEnded('idle')).toBe(false);
  });

  it('gives each deliberate ending its own sentence', () => {
    /*
      One status, three reasons. Losing this is what the fold risked: a single
      `done` sentence would have told a user whose session finished with /done
      that its terminal "continues as a new session", which is false twice over.
    */
    const reasons = new Set([
      endedReason(session({ id: 'sess-01', status: 'done', endedBy: 'cleared' })),
      endedReason(session({ id: 'sess-01', status: 'done', endedBy: 'finished' })),
      endedReason(
        session({ id: 'sess-01', status: 'done', endedBy: 'app-closed' }),
      ),
      endedReason(session({ id: 'sess-01', status: 'terminated' })),
    ]);
    expect(reasons.size).toBe(4);
  });

  it('names each one', () => {
    expect(
      endedReason(session({ id: 'sess-01', status: 'terminated' })),
    ).toBe('sess-01 has terminated — its process is gone');
    expect(
      endedReason(session({ id: 'sess-01', status: 'done', endedBy: 'cleared' })),
    ).toBe('sess-01 was cleared — its terminal continues as a new session');
    expect(
      endedReason(session({ id: 'sess-01', status: 'done', endedBy: 'finished' })),
    ).toBe('sess-01 finished with /done — resume to pick it up');
    expect(
      endedReason(
        session({ id: 'sess-01', status: 'done', endedBy: 'app-closed' }),
      ),
    ).toBe('sess-01 was open when The Hive last closed — resume to pick it back up');
  });

  it('reads a done row with no endedBy as a cleared one', () => {
    /*
      Every `done` row written before the field existed was a `/clear`, because
      nothing else produced the status.
    */
    expect(endedReason(session({ id: 'sess-01', status: 'done' }))).toBe(
      'sess-01 was cleared — its terminal continues as a new session',
    );
  });
});

/**
 * Whose process is actually gone (HIVE-93).
 *
 * `isTerminated` drives the "this terminal has died" notice and disables stdin,
 * so it has to answer about the *pty* rather than the row. A cleared session is
 * the one ending whose pty outlives it — the successor is using it.
 */
describe('isTerminated', () => {
  it('is true for a session that was observed to die', () => {
    expect(isTerminated(session({ status: 'terminated' }))).toBe(true);
  });

  it('is true for a session finished with /done — its pty is gone', () => {
    expect(
      isTerminated(session({ status: 'done', endedBy: 'finished' })),
    ).toBe(true);
  });

  it('is true for a row restored from a closed app', () => {
    expect(
      isTerminated(session({ status: 'done', endedBy: 'app-closed' })),
    ).toBe(true);
  });

  it('is false for a cleared session — the successor holds its terminal', () => {
    expect(isTerminated(session({ status: 'done', endedBy: 'cleared' }))).toBe(
      false,
    );
  });

  it('is false while the session is still running', () => {
    expect(isTerminated(session({ status: 'working' }))).toBe(false);
  });
});

/**
 * When a row last mattered — the fleet table's sort key, and now the value its
 * `LAST USED` column reads.
 *
 * The fallback chain is the whole function and every link of it was a bug once:
 * `endedAt` outranks the rest because a finished row's last moment is when it
 * finished; `resumedAt` outranks `createdAt` because a resume is the row
 * mattering *again*, and without it a session resumed from this morning sorted
 * below everything spawned since. Zero last, so a row nobody timestamped never
 * claims to be the newest thing on the table.
 */
describe('recencyOf', () => {
  it('prefers when a row ended', () => {
    expect(
      recencyOf(session({ createdAt: 100, resumedAt: 200, endedAt: 300 })),
    ).toBe(300);
  });

  it('prefers a resume over the original start', () => {
    expect(recencyOf(session({ createdAt: 100, resumedAt: 200 }))).toBe(200);
  });

  it('falls back to when the row started', () => {
    expect(recencyOf(session({ createdAt: 100 }))).toBe(100);
  });

  it('answers zero for a row nobody timestamped', () => {
    expect(recencyOf(session())).toBe(0);
  });
});

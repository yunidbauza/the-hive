import { describe, expect, it } from 'vitest';

import { entityLabel, type Agent, type Session } from '@/types/entity';

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
  project: 'apfm-web',
  branch: 'feat/sess-01',
  status: 'idle',
  task: '',
  pr: null,
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
  status: 'online',
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

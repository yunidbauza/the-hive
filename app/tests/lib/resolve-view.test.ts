import { describe, expect, it } from 'vitest';

import type { Agent, Session } from '@/types/entity';
import { isEntityView, resolveView, type ViewState } from '@/lib/resolve-view';

/**
 * The view-state machine, tested exhaustively (story 040). The component's only
 * job is to render what this returns, so every state and every precedence rule
 * is pinned here rather than inferred from JSX.
 */

const session = { kind: 'session', id: 'hero-refresh' } as Session;
const agent = { kind: 'agent', id: 'slack-agent' } as Agent;

describe('resolveView', () => {
  it('shows the orchestrator for the reserved tab', () => {
    expect(resolveView({ activeTab: 'orch', picker: false, entity: null })).toBe(
      'orchestrator',
    );
  });

  it('shows a session for a session entity', () => {
    expect(
      resolveView({ activeTab: 'hero-refresh', picker: false, entity: session }),
    ).toBe('session');
  });

  it('shows an agent for an agent entity', () => {
    expect(
      resolveView({ activeTab: 'slack-agent', picker: false, entity: agent }),
    ).toBe('agent');
  });

  it('shows the picker whenever it is open', () => {
    expect(resolveView({ activeTab: 'orch', picker: true, entity: null })).toBe(
      'picker',
    );
  });

  describe('precedence', () => {
    it('lets the picker win over every underlying view', () => {
      /**
       * The picker is a full-stage overlay that deliberately does not change
       * `activeTab` — closing it has to return the user to what they were
       * looking at, which only works if the tab underneath is untouched.
       */
      for (const entity of [null, session, agent]) {
        expect(
          resolveView({ activeTab: entity?.id ?? 'orch', picker: true, entity }),
        ).toBe('picker');
      }
    });

    it('falls back to the orchestrator when the tab names no entity', () => {
      // A session can be removed while its tab is open. Stranding the user on a
      // blank stage is worse than sending them home.
      expect(
        resolveView({ activeTab: 'deleted-session', picker: false, entity: null }),
      ).toBe('orchestrator');
    });
  });

  it('resolves to exactly one state for every input combination', () => {
    const states = new Set<ViewState>();

    for (const picker of [true, false]) {
      for (const entity of [null, session, agent]) {
        for (const activeTab of ['orch', 'hero-refresh', 'slack-agent', 'gone']) {
          states.add(resolveView({ activeTab, picker, entity }));
        }
      }
    }

    // All four states are reachable, and nothing else is.
    expect([...states].sort()).toEqual([
      'agent',
      'orchestrator',
      'picker',
      'session',
    ]);
  });
});

describe('isEntityView', () => {
  it('is true exactly for the views that show a terminal and meta bar', () => {
    expect(isEntityView('session')).toBe(true);
    expect(isEntityView('agent')).toBe(true);
    expect(isEntityView('orchestrator')).toBe(false);
    expect(isEntityView('picker')).toBe(false);
  });
});

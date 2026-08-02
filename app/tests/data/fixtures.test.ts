import { describe, expect, it } from 'vitest';

import { createInitialState } from '@/data/fixtures';
import { isAgent, isSession } from '@/types/entity';

describe('createInitialState', () => {
  /**
   * The factory exists so every test starts from a clean copy. If it returned a
   * shared object, one test mutating a transcript would leak into the next and
   * the failure would surface somewhere unrelated.
   */
  it('returns a fresh copy each call', () => {
    const first = createInitialState();
    const second = createInitialState();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.entities).not.toBe(second.entities);
    expect(first.entities['hero-refresh']).not.toBe(
      second.entities['hero-refresh'],
    );
  });

  it('does not share nested arrays between calls', () => {
    const first = createInitialState();
    first.entities['hero-refresh'].lines.push({ text: 'leak', color: 'red' });
    first.tickets.push({ key: 'X-1', status: 'To Do', title: 'x', sessions: [] });

    const second = createInitialState();

    expect(
      second.entities['hero-refresh'].lines.some((l) => l.text === 'leak'),
    ).toBe(false);
    expect(second.tickets).toHaveLength(8);
  });

  it('registers every session and agent in entities', () => {
    const state = createInitialState();

    for (const id of state.order) {
      expect(isSession(state.entities[id])).toBe(true);
    }
    for (const id of state.agentOrder) {
      expect(isAgent(state.entities[id])).toBe(true);
    }
  });

  it('gives every agent the online status', () => {
    const state = createInitialState();

    for (const id of state.agentOrder) {
      expect(state.entities[id].status).toBe('online');
    }
  });

  it('points every PR at a session that exists', () => {
    const state = createInitialState();

    for (const pr of state.prs) {
      expect(state.entities[pr.session]).toBeDefined();
    }
  });

  it('points every ticket at sessions that exist', () => {
    const state = createInitialState();

    for (const ticket of state.tickets) {
      for (const sessionId of ticket.sessions) {
        expect(state.entities[sessionId]).toBeDefined();
      }
    }
  });

  it('points every notification at an entity that exists', () => {
    const state = createInitialState();

    for (const notif of state.notifs) {
      expect(state.entities[notif.target]).toBeDefined();
    }
  });

  it('keeps a session PR consistent with the PR list', () => {
    const state = createInitialState();

    for (const id of state.order) {
      const session = state.entities[id];
      if (!isSession(session) || !session.pr) continue;

      const listed = state.prs.find((pr) => pr.n === session.pr!.n);
      // #31 is referenced by ecs-scaling but is not one of the four PRs the
      // concept surfaces in the PRs panel, so absence is allowed — presence
      // must agree.
      if (listed) expect(listed.session).toBe(id);
    }
  });
});

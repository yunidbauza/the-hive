import { describe, expect, it } from 'vitest';

import { createInitialState } from '@/data/fixtures';

/**
 * What the app still seeds, and — mostly — what it must not.
 *
 * This file used to assert the integrity of a nine-slice demo dataset: that
 * every ticket named a session that existed, every notification pointed at a
 * real entity, every session's PR agreed with the PR list. Those invariants
 * mattered because the dataset was loaded into the store at boot and was
 * therefore what the user saw.
 *
 * Seven of those slices are gone. Sessions, agents, projects, tickets and the
 * orchestrator banner now come from PTYs, the config file and Jira, and `prs`
 * comes from a `gh` sweep of the configured repositories — so the
 * cross-references that held the dataset together no longer have two ends: the
 * notifications below name sessions that will not exist until a user starts
 * one. That is accepted and deliberate — the two slices left have no live
 * producer yet, and an empty inbox with no path to filling it would be a worse
 * lie than a stale sample row.
 *
 * So the assertions changed shape. What is tested now is the *boundary*: two
 * slices, no more, and no seeded fleet hiding behind them.
 */
describe('createInitialState', () => {
  /**
   * The factory exists so every test starts from a clean copy. If it returned a
   * shared object, one test mutating a list would leak into the next and the
   * failure would surface somewhere unrelated.
   */
  it('returns a fresh copy each call', () => {
    const first = createInitialState();
    const second = createInitialState();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.notifs).not.toBe(second.notifs);
    expect(first.notifs[0]).not.toBe(second.notifs[0]);
  });

  it('does not share nested arrays between calls', () => {
    const first = createInitialState();
    first.notifs.push({
      icon: 'ph-hand-palm',
      tone: 'amber',
      title: 'leak',
      sub: 'leak',
      time: '0m',
      unread: true,
      target: 'nobody',
    });

    const second = createInitialState();

    expect(second.notifs.some((notif) => notif.title === 'leak')).toBe(false);
  });

  /**
   * The regression guard, and the reason this file still exists.
   *
   * Adding any of these six back here puts them straight into the store at
   * boot — which is precisely the bug: a header counting sessions nobody
   * started, a projects tree listing repositories nobody mapped, and eight
   * sample tickets painted for a frame before the real Jira read replaced them.
   */
  it('seeds exactly one slice, and no fleet', () => {
    const state = createInitialState();

    expect(Object.keys(state).sort()).toEqual(['notifs']);

    for (const slice of ['entities', 'order', 'agentOrder', 'projects', 'tickets', 'prs', 'orchLines']) {
      expect(state).not.toHaveProperty(slice);
    }
  });

  it('still supplies the one panel that has no live producer', () => {
    const state = createInitialState();

    expect(state.notifs.length).toBeGreaterThan(0);
  });
});

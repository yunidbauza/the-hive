import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deleteSkill,
  loadSkills,
  readSkill,
  saveSkill,
  skillsSnapshot,
  subscribeSkills,
} from '@/lib/skills';

import type { SkillsSnapshot } from '@shared/skills-contract';

/**
 * The renderer's view of the skills tree (HIVE-96).
 *
 * The shape — and the asymmetry between a failed read and a failed write — is
 * `project-config.ts`'s, for the reason stated there: a broken read is a broken
 * channel and must leave the app permissive, while a refused **write** means
 * only that nothing on disk changed, so the snapshot already held is still
 * exactly true. Clearing it there was a real bug; these tests are what stop it
 * being reintroduced here.
 */

const snapshot = (names: string[]): SkillsSnapshot => ({
  skills: names.map((name) => ({
    name,
    description: 'does a thing',
    valid: true as const,
  })),
  invalid: [],
  skillsRoot: '/home/u/.hive/skills',
});

const bridge = (skills: Record<string, unknown>): void => {
  (window as unknown as { hive?: unknown }).hive = { skills };
};

beforeEach(() => {
  delete (window as unknown as { hive?: unknown }).hive;
  vi.restoreAllMocks();
});

describe('the skills store', () => {
  it('asks nothing, and stays empty, without a bridge', async () => {
    // The browser target has no bridge at all. Story 083's rule: feature-detect
    // the bridge, never the user agent.
    await loadSkills();

    expect(skillsSnapshot()).toBeNull();
  });

  it('publishes what main answered, and notifies subscribers', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSkills(listener);
    bridge({ list: () => Promise.resolve(snapshot(['standup'])) });

    await loadSkills();

    expect(skillsSnapshot()?.skills.map((s) => s.name)).toEqual(['standup']);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('stops notifying a listener that unsubscribed', async () => {
    const listener = vi.fn();
    subscribeSkills(listener)();
    bridge({ list: () => Promise.resolve(snapshot([])) });

    await loadSkills();

    expect(listener).not.toHaveBeenCalled();
  });

  it('nulls the snapshot when the channel itself fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bridge({ list: () => Promise.reject(new Error('channel down')) });

    await loadSkills();

    expect(skillsSnapshot()).toBeNull();
  });

  it('takes the snapshot a save returns, without a second read', async () => {
    const write = vi.fn(() => Promise.resolve(snapshot(['standup'])));
    bridge({ list: () => Promise.resolve(snapshot([])), write });
    await loadSkills();

    await saveSkill('standup', 'body');

    expect(write).toHaveBeenCalledWith({ name: 'standup', body: 'body' });
    expect(skillsSnapshot()?.skills.map((s) => s.name)).toEqual(['standup']);
  });

  it('keeps the last good snapshot when a write is refused', async () => {
    /*
      Nothing on disk changed, so what the pane already holds is still true.
      Emptying it here would be the `project-config.ts` bug again: a guard
      rejects a payload, the list empties, and the surface starts answering
      questions from a snapshot it does not have.
    */
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bridge({
      list: () => Promise.resolve(snapshot(['standup'])),
      write: () => Promise.reject(new Error('refused')),
    });
    await loadSkills();

    await saveSkill('standup', 'new body');

    expect(skillsSnapshot()?.skills.map((s) => s.name)).toEqual(['standup']);
  });

  it('takes the snapshot a delete returns', async () => {
    bridge({
      list: () => Promise.resolve(snapshot(['standup'])),
      remove: () => Promise.resolve(snapshot([])),
    });
    await loadSkills();

    await deleteSkill('standup');

    expect(skillsSnapshot()?.skills).toEqual([]);
  });

  it('reads one file for the editor without touching the snapshot', async () => {
    const file = {
      name: 'standup',
      body: 'body',
      path: '/home/u/.hive/skills/standup/SKILL.md',
    };
    bridge({
      list: () => Promise.resolve(snapshot(['standup'])),
      read: () => Promise.resolve(file),
    });
    await loadSkills();

    await expect(readSkill('standup')).resolves.toEqual(file);
    expect(skillsSnapshot()?.skills.map((s) => s.name)).toEqual(['standup']);
  });

  it('answers null for a read with no bridge, rather than throwing', async () => {
    await expect(readSkill('standup')).resolves.toBeNull();
  });
});

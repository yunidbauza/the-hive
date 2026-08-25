import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deleteSkill,
  frontmatterName,
  loadSkills,
  readSkill,
  renameSkill,
  saveSkill,
  skillNameProblem,
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

  it('reports a refused write instead of resolving as success', async () => {
    /*
      The caller has a success path — flip the badge to "saved", empty the
      editor after a delete — and running it unconditionally told the user a
      write happened when it had not. Resolving with the reason is what lets
      the pane show the failure instead of hiding it.
    */
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bridge({
      list: () => Promise.resolve(snapshot([])),
      write: () => Promise.reject(new Error('EACCES: permission denied')),
    });
    await loadSkills();

    await expect(saveSkill('standup', 'body')).resolves.toBe(
      'EACCES: permission denied',
    );
  });

  it('reports a refused delete the same way', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bridge({
      list: () => Promise.resolve(snapshot(['standup'])),
      remove: () => Promise.reject(new Error('ENOTEMPTY')),
    });
    await loadSkills();

    await expect(deleteSkill('standup')).resolves.toBe('ENOTEMPTY');
  });

  it('resolves null when a write succeeds', async () => {
    bridge({
      list: () => Promise.resolve(snapshot([])),
      write: () => Promise.resolve(snapshot(['standup'])),
    });
    await loadSkills();

    await expect(saveSkill('standup', 'body')).resolves.toBeNull();
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

/**
 * Renaming, which is two bridge calls and one user action (HIVE-99).
 *
 * The move and the write are separate verbs on purpose — `skills.rename` moves
 * a folder and does not touch what is inside it — so this module is where they
 * become one thing. What these tests pin is the seam: the order, the single
 * publication at the end, and the fact that a half-done rename is still put on
 * screen rather than swallowed.
 */
describe('renameSkill', () => {
  const body = '---\nname: stand-up\ndescription: does a thing\n---\nDo it.\n';

  it('moves first, then writes the new body under the new name', async () => {
    const calls: string[] = [];
    const rename = vi.fn(() => {
      calls.push('rename');
      return Promise.resolve(snapshot([]));
    });
    const write = vi.fn(() => {
      calls.push('write');
      return Promise.resolve(snapshot(['stand-up']));
    });
    bridge({ rename, write });

    await expect(renameSkill('standup', 'stand-up', body)).resolves.toEqual({
      moved: true,
      error: null,
    });

    /*
      Order is load-bearing. Writing first would create the new folder and
      leave the old one — the duplicate this story exists to end, reassembled
      out of the new API.
    */
    expect(calls).toEqual(['rename', 'write']);
    expect(rename).toHaveBeenCalledWith({ from: 'standup', to: 'stand-up' });
    expect(write).toHaveBeenCalledWith({ name: 'stand-up', body });
  });

  it('publishes once, so the mid-rename snapshot never reaches the pane', async () => {
    /*
      Between the two calls the moved folder still declares the old name, so
      main honestly reports it invalid. Emitting that would flash a "does not
      match the folder" row through the middle of a save — a true fact about a
      state the user never asked for and cannot act on.
    */
    const listener = vi.fn();
    const unsubscribe = subscribeSkills(listener);
    bridge({
      rename: () =>
        Promise.resolve({
          ...snapshot([]),
          invalid: [
            { name: 'stand-up', reason: 'does not match', valid: false as const },
          ],
        }),
      write: () => Promise.resolve(snapshot(['stand-up'])),
    });

    await renameSkill('standup', 'stand-up', body);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(skillsSnapshot()?.skills.map((s) => s.name)).toEqual(['stand-up']);
    expect(skillsSnapshot()?.invalid).toEqual([]);
    unsubscribe();
  });

  it('never parks the intermediate in the snapshot, even unemitted', async () => {
    /*
      Skipping `emit()` is not what keeps the mid-rename state off screen, and
      believing it was is the bug this pins. `useSyncExternalStore` re-reads
      `getSnapshot()` on every render of every subscriber, not only when it is
      notified — so a snapshot parked in module state between the two awaits is
      published by the next unrelated re-render, notification or no.

      Reading it here at the one moment it could exist is the only way to say
      that from a test: `write` runs after the move, so this callback *is* the
      window.
    */
    let midRename: string[] | undefined;
    bridge({
      rename: () => Promise.resolve(snapshot(['mid-rename'])),
      write: () => {
        // Recorded, not asserted here: an assertion that throws inside the
        // chain is caught by `renameSkill` and reported as a failed rename,
        // which would hide the real reason under a wrong one.
        midRename = skillsSnapshot()?.skills.map((s) => s.name);
        return Promise.resolve(snapshot(['stand-up']));
      },
    });

    await renameSkill('standup', 'stand-up', body);

    expect(midRename).not.toContain('mid-rename');
    expect(skillsSnapshot()?.skills.map((s) => s.name)).toEqual(['stand-up']);
  });

  it('reports a refused move and leaves the snapshot alone', async () => {
    bridge({ list: () => Promise.resolve(snapshot(['standup'])) });
    await loadSkills();
    bridge({
      rename: () => Promise.reject(new Error('A skill called "ship-it" already exists.')),
      write: vi.fn(),
    });

    const outcome = await renameSkill('standup', 'ship-it', body);

    expect(outcome.error).toMatch(/already exists/i);
    // `moved: false` is what tells the pane to leave the editor where it is.
    expect(outcome.moved).toBe(false);
    // Nothing moved, so what the pane is holding is still exactly true.
    expect(skillsSnapshot()?.skills.map((s) => s.name)).toEqual(['standup']);
  });

  it('does not write when the move failed', async () => {
    // Otherwise a refused rename becomes the duplicate: the body lands under
    // the new name in a folder nothing moved out of.
    const write = vi.fn();
    bridge({ rename: () => Promise.reject(new Error('nope')), write });

    await renameSkill('standup', 'stand-up', body);

    expect(write).not.toHaveBeenCalled();
  });

  it('publishes the half-done state when the move worked and the write did not', async () => {
    /*
      The folder is `stand-up` and the file inside still says `standup`, so the
      skill is on disk under the name the user asked for but is not injected.
      Recoverable, but only if the pane is *shown* it — which is why the failure
      path emits too, and why `moved` comes back true.
    */
    const listener = vi.fn();
    const unsubscribe = subscribeSkills(listener);
    const moved = {
      ...snapshot([]),
      invalid: [
        { name: 'stand-up', reason: 'does not match the folder', valid: false as const },
      ],
    };
    bridge({
      rename: () => Promise.resolve(moved),
      write: () => Promise.reject(new Error('EACCES')),
    });

    const outcome = await renameSkill('standup', 'stand-up', body);

    expect(outcome.error).toMatch(/EACCES/);
    /*
      The load-bearing half. Without it the pane leaves `open` on the old name,
      the new name turns up in its own `taken` list, Save goes disabled, and
      the user's only way out of a half-done rename is a text editor.
    */
    expect(outcome.moved).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(skillsSnapshot()?.invalid[0]?.name).toBe('stand-up');
    unsubscribe();
  });

  it('refuses without a bridge, and calls nothing', async () => {
    await expect(renameSkill('standup', 'stand-up', body)).resolves.toEqual({
      moved: false,
      error: expect.stringMatching(/desktop app/i),
    });
  });
});

describe('frontmatterName', () => {
  it('reads the declared name', () => {
    expect(frontmatterName('---\nname: standup\n---\nBody.\n')).toBe('standup');
  });

  it('is empty for a file with no header', () => {
    expect(frontmatterName('Just prose.\n')).toBe('');
  });

  it('does not read past the closing fence', () => {
    // The name belongs to the header, not to a `name:` line in the body.
    expect(frontmatterName('---\ndescription: d\n---\nname: sneaky\n')).toBe('');
  });

  it('does not mistake a horizontal rule for the fence', () => {
    /*
      Mirrors `skills/read.ts`, which is the copy that decides whether a skill
      loads at all — the two must agree about where a header ends. Neither of
      these closes, so both are files main refuses, and reporting a name for
      either would enable Save for a command that never appears.
    */
    expect(frontmatterName('---\nname: ruled\n-----\n')).toBe('');
    expect(frontmatterName('---\ndescription: d\n-----\nname: no\n')).toBe('');
  });

  it('is empty for an unterminated header', () => {
    expect(frontmatterName('---\nname: half\ndescription: d\n')).toBe('');
  });
});

describe('skillNameProblem', () => {
  it('accepts a good name', () => {
    expect(skillNameProblem('ship-it', [])).toBeNull();
  });

  it('asks for a name when the frontmatter declares none', () => {
    expect(skillNameProblem('', [])).toMatch(/name/i);
  });

  it('refuses the reserved name', () => {
    expect(skillNameProblem('done', [])).toMatch(/reserved/i);
  });

  it('refuses a name the pattern does not admit', () => {
    expect(skillNameProblem('Stand Up', [])).toMatch(/lowercase/i);
  });

  it('refuses a name already taken', () => {
    expect(skillNameProblem('standup', ['standup'])).toMatch(/already/i);
  });
});

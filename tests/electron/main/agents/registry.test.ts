// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentRegistry } from '../../../../electron/main/agents/registry';

let root: string;
const open: Array<{ close: () => void }> = [];

const GOOD = `---
name: slack-watcher
description: Watches things.
icon: ChatCircleDots
---
Do the job.
`;

const seed = (name: string, source: string) => {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'AGENT.md'), source);
};

const named = (name: string) => GOOD.replace('slack-watcher', name);

const registry = () => {
  const made = createAgentRegistry({
    root,
    skillNames: async () => ['jira-writer'],
  });

  open.push(made);

  return made;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hive-agents-'));
});

afterEach(() => {
  for (const made of open.splice(0)) made.close();
  rmSync(root, { recursive: true, force: true });
});

describe('list', () => {
  it('is empty when the folder does not exist', async () => {
    rmSync(root, { recursive: true, force: true });

    const snapshot = await registry().list();

    expect(snapshot.agents).toEqual([]);
    expect(snapshot.agentsRoot).toBe(root);
  });

  it('summarises a valid agent as sleeping', async () => {
    seed('slack-watcher', GOOD);

    const { agents } = await registry().list();

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      name: 'slack-watcher',
      description: 'Watches things.',
      icon: 'ChatCircleDots',
      status: 'sleeping',
    });
    expect(agents[0]?.invalid).toBeUndefined();
  });

  it('includes a broken definition rather than hiding it', async () => {
    // A pane that hides a broken file leaves the user with a folder on disk,
    // no agent on screen, and no way to connect the two.
    seed('broken', '---\nname: broken\n');

    const { agents } = await registry().list();

    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe('broken');
    expect(agents[0]?.invalid).toContain('---');
  });

  it('names the offending field in the invalid reason', async () => {
    seed('broken', GOOD.replace('slack-watcher', 'broken').replace('icon: ChatCircleDots', 'icon: ChatCircleDots\nnope: 1'));

    const { agents } = await registry().list();

    expect(agents[0]?.invalid).toContain('nope');
  });

  it('sorts alphabetically', async () => {
    seed('zulu', named('zulu'));
    seed('alpha', named('alpha'));

    expect((await registry().list()).agents.map((a) => a.name)).toEqual([
      'alpha',
      'zulu',
    ]);
  });

  it('ignores a folder with no AGENT.md', async () => {
    mkdirSync(join(root, 'not-an-agent'), { recursive: true });

    expect((await registry().list()).agents).toEqual([]);
  });
});

describe('read', () => {
  it('returns the raw source', async () => {
    seed('slack-watcher', GOOD);

    expect(await registry().read('slack-watcher')).toBe(GOOD);
  });

  it('returns null for an agent that is not there', async () => {
    expect(await registry().read('nope')).toBeNull();
  });

  it('refuses a name that would escape the root', async () => {
    expect(await registry().read('../../etc/passwd')).toBeNull();
  });
});

describe('write', () => {
  it('creates the folder and the file', async () => {
    const result = await registry().write('slack-watcher', GOOD);

    expect(result).toEqual({ ok: true });
    expect(readFileSync(join(root, 'slack-watcher', 'AGENT.md'), 'utf8')).toBe(
      GOOD,
    );
  });

  it('refuses an invalid definition and writes nothing', async () => {
    const bad = GOOD.replace('icon: ChatCircleDots', 'icon: ChatCircleDots\nnope: 1');

    const result = await registry().write('slack-watcher', bad);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.problems[0]?.field).toBe('nope');
    // The acceptance criteria are explicit: a refusal leaves the disk alone.
    expect(() =>
      readFileSync(join(root, 'slack-watcher', 'AGENT.md')),
    ).toThrow();
  });

  it('refuses a definition whose name does not match the folder', async () => {
    expect((await registry().write('other-name', GOOD)).ok).toBe(false);
  });

  it('leaves no temp file behind', async () => {
    await registry().write('slack-watcher', GOOD);

    expect(readdirSync(join(root, 'slack-watcher'))).toEqual(['AGENT.md']);
  });

  it('overwrites an existing definition', async () => {
    seed('slack-watcher', GOOD);
    const next = GOOD.replace('Watches things.', 'Watches other things.');

    await registry().write('slack-watcher', next);

    expect(readFileSync(join(root, 'slack-watcher', 'AGENT.md'), 'utf8')).toBe(
      next,
    );
  });
});

describe('remove and rename', () => {
  it('removes the whole folder', async () => {
    seed('slack-watcher', GOOD);

    await registry().remove('slack-watcher');

    expect((await registry().list()).agents).toEqual([]);
  });

  it('renames the folder and the name inside the file', async () => {
    seed('slack-watcher', GOOD);

    expect(await registry().rename('slack-watcher', 'slack-bot')).toEqual({
      ok: true,
    });
    expect((await registry().list()).agents.map((a) => a.name)).toEqual([
      'slack-bot',
    ]);
  });

  it('refuses a rename onto an existing name', async () => {
    seed('slack-watcher', GOOD);
    seed('taken', named('taken'));

    expect((await registry().rename('slack-watcher', 'taken')).ok).toBe(false);
    expect((await registry().list()).agents).toHaveLength(2);
  });

  it('refuses a rename of something that is not there', async () => {
    expect((await registry().rename('ghost', 'other')).ok).toBe(false);
  });
});

describe('the watcher', () => {
  /**
   * The real `fs.watch` delivers on the OS event loop, which fake timers do
   * not advance — so a test that leans on it can only prove the debounce with
   * a real wait. Injecting the factory keeps the timing logic under fake
   * timers, which is the whole point of the seam.
   */
  const watched = () => {
    let fire = () => {};
    const closed = vi.fn();
    const reg = createAgentRegistry({
      root,
      skillNames: async () => [],
      watch: (_root, onEvent) => {
        fire = onEvent;

        return { close: closed };
      },
    });

    open.push(reg);

    return { reg, fire: () => fire(), closed };
  };

  it('emits after a change settles', async () => {
    vi.useFakeTimers();
    const { reg, fire } = watched();
    const seen = vi.fn();

    reg.onChange(seen);
    fire();
    await vi.advanceTimersByTimeAsync(500);

    expect(seen).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('does not emit before the debounce elapses', async () => {
    vi.useFakeTimers();
    const { reg, fire } = watched();
    const seen = vi.fn();

    reg.onChange(seen);
    fire();
    await vi.advanceTimersByTimeAsync(50);

    expect(seen).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('collapses a burst into one emission', async () => {
    vi.useFakeTimers();
    const { reg, fire } = watched();
    const seen = vi.fn();

    reg.onChange(seen);
    fire();
    fire();
    fire();
    await vi.advanceTimersByTimeAsync(500);

    expect(seen).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('stops emitting once unsubscribed', async () => {
    vi.useFakeTimers();
    const { reg, fire } = watched();
    const seen = vi.fn();

    reg.onChange(seen)();
    fire();
    await vi.advanceTimersByTimeAsync(500);

    expect(seen).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('closes the underlying watcher on close', () => {
    const { reg, closed } = watched();

    reg.onChange(() => {});
    reg.close();

    expect(closed).toHaveBeenCalled();
  });

  it('tolerates a platform that cannot watch', async () => {
    const reg = createAgentRegistry({
      root,
      skillNames: async () => [],
      watch: () => null,
    });

    open.push(reg);
    seed('slack-watcher', GOOD);

    // Listing still works; only the live update is missing.
    expect((await reg.list()).agents).toHaveLength(1);
  });
});

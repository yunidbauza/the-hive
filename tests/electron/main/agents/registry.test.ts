// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAgentRegistry,
  type AgentRunFiles,
} from '../../../../electron/main/agents/registry';

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

const registry = (runFiles?: AgentRunFiles) => {
  const made = createAgentRegistry({
    root,
    skillNames: async () => ({ all: ['jira-writer'], hive: ['jira-writer'] }),
    ...(runFiles === undefined ? {} : { runFiles }),
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

  it('creates the folder it is about to watch', async () => {
    // fs.watch cannot attach to a path that does not exist and does not retry,
    // so on a fresh install the watcher silently never bound and a hand-written
    // AGENT.md did not appear until the next launch.
    rmSync(root, { recursive: true, force: true });

    await registry().list();

    expect(existsSync(root)).toBe(true);
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

  /*
    The scheduler's day ceiling reaches it through the listing rather than by
    re-parsing every AGENT.md once a minute (HIVE-121) — so it has to survive
    the trip, the way `rotateAfter` already does.
  */
  it('carries a daily cap the definition names', async () => {
    seed(
      'capped',
      GOOD.replace('slack-watcher', 'capped').replace(
        'icon: ChatCircleDots',
        'icon: ChatCircleDots\nlimits:\n  daily_usd: 0.50',
      ),
    );

    const { agents } = await registry().list();

    expect(agents[0]?.dailyUsd).toBe(0.5);
  });

  it('leaves the cap absent when the definition names none', async () => {
    seed('slack-watcher', GOOD);

    const { agents } = await registry().list();

    expect(agents[0]?.dailyUsd).toBeUndefined();
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

/**
 * An agent is more than its folder (HIVE-115): `agents.json` holds its session
 * uuid, its history and its rotation counter, and `~/.hive/work/<name>` holds
 * what it has been writing. Both are keyed by the name, so a delete that moved
 * only the folder left the next agent to take that name resuming the deleted
 * one's conversation and showing its cost.
 */
describe('the run bookkeeping follows the definition', () => {
  const spy = () => {
    const forgotten: string[] = [];
    const carried: [string, string][] = [];

    return {
      forgotten,
      carried,
      files: {
        forget: async (name: string) => {
          forgotten.push(name);
        },
        carry: async (from: string, to: string) => {
          carried.push([from, to]);
        },
      } satisfies AgentRunFiles,
    };
  };

  it('remove clears it', async () => {
    seed('slack-watcher', GOOD);

    const runFiles = spy();

    await registry(runFiles.files).remove('slack-watcher');

    expect(runFiles.forgotten).toEqual(['slack-watcher']);
  });

  it('remove refuses an unsafe name without touching it', async () => {
    const runFiles = spy();

    await registry(runFiles.files).remove('../escape');

    expect(runFiles.forgotten).toEqual([]);
  });

  /**
   * `rename` clears the old folder through the *folder-only* path. Going
   * through `remove` would forget the state it had just carried forward, which
   * is the same orphaning by a longer route.
   */
  it('rename carries it across and never forgets it', async () => {
    seed('slack-watcher', GOOD);

    const runFiles = spy();

    expect(await registry(runFiles.files).rename('slack-watcher', 'slack-bot')).toEqual(
      { ok: true },
    );
    expect(runFiles.carried).toEqual([['slack-watcher', 'slack-bot']]);
    expect(runFiles.forgotten).toEqual([]);
  });

  it('a refused rename moves nothing', async () => {
    seed('slack-watcher', GOOD);
    seed('taken', named('taken'));

    const runFiles = spy();

    await registry(runFiles.files).rename('slack-watcher', 'taken');

    expect(runFiles.carried).toEqual([]);
    expect(runFiles.forgotten).toEqual([]);
  });
});

describe('an unaddressable folder', () => {
  /*
    `assertAgentName` refuses upper case, spaces and the reserved names, so the
    IPC layer cannot open or delete such a folder at all. Listing it with the
    real reason is the only honest option — hiding it leaves a row-less folder,
    and loosening the guard would widen a security boundary.
  */
  it('is listed with a reason naming the folder itself', async () => {
    mkdirSync(join(root, 'Slack Watcher'), { recursive: true });
    writeFileSync(join(root, 'Slack Watcher', 'AGENT.md'), GOOD);

    const { agents } = await registry().list();

    expect(agents[0]?.name).toBe('Slack Watcher');
    expect(agents[0]?.invalid).toMatch(/rename it on disk/i);
  });

  it('says the same of a reserved folder name', async () => {
    seed('overmind', named('overmind'));

    expect((await registry().list()).agents[0]?.invalid).toMatch(
      /rename it on disk/i,
    );
  });
});

describe('rename validates the buffer, not the file on disk', () => {
  it('accepts a source that fixes what the stored file got wrong', async () => {
    // The flow the pane exists to support: open a broken definition, fix the
    // bad key and rename it in one edit. Validating the stale file refused it
    // with a problem the user had already resolved.
    seed('alpha', named('alpha').replace('icon: ChatCircleDots', 'icon: ChatCircleDots\nnope: 1'));

    const fixed = named('beta');
    const result = await registry().rename('alpha', 'beta', fixed);

    expect(result).toEqual({ ok: true });
    expect(readFileSync(join(root, 'beta', 'AGENT.md'), 'utf8')).toBe(fixed);
    expect(existsSync(join(root, 'alpha'))).toBe(false);
  });

  it('refuses when the source itself is invalid, and moves nothing', async () => {
    seed('alpha', named('alpha'));

    const result = await registry().rename(
      'alpha',
      'beta',
      named('beta').replace('icon: ChatCircleDots', 'nope: 1'),
    );

    expect(result.ok).toBe(false);
    expect(existsSync(join(root, 'alpha'))).toBe(true);
    expect(existsSync(join(root, 'beta'))).toBe(false);
  });

  it('still moves a folder when given no source', async () => {
    seed('alpha', named('alpha'));

    expect((await registry().rename('alpha', 'beta')).ok).toBe(true);
  });

  it('rewrites the name without eating a comment on that line', async () => {
    seed('alpha', named('alpha').replace('name: alpha', 'name: alpha   # mine'));

    await registry().rename('alpha', 'beta');

    const moved = readFileSync(join(root, 'beta', 'AGENT.md'), 'utf8');

    expect(moved).toContain('# mine');
    expect(moved).toContain('name: beta');
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
      skillNames: async () => ({ all: [], hive: [] }),
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

  it('rebinds after the folder it was watching is deleted', async () => {
    /*
      `fs.watch` holds an inode, not a path: once the folder is gone the handle
      stops delivering while staying non-null, so a `watcher !== null` guard
      turned live updates off for the rest of the session.
    */
    const made: Array<{ close: () => void }> = [];
    const reg = createAgentRegistry({
      root,
      skillNames: async () => ({ all: [], hive: [] }),
      watch: () => {
        const handle = { close: vi.fn() };

        made.push(handle);

        return handle;
      },
    });

    open.push(reg);
    await reg.list();
    expect(made).toHaveLength(1);

    rmSync(root, { recursive: true, force: true });
    await reg.list();

    expect(made).toHaveLength(2);
    expect(made[0]?.close).toHaveBeenCalled();
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
      skillNames: async () => ({ all: [], hive: [] }),
      watch: () => null,
    });

    open.push(reg);
    seed('slack-watcher', GOOD);

    // Listing still works; only the live update is missing.
    expect((await reg.list()).agents).toHaveLength(1);
  });
});

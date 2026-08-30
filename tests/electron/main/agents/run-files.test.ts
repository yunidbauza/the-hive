// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentRunFiles } from '../../../../electron/main/agents/run-files';
import { createAgentState } from '../../../../electron/main/agents/state';

/**
 * What a delete or a rename does to the two things keyed by an agent's name
 * that do not live in its folder (HIVE-115).
 *
 * Against a real temp directory rather than a mocked `fs`: the whole point of
 * this module is that a folder really moves, and a fake that renamed a string
 * in a map would pass while the disk kept the old one.
 */
describe('createAgentRunFiles', () => {
  let dir: string;
  let statePath: string;

  const workdir = (name: string) => join(dir, 'work', name);

  const make = () => {
    const state = createAgentState({ path: statePath, debounceMs: 1 });

    return {
      state,
      files: createAgentRunFiles({ state: () => state, workdir }),
    };
  };

  const seedWorkdir = (name: string) => {
    mkdirSync(workdir(name), { recursive: true });
    writeFileSync(join(workdir(name), 'notes.md'), 'scratch', 'utf8');
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hive-run-files-'));
    statePath = join(dir, 'agents.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('forget drops the agents.json entry and the working directory', async () => {
    const { state, files } = make();

    state.patch('slack-watcher', { sessionUuid: 'u-1', runsSinceRotate: 4 });
    seedWorkdir('slack-watcher');

    await files.forget('slack-watcher');

    expect(state.all()).toEqual({});
    expect(existsSync(workdir('slack-watcher'))).toBe(false);
  });

  it('forget is quiet about an agent that never ran', async () => {
    const { state, files } = make();

    await expect(files.forget('never-woken')).resolves.toBeUndefined();
    expect(state.all()).toEqual({});
  });

  it('carry moves the entry and the working directory together', async () => {
    const { state, files } = make();

    state.patch('slack-watcher', { sessionUuid: 'u-1', runsSinceRotate: 4 });
    seedWorkdir('slack-watcher');

    await files.carry('slack-watcher', 'slack-bot');

    expect(state.read('slack-bot')).toMatchObject({
      sessionUuid: 'u-1',
      runsSinceRotate: 4,
    });
    expect(state.all()['slack-watcher']).toBeUndefined();
    expect(existsSync(workdir('slack-watcher'))).toBe(false);
    expect(readFileSync(join(workdir('slack-bot'), 'notes.md'), 'utf8')).toBe(
      'scratch',
    );
  });

  /*
    A workdir is scratch and the next wake makes one. Failing a rename over it
    would strand the user with a definition they cannot move.
  */
  it('carry survives an agent with no working directory yet', async () => {
    const { state, files } = make();

    state.patch('slack-watcher', { sessionUuid: 'u-1' });

    await expect(files.carry('slack-watcher', 'slack-bot')).resolves.toBeUndefined();
    expect(state.read('slack-bot').sessionUuid).toBe('u-1');
  });

  /*
    The browser-shaped case, and the boot window: `ipc/index.ts` builds the
    registry before it opens `agents.json`. Nothing to forget is not an error.
  */
  it('does nothing at all when no state file has been opened', async () => {
    const files = createAgentRunFiles({ state: () => null, workdir });

    seedWorkdir('slack-watcher');

    await files.forget('slack-watcher');

    expect(existsSync(workdir('slack-watcher'))).toBe(false);
  });
});

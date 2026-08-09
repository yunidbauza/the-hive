import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  baseName,
  childPath,
  hasFsBridge,
  onFsChanged,
  parentPath,
  readDir,
  readFile,
  unwatchProject,
  watchProject,
  writeFile,
} from '@lib/explorer/fs-client';

/**
 * The bridge wrapper.
 *
 * The property worth pinning is the one every call site depends on and none of
 * them handles: **there is a bridge or there is not, and the browser demo is
 * not an error.** Every verb answers usefully with `window.hive` absent, which
 * is what keeps `hasFsBridge()` the only branch in the whole feature.
 */

const fs = {
  readDir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  watch: vi.fn(),
  unwatch: vi.fn(),
  onChanged: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  window.hive = { fs } as unknown as Window['hive'];
});

afterEach(() => {
  delete window.hive;
});

describe('with no bridge — the browser demo', () => {
  beforeEach(() => {
    delete window.hive;
  });

  it('reports that there is none', () => {
    expect(hasFsBridge()).toBe(false);
  });

  /**
   * `ENOBRIDGE`, not `EPROJECT`. "You are running the demo" and "that project
   * is not usable" are different situations with different things to say.
   */
  it('answers reads with ENOBRIDGE rather than throwing', async () => {
    await expect(readDir('demo', '')).resolves.toMatchObject({
      ok: false,
      error: { code: 'ENOBRIDGE' },
    });
    await expect(readFile('demo', 'a.ts')).resolves.toMatchObject({
      ok: false,
      error: { code: 'ENOBRIDGE' },
    });
  });

  it('answers a write with a non-conflict failure', async () => {
    const result = await writeFile('demo', 'a.ts', 'x', 0);
    expect(result).toMatchObject({ ok: false, conflict: false });
  });

  it('reports a failed watch instead of rejecting', async () => {
    await expect(watchProject('demo')).resolves.toBe(false);
    await expect(unwatchProject()).resolves.toBeUndefined();
  });

  /**
   * A no-op disposer rather than `undefined`, so no caller has to branch. An
   * effect that conditionally returns a cleanup is an effect that eventually
   * forgets to.
   */
  it('returns a working no-op unsubscribe', () => {
    const stop = onFsChanged(() => {});
    expect(() => stop()).not.toThrow();
  });
});

describe('with a bridge', () => {
  it('reports that there is one', () => {
    expect(hasFsBridge()).toBe(true);
  });

  it('forwards a directory read', async () => {
    fs.readDir.mockResolvedValue({ ok: true, value: [] });
    await readDir('demo', 'src');
    expect(fs.readDir).toHaveBeenCalledWith({ projectId: 'demo', relPath: 'src' });
  });

  it('forwards a file read', async () => {
    fs.readFile.mockResolvedValue({ ok: true, value: { text: '' } });
    await readFile('demo', 'a.ts');
    expect(fs.readFile).toHaveBeenCalledWith({
      projectId: 'demo',
      relPath: 'a.ts',
    });
  });

  it('forwards a write with its base mtime', async () => {
    fs.writeFile.mockResolvedValue({ ok: true, mtimeMs: 2 });
    await writeFile('demo', 'a.ts', 'body', 1);
    expect(fs.writeFile).toHaveBeenCalledWith({
      projectId: 'demo',
      relPath: 'a.ts',
      text: 'body',
      baseMtimeMs: 1,
    });
  });

  it('reports a successful watch', async () => {
    fs.watch.mockResolvedValue(undefined);
    await expect(watchProject('demo')).resolves.toBe(true);
  });

  /**
   * A project that cannot be watched is an explorer without live updates, not
   * a broken app — and it still has its manual refresh. Letting this reject
   * would turn a degraded feature into an unhandled rejection in an effect.
   */
  it('swallows a rejected watch and reports failure', async () => {
    fs.watch.mockRejectedValue(new Error('EPROJECT'));
    await expect(watchProject('demo')).resolves.toBe(false);
  });

  it('swallows a rejected unwatch', async () => {
    fs.unwatch.mockRejectedValue(new Error('gone'));
    await expect(unwatchProject()).resolves.toBeUndefined();
  });

  it('passes the subscription through and returns its disposer', () => {
    const dispose = vi.fn();
    fs.onChanged.mockReturnValue(dispose);
    const callback = vi.fn();

    const stop = onFsChanged(callback);
    expect(fs.onChanged).toHaveBeenCalledWith(callback);

    stop();
    expect(dispose).toHaveBeenCalled();
  });
});

describe('path helpers', () => {
  /**
   * The root is `''`, and `'' + '/' + name` produces a leading slash — which
   * the guard in main rejects as an absolute path. Getting this wrong makes the
   * root's children unreadable and every nested directory fine, which is a
   * confusing shape of bug.
   */
  it('joins a root child without a leading slash', () => {
    expect(childPath('', 'src')).toBe('src');
    expect(childPath('src', 'app.ts')).toBe('src/app.ts');
    expect(childPath('a/b', 'c')).toBe('a/b/c');
  });

  it('takes the last segment as a name', () => {
    expect(baseName('src/features/app.tsx')).toBe('app.tsx');
    expect(baseName('README.md')).toBe('README.md');
  });

  it('takes the directory part, empty at the root', () => {
    expect(parentPath('src/app.ts')).toBe('src');
    expect(parentPath('README.md')).toBe('');
  });
});

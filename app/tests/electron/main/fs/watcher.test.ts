// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectConfig } from '../../../../electron/shared/config-contract';
import type { FsChangedEvent } from '../../../../electron/shared/fs-contract';

/**
 * The watcher — debounce, hidden-list filtering, and the single-watcher rule.
 *
 * `fs.watch` is mocked here, unlike everywhere else in this directory. The
 * behaviour under test is what happens to events *after* they arrive: real
 * `fs.watch` delivers them on the OS's schedule, which makes "were these two
 * coalesced into one flush" a question about timing rather than about this
 * code. The one thing the mock cannot check — that recursive watching works at
 * all — is a platform guarantee, not a branch.
 */

const projects: ProjectConfig[] = [];

vi.mock('../../../../electron/main/config', () => ({
  getConfig: () => ({ projects }),
}));

type Handler = (event: string, filename: string | null) => void;

interface FakeWatcher {
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  emitError: () => void;
}

const watchers: FakeWatcher[] = [];
let handler: Handler | null = null;
let watchedPaths: string[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: (path: string, _options: unknown, callback: Handler) => {
      watchedPaths.push(path);
      handler = callback;
      const listeners: Record<string, () => void> = {};
      const watcher: FakeWatcher = {
        close: vi.fn(),
        on: vi.fn((event: string, listener: () => void) => {
          listeners[event] = listener;
        }),
        emitError: () => listeners.error?.(),
      };
      watchers.push(watcher);
      return watcher;
    },
  };
});

const { createFsWatchLayer } = await import(
  '../../../../electron/main/fs/watcher'
);

let root: string;
let emitted: FsChangedEvent[];

beforeEach(() => {
  vi.useFakeTimers();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-fs-watch-')));
  watchers.length = 0;
  watchedPaths = [];
  handler = null;
  emitted = [];
  projects.length = 0;
  projects.push({
    id: 'demo',
    name: 'demo',
    path: root,
    icon: 'ph-folder',
    origin: 'local',
    status: 'ok',
    isRepo: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
  projects.length = 0;
});

const layer = () => createFsWatchLayer((event) => emitted.push(event));

describe('createFsWatchLayer', () => {
  it('watches the project root and emits its relative paths', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject('demo');

    expect(watchedPaths).toEqual([root]);

    handler?.('change', 'src/app.ts');
    vi.advanceTimersByTime(300);

    expect(emitted).toEqual([{ projectId: 'demo', paths: ['src/app.ts'] }]);
  });

  /**
   * One `git checkout` produces a change event per file. Without the debounce
   * the tree would re-read its expanded directories hundreds of times for one
   * logical event.
   */
  it('coalesces a burst into one flush', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject('demo');

    handler?.('change', 'a.ts');
    vi.advanceTimersByTime(100);
    handler?.('change', 'b.ts');
    vi.advanceTimersByTime(100);
    handler?.('change', 'a.ts');

    // Trailing, not leading: nothing has been emitted mid-burst.
    expect(emitted).toHaveLength(0);

    vi.advanceTimersByTime(300);

    expect(emitted).toHaveLength(1);
    // A Set, so the repeated path appears once.
    expect(emitted[0].paths.sort()).toEqual(['a.ts', 'b.ts']);
  });

  /**
   * A `pnpm install` rewrites tens of thousands of paths under `node_modules`.
   * Filtering in the renderer would mean serialising every one of them across
   * the bridge to be discarded.
   */
  it('drops hidden paths before emitting', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject('demo');

    handler?.('change', 'node_modules/react/index.js');
    handler?.('change', '.git/HEAD');
    handler?.('change', 'dist/bundle.js');
    handler?.('change', 'src/app.ts');
    vi.advanceTimersByTime(300);

    expect(emitted).toEqual([{ projectId: 'demo', paths: ['src/app.ts'] }]);
  });

  it('emits nothing when every path in a burst was hidden', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject('demo');

    handler?.('change', 'node_modules/a/b.js');
    vi.advanceTimersByTime(300);

    expect(emitted).toHaveLength(0);
  });

  it('ignores a null filename', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject('demo');

    handler?.('change', null);
    vi.advanceTimersByTime(300);

    expect(emitted).toHaveLength(0);
  });

  /**
   * The rule that keeps this from being a file-descriptor leak with a long
   * fuse: watching a second project closes the first watcher rather than
   * adding to it.
   */
  it('replaces the previous watcher rather than adding one', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject('demo');
    await fsWatch.watchProject('demo');

    expect(watchers).toHaveLength(2);
    expect(watchers[0].close).toHaveBeenCalledTimes(1);
    expect(watchers[1].close).not.toHaveBeenCalled();
  });

  it('closes the watcher on unwatch, and stops emitting', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject('demo');
    const capture = handler;

    fsWatch.unwatch();
    capture?.('change', 'src/app.ts');
    vi.advanceTimersByTime(300);

    expect(watchers[0].close).toHaveBeenCalledTimes(1);
    expect(emitted).toHaveLength(0);
  });

  it('drops a pending flush when the watcher is closed mid-debounce', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject('demo');

    handler?.('change', 'src/app.ts');
    fsWatch.dispose();
    vi.advanceTimersByTime(300);

    expect(emitted).toHaveLength(0);
  });

  it('closes itself when the watcher errors', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject('demo');

    watchers[0].emitError();

    expect(watchers[0].close).toHaveBeenCalled();
  });

  it('rejects an unwatchable project through the same guard as a read', async () => {
    const fsWatch = layer();
    await expect(fsWatch.watchProject('other')).rejects.toMatchObject({
      code: 'EPROJECT',
    });
    expect(watchers).toHaveLength(0);
  });

  it('unwatch is safe when nothing is being watched', () => {
    const fsWatch = layer();
    expect(() => fsWatch.unwatch()).not.toThrow();
  });
});

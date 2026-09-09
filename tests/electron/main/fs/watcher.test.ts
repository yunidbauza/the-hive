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
/** Every callback, in install order, so two surfaces can be driven apart. */
let handlers: Handler[] = [];
let watchedPaths: string[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: (path: string, _options: unknown, callback: Handler) => {
      watchedPaths.push(path);
      handler = callback;
      handlers.push(callback);
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
let emittedTo: [string, FsChangedEvent][];

beforeEach(() => {
  vi.useFakeTimers();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-fs-watch-')));
  watchers.length = 0;
  watchedPaths = [];
  handler = null;
  handlers = [];
  emitted = [];
  emittedTo = [];
  projects.length = 0;
  projects.push({
    id: 'demo',
    name: 'demo',
    path: root,
    icon: 'ph-folder',
    origin: 'local',
    status: 'ok',
    key: 'demo',
    isRepo: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
  projects.length = 0;
});

/**
 * Two surface ids, standing in for two devices attached to one server
 * (HIVE-145). Every pre-existing case drives `S1` alone, which is the
 * single-surface behaviour this layer always had.
 */
const S1 = 'surface-1';
const S2 = 'surface-2';

const layer = () =>
  createFsWatchLayer((surfaceId, event) => {
    emitted.push(event);
    emittedTo.push([surfaceId, event]);
  });

describe('createFsWatchLayer', () => {
  it('watches the project root and emits its relative paths', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject(S1, 'demo');

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
    await fsWatch.watchProject(S1, 'demo');

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
    await fsWatch.watchProject(S1, 'demo');

    handler?.('change', 'node_modules/react/index.js');
    handler?.('change', '.git/HEAD');
    handler?.('change', 'dist/bundle.js');
    handler?.('change', 'src/app.ts');
    vi.advanceTimersByTime(300);

    expect(emitted).toEqual([{ projectId: 'demo', paths: ['src/app.ts'] }]);
  });

  it('emits nothing when every path in a burst was hidden', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject(S1, 'demo');

    handler?.('change', 'node_modules/a/b.js');
    vi.advanceTimersByTime(300);

    expect(emitted).toHaveLength(0);
  });

  it('ignores a null filename', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject(S1, 'demo');

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
    await fsWatch.watchProject(S1, 'demo');
    await fsWatch.watchProject(S1, 'demo');

    expect(watchers).toHaveLength(2);
    expect(watchers[0].close).toHaveBeenCalledTimes(1);
    expect(watchers[1].close).not.toHaveBeenCalled();
  });

  it('closes the watcher on unwatch, and stops emitting', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject(S1, 'demo');
    const capture = handler;

    fsWatch.unwatch(S1);
    capture?.('change', 'src/app.ts');
    vi.advanceTimersByTime(300);

    expect(watchers[0].close).toHaveBeenCalledTimes(1);
    expect(emitted).toHaveLength(0);
  });

  it('drops a pending flush when the watcher is closed mid-debounce', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject(S1, 'demo');

    handler?.('change', 'src/app.ts');
    fsWatch.dispose();
    vi.advanceTimersByTime(300);

    expect(emitted).toHaveLength(0);
  });

  it('closes itself when the watcher errors', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject(S1, 'demo');

    watchers[0].emitError();

    expect(watchers[0].close).toHaveBeenCalled();
  });

  it('rejects an unwatchable project through the same guard as a read', async () => {
    const fsWatch = layer();
    await expect(fsWatch.watchProject(S1, 'other')).rejects.toMatchObject({
      code: 'EPROJECT',
    });
    expect(watchers).toHaveLength(0);
  });

  it('unwatch is safe when nothing is being watched', () => {
    const fsWatch = layer();
    expect(() => fsWatch.unwatch(S1)).not.toThrow();
  });
});

/**
 * Two surfaces (HIVE-145).
 *
 * There was one watch slot for the whole process, so with two clients attached
 * the second `fs:watch` silently stole the first's watcher and that explorer
 * stopped refreshing with nothing on screen to say so. Each surface owns its
 * own now, and `fs:changed` is targeted rather than broadcast: an explorer must
 * not react to a tree it is not showing.
 */
describe('two surfaces', () => {
  it('gives each surface its own watcher', async () => {
    const fsWatch = layer();

    await fsWatch.watchProject(S1, 'demo');
    await fsWatch.watchProject(S2, 'demo');

    expect(watchers).toHaveLength(2);
    // Neither stole the other's: nothing was closed.
    expect(watchers[0].close).not.toHaveBeenCalled();
    expect(watchers[1].close).not.toHaveBeenCalled();
  });

  it('emits only to the surface whose watcher fired', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject(S1, 'demo');
    await fsWatch.watchProject(S2, 'demo');

    handlers[0]('change', 'src/one.ts');
    await vi.advanceTimersByTimeAsync(400);

    expect(emittedTo).toEqual([[S1, { projectId: 'demo', paths: ['src/one.ts'] }]]);
  });

  it('debounces each surface on its own clock', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject(S1, 'demo');
    await fsWatch.watchProject(S2, 'demo');

    handlers[0]('change', 'a.ts');
    await vi.advanceTimersByTimeAsync(200);
    /*
      Under a shared watcher this second event would have reset the one debounce
      clock, postponing S1's flush along with S2's. Their bursts are
      independent, so S1 must still flush on its own schedule.
    */
    handlers[1]('change', 'b.ts');
    await vi.advanceTimersByTimeAsync(150);

    expect(emittedTo).toEqual([[S1, { projectId: 'demo', paths: ['a.ts'] }]]);
  });

  it('replaces only the asking surface\'s watcher on a project switch', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject(S1, 'demo');
    await fsWatch.watchProject(S2, 'demo');

    await fsWatch.watchProject(S1, 'demo');

    expect(watchers).toHaveLength(3);
    expect(watchers[0].close).toHaveBeenCalledTimes(1);
    expect(watchers[1].close).not.toHaveBeenCalled();
  });

  it('unwatches one surface and leaves the other watching', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject(S1, 'demo');
    await fsWatch.watchProject(S2, 'demo');

    fsWatch.unwatch(S1);

    expect(watchers[0].close).toHaveBeenCalledTimes(1);
    expect(watchers[1].close).not.toHaveBeenCalled();

    handlers[1]('change', 'b.ts');
    await vi.advanceTimersByTimeAsync(400);
    expect(emittedTo).toEqual([[S2, { projectId: 'demo', paths: ['b.ts'] }]]);
  });

  it('releases a surface that went away without touching the survivor', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject(S1, 'demo');
    await fsWatch.watchProject(S2, 'demo');

    fsWatch.release(S2);

    expect(watchers[1].close).toHaveBeenCalledTimes(1);
    handlers[0]('change', 'a.ts');
    await vi.advanceTimersByTimeAsync(400);
    expect(emittedTo).toEqual([[S1, { projectId: 'demo', paths: ['a.ts'] }]]);
  });

  it('emits nothing for a surface released mid-burst', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject(S1, 'demo');

    handlers[0]('change', 'a.ts');
    fsWatch.release(S1);
    await vi.advanceTimersByTimeAsync(400);

    expect(emittedTo).toHaveLength(0);
  });

  it('closes every surface\'s watcher on dispose', async () => {
    const fsWatch = layer();
    await fsWatch.watchProject(S1, 'demo');
    await fsWatch.watchProject(S2, 'demo');

    fsWatch.dispose();

    expect(watchers[0].close).toHaveBeenCalledTimes(1);
    expect(watchers[1].close).toHaveBeenCalledTimes(1);
  });

  it('does not let one surface\'s slow resolve cancel another\'s install', async () => {
    const fsWatch = layer();

    /*
      The generation counter was module scope, so any surface's newer request
      invalidated every older one still awaiting `rootFor`. Two surfaces
      starting a watch at once is the ordinary case, not a race — and losing one
      of them leaves that explorer permanently unwatched.
    */
    const first = fsWatch.watchProject(S1, 'demo');
    const second = fsWatch.watchProject(S2, 'demo');
    await Promise.all([first, second]);

    expect(watchers).toHaveLength(2);

    handlers[0]('change', 'a.ts');
    await vi.advanceTimersByTimeAsync(400);
    expect(emittedTo).toEqual([[S1, { projectId: 'demo', paths: ['a.ts'] }]]);
  });
});

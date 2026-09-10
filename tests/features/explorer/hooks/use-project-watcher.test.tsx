import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectWatcher } from '@features/explorer/hooks/use-project-watcher';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';
import { emptySnapshot } from '@shared/config-contract';
import type { FsChangedEvent } from '@shared/fs-contract';
import { useEditorStore } from '@stores/editor-store';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet, seedDemoProjectConfig } from '@tests/support/demo-fleet';

/**
 * The filesystem watcher, at the composition root.
 *
 * It lived in `ExplorerPanel` and that was a bug: the rail swaps panels and the
 * shell can unmount the rail entirely, so freshness died the moment the user
 * looked at the Inbox with a file open. These tests pin the property that fix
 * bought — the subscription's lifetime is the app's, not a tab's.
 */

const { hasFsBridge, onFsChanged, readRoot, unwatchProject, watchProject } =
  vi.hoisted(() => ({
    hasFsBridge: vi.fn(),
    onFsChanged: vi.fn(),
    readRoot: vi.fn(),
    unwatchProject: vi.fn(),
    watchProject: vi.fn(),
  }));

vi.mock('@lib/explorer/fs-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lib/explorer/fs-client')>()),
  hasFsBridge,
  onFsChanged,
  readRoot,
  unwatchProject,
  watchProject,
}));

let emitChange: ((event: FsChangedEvent) => void) | null = null;

/** A host with no markup: the hook is the subject. */
function Watcher() {
  useProjectWatcher();
  return null;
}

/**
 * Render, then let main's root verdict land.
 *
 * The watcher deliberately does not subscribe until it knows which root it is
 * watching — its events are reconciled against that key, and reconciling
 * against a guess is the bug the verdict exists to prevent. So every test here
 * has one await between mounting and watching.
 */
async function renderWatcher() {
  const result = render(<Watcher />);
  await act(async () => {
    await Promise.resolve();
  });
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  emitChange = null;
  /*
    The watcher waits for main's verdict on which root it is about to watch —
    reconciling the first burst of events against a guessed root is exactly what
    this indirection removed. So the tests have to answer.
  */
  hasFsBridge.mockReturnValue(true);
  readRoot.mockResolvedValue({
    ok: true,
    value: { root: '/w/nova-web', widened: false },
  });

  watchProject.mockResolvedValue(true);
  unwatchProject.mockResolvedValue(undefined);
  onFsChanged.mockImplementation((callback: (event: FsChangedEvent) => void) => {
    emitChange = callback;
    return () => {
      emitChange = null;
    };
  });

  useHiveStore.getState().reset();
  seedDemoFleet();
  seedDemoProjectConfig();
  useUiStore.getState().reset();
  useEditorStore.getState().reset();
  /**
   * The watcher watches whatever the explorer is rooted at, and since HIVE-93
   * that is the **active session's** project or nothing at all. Without a session
   * open there is no project to watch — which is correct, and is asserted
   * directly by "does not watch on the overmind tab" below.
   */
  useUiStore.getState().openTab('hero-refresh');
});

afterEach(() => {
  resetProjectConfig();
  useEditorStore.getState().reset();
});

describe('useProjectWatcher', () => {
  it('watches the visible project and stops on unmount', async () => {
    const { unmount } = await renderWatcher();

    // The session rides along so main can root the watcher where that session
    // is actually working — see `fs/session-roots.ts`.
    expect(watchProject).toHaveBeenCalledWith('nova-web', 'hero-refresh');

    unmount();
    expect(unwatchProject).toHaveBeenCalled();
  });

  it('follows the active session to another project', async () => {
    await renderWatcher();
    expect(watchProject).toHaveBeenLastCalledWith('nova-web', 'hero-refresh');

    await act(async () => {
      useUiStore.getState().openTab('webhooks');
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(watchProject).toHaveBeenLastCalledWith('referral-api', 'webhooks');
  });

  it('bumps the tree revision on a change', async () => {
    await renderWatcher();
    const before = useUiStore.getState().fsRevision;

    await act(async () => {
      emitChange?.({ projectId: 'nova-web', paths: ['src/app.ts'] });
    });

    expect(useUiStore.getState().fsRevision).toBe(before + 1);
  });

  /**
   * The second consumer, and the reason this hook is not in the rail: an open
   * buffer reconciles against the same events and outlives the tree.
   */
  it('reconciles open buffers on a change', async () => {
    // Spied before the render: the hook selects the action once, so a spy
    // installed afterwards would be watching a function nothing calls.
    const reconcile = vi.spyOn(useEditorStore.getState(), 'reconcile');
    await renderWatcher();

    await act(async () => {
      emitChange?.({ projectId: 'nova-web', paths: ['README.md'] });
    });

    /*
      The third argument is the root the watcher is rooted at. Without it,
      a change at `<worktree>/README.md` and one at `<project>/README.md`
      arrive as the same string and reconcile the wrong buffer.
    */
    expect(reconcile).toHaveBeenCalledWith('nova-web', ['README.md'], '');
  });

  it('ignores an event for another project', async () => {
    await renderWatcher();
    const before = useUiStore.getState().fsRevision;

    await act(async () => {
      emitChange?.({ projectId: 'somewhere-else', paths: ['a.ts'] });
    });

    expect(useUiStore.getState().fsRevision).toBe(before);
  });

  it('does not watch a project whose folder is unusable', () => {
    setProjectConfigForTest({
      ...emptySnapshot('/tmp/hive/config.json'),
      projects: [
        {
          id: 'nova-web',
          name: 'nova-web',
          path: null,
          icon: 'ph-folder',
          origin: 'local',
          status: 'missing',
          key: 'nw',
          isRepo: false,
        },
      ],
    });

    render(<Watcher />);

    expect(watchProject).not.toHaveBeenCalled();
  });

  /**
   * No session, no watcher (HIVE-93).
   *
   * The explorer shows nothing on the overmind tab, so there is nothing to keep
   * fresh — and a watcher running against a project the user is not looking at is
   * an fs subscription with no reader.
   */
  it('does not watch on the overmind tab', () => {
    useUiStore.getState().backToOrch();
    render(<Watcher />);

    expect(watchProject).not.toHaveBeenCalled();
  });

  it('does not watch when no project is mapped', () => {
    setProjectConfigForTest(emptySnapshot('/tmp/hive/config.json'));
    render(<Watcher />);

    expect(watchProject).not.toHaveBeenCalled();
  });

  /**
   * Re-armed on every reattach (HIVE-150).
   *
   * The watcher is per *surface* on the machine that answers it, and a
   * reconnect is a new surface: the server minted a fresh id for the returning
   * socket and released the old surface's watcher when it went away. Nothing
   * else here would ask again — the project, the session and the root are all
   * unchanged, and the panel never unmounted — so the explorer would go on
   * showing a tree it had stopped listening to, with nothing on screen to say
   * so. That is the shape of the defect HIVE-145 found when one client's
   * `fs:watch` silently stole another's.
   */
  describe('after a reattach', () => {
    const link = (epoch: number) => {
      act(() => {
        useHiveStore.getState().setRemoteLink({
          state: 'attached',
          serverName: 'mini',
          attempt: 0,
          nextAttemptAt: null,
          reason: null,
          epoch,
        });
      });
    };

    it('watches again, and releases the old watcher first', async () => {
      await renderWatcher();
      expect(watchProject).toHaveBeenCalledTimes(1);

      link(1);

      expect(watchProject).toHaveBeenCalledTimes(2);
      /*
        The effect's own cleanup ran in between. That matters beyond tidiness:
        the surface being released is the *old* one, and asking the new surface
        to watch without dropping the local subscription would leave two
        `onFsChanged` listeners reconciling the same burst twice.
      */
      expect(unwatchProject).toHaveBeenCalledTimes(1);
    });

    it('watches the same project and session it was watching', async () => {
      await renderWatcher();
      const first = watchProject.mock.calls[0];

      link(1);

      expect(watchProject.mock.calls[1]).toEqual(first);
    });

    it('does not re-arm while the link is merely reconnecting', async () => {
      await renderWatcher();
      expect(watchProject).toHaveBeenCalledTimes(1);

      act(() => {
        useHiveStore.getState().setRemoteLink({
          state: 'reconnecting',
          serverName: 'mini',
          attempt: 3,
          nextAttemptAt: Date.now() + 4_000,
          reason: null,
          epoch: 0,
        });
      });

      // There is no surface to watch on until there is a socket, and asking
      // now would only reject into the same swallowed error the drop produced.
      expect(watchProject).toHaveBeenCalledTimes(1);
    });
  });
});

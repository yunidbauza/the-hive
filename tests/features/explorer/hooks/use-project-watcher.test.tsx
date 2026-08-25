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

const { onFsChanged, unwatchProject, watchProject } = vi.hoisted(() => ({
  onFsChanged: vi.fn(),
  unwatchProject: vi.fn(),
  watchProject: vi.fn(),
}));

vi.mock('@lib/explorer/fs-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lib/explorer/fs-client')>()),
  onFsChanged,
  unwatchProject,
  watchProject,
}));

let emitChange: ((event: FsChangedEvent) => void) | null = null;

/** A host with no markup: the hook is the subject. */
function Watcher() {
  useProjectWatcher();
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  emitChange = null;

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
  it('watches the visible project and stops on unmount', () => {
    const { unmount } = render(<Watcher />);

    expect(watchProject).toHaveBeenCalledWith('nova-web');

    unmount();
    expect(unwatchProject).toHaveBeenCalled();
  });

  it('follows the active session to another project', async () => {
    render(<Watcher />);
    expect(watchProject).toHaveBeenLastCalledWith('nova-web');

    await act(async () => {
      useUiStore.getState().openTab('webhooks');
    });

    expect(watchProject).toHaveBeenLastCalledWith('referral-api');
  });

  it('bumps the tree revision on a change', async () => {
    render(<Watcher />);
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
    render(<Watcher />);

    await act(async () => {
      emitChange?.({ projectId: 'nova-web', paths: ['README.md'] });
    });

    expect(reconcile).toHaveBeenCalledWith('nova-web', ['README.md']);
  });

  it('ignores an event for another project', async () => {
    render(<Watcher />);
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
});

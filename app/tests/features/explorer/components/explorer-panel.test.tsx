import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExplorerPanel } from '@features/explorer/components/explorer-panel';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';
import { emptySnapshot } from '@shared/config-contract';
import type { DirEntry, FsChangedEvent } from '@shared/fs-contract';
import { useEditorStore } from '@stores/editor-store';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet, seedDemoProjectConfig } from '@tests/support/demo-fleet';

/**
 * The explorer panel, the tree it renders, and the watcher it owns.
 *
 * Driven through the fs-client rather than through `window.hive`, because the
 * client is the seam every component in this feature goes through and mocking
 * one layer lower would be asserting the preload's forwarding twice.
 */

const {
  hasFsBridge,
  onFsChanged,
  readDir,
  unwatchProject,
  watchProject,
} = vi.hoisted(() => ({
  hasFsBridge: vi.fn(),
  onFsChanged: vi.fn(),
  readDir: vi.fn(),
  unwatchProject: vi.fn(),
  watchProject: vi.fn(),
}));

vi.mock('@lib/explorer/fs-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lib/explorer/fs-client')>()),
  hasFsBridge,
  onFsChanged,
  readDir,
  unwatchProject,
  watchProject,
}));

const dir = (name: string): DirEntry => ({ name, kind: 'dir', size: 0 });
const file = (name: string): DirEntry => ({ name, kind: 'file', size: 10 });

/** A tree where `src/` holds one file and the root holds `src` and a README. */
function seedTree(): void {
  readDir.mockImplementation((_projectId: string, relPath: string) => {
    if (relPath === '') {
      return Promise.resolve({ ok: true, value: [dir('src'), file('README.md')] });
    }
    if (relPath === 'src') {
      return Promise.resolve({ ok: true, value: [file('app.ts')] });
    }
    return Promise.resolve({ ok: true, value: [] });
  });
}

/** The watcher callback the panel registered, if any. */
let emitChange: ((event: FsChangedEvent) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  emitChange = null;

  hasFsBridge.mockReturnValue(true);
  watchProject.mockResolvedValue(true);
  unwatchProject.mockResolvedValue(undefined);
  onFsChanged.mockImplementation((callback: (event: FsChangedEvent) => void) => {
    emitChange = callback;
    return () => {
      emitChange = null;
    };
  });
  seedTree();

  useHiveStore.getState().reset();
  seedDemoFleet();
  seedDemoProjectConfig();
  useUiStore.getState().reset();
  useEditorStore.getState().reset();
});

afterEach(() => {
  resetProjectConfig();
  useEditorStore.getState().reset();
});

const row = (name: string) => screen.getByRole('button', { name: new RegExp(name) });

describe('ExplorerPanel — degraded states', () => {
  /**
   * The browser demo. Checked before the project, because "there is no
   * filesystem here" is true regardless of the config — and in the demo the
   * config is empty too, so the projects message would blame the user for
   * something they cannot fix.
   */
  it('says it needs the desktop app when there is no bridge', () => {
    hasFsBridge.mockReturnValue(false);
    render(<ExplorerPanel />);

    expect(screen.getByText(/needs the desktop app/i)).toBeInTheDocument();
    expect(readDir).not.toHaveBeenCalled();
  });

  it('points at Settings when no projects are mapped', () => {
    setProjectConfigForTest(emptySnapshot('/tmp/hive/config.json'));
    render(<ExplorerPanel />);

    expect(screen.getByText(/No projects mapped/i)).toBeInTheDocument();
    expect(screen.getByText(/Settings → Projects/)).toBeInTheDocument();
  });

  it("renders the config's own reason when the project folder is unusable", async () => {
    setProjectConfigForTest({
      ...emptySnapshot('/tmp/hive/config.json'),
      projects: [
        {
          id: 'apfm-web',
          name: 'apfm-web',
          path: null,
          icon: 'ph-folder',
          origin: 'local',
          status: 'missing',
          isRepo: false,
        },
      ],
    });

    render(<ExplorerPanel />);

    await waitFor(() =>
      expect(screen.getByText(/missing/i)).toBeInTheDocument(),
    );
    expect(readDir).not.toHaveBeenCalled();
    expect(watchProject).not.toHaveBeenCalled();
  });

  it('surfaces a read failure instead of rendering a blank tree', async () => {
    readDir.mockResolvedValue({
      ok: false,
      error: { code: 'EACCES', message: 'the filesystem refused that operation' },
    });

    render(<ExplorerPanel />);

    expect(
      await screen.findByText(/the filesystem refused that operation/),
    ).toBeInTheDocument();
  });

  it('says so when the repository is empty', async () => {
    readDir.mockResolvedValue({ ok: true, value: [] });
    render(<ExplorerPanel />);

    expect(await screen.findByText(/This repository is empty/)).toBeInTheDocument();
  });
});

describe('ExplorerPanel — the tree', () => {
  it('roots at the active session’s project and lists it', async () => {
    useUiStore.getState().openTab('hero-refresh');
    render(<ExplorerPanel />);

    expect(await screen.findByText('README.md')).toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(readDir).toHaveBeenCalledWith('apfm-web', '');
  });

  /**
   * A collapsed directory is never read — that is what makes opening a
   * repository cheap, and what keeps a filtered `node_modules` from being
   * walked anyway.
   */
  it('does not read a directory until it is expanded', async () => {
    render(<ExplorerPanel />);
    await screen.findByText('README.md');

    expect(readDir).not.toHaveBeenCalledWith(expect.anything(), 'src');

    await userEvent.click(row('src'));

    expect(await screen.findByText('app.ts')).toBeInTheDocument();
    expect(readDir).toHaveBeenCalledWith('apfm-web', 'src');
  });

  it('collapses again, and collapse-all closes everything', async () => {
    render(<ExplorerPanel />);
    await screen.findByText('README.md');

    await userEvent.click(row('src'));
    expect(await screen.findByText('app.ts')).toBeInTheDocument();

    await userEvent.click(row('src'));
    expect(screen.queryByText('app.ts')).not.toBeInTheDocument();

    await userEvent.click(row('src'));
    await screen.findByText('app.ts');
    await userEvent.click(screen.getByRole('button', { name: /Collapse every folder/ }));
    expect(screen.queryByText('app.ts')).not.toBeInTheDocument();
  });

  it('opens a file into the editor store when its row is clicked', async () => {
    render(<ExplorerPanel />);
    await screen.findByText('README.md');

    await userEvent.click(row('README.md'));

    expect(useEditorStore.getState().openFiles.map((f) => f.relPath)).toEqual([
      'README.md',
    ]);
    expect(useEditorStore.getState().activeKey).toBe('apfm-web:README.md');
  });

  it('says when an expanded folder is empty', async () => {
    render(<ExplorerPanel />);
    await screen.findByText('README.md');
    await userEvent.click(row('src'));
    await screen.findByText('app.ts');

    // Only `src` empties — an empty *root* is a different message, and having
    // both fire at once would let this pass for the wrong reason.
    readDir.mockImplementation((_projectId: string, relPath: string) =>
      Promise.resolve({
        ok: true,
        value: relPath === '' ? [dir('src'), file('README.md')] : [],
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: /Refresh the tree/ }));

    expect(await screen.findByText('Empty folder.')).toBeInTheDocument();
  });
});

describe('ExplorerPanel — the watcher', () => {
  it('watches the visible project and stops on unmount', async () => {
    const { unmount } = render(<ExplorerPanel />);
    await screen.findByText('README.md');

    expect(watchProject).toHaveBeenCalledWith('apfm-web');

    unmount();
    expect(unwatchProject).toHaveBeenCalled();
  });

  it('re-reads the expanded directories when the project changes on disk', async () => {
    render(<ExplorerPanel />);
    await screen.findByText('README.md');
    await userEvent.click(row('src'));
    await screen.findByText('app.ts');

    const before = readDir.mock.calls.length;

    await act(async () => {
      emitChange?.({ projectId: 'apfm-web', paths: ['src/app.ts'] });
    });

    await waitFor(() =>
      expect(readDir.mock.calls.length).toBeGreaterThan(before),
    );
    // Both the root and the one expanded directory, not the collapsed ones.
    expect(readDir).toHaveBeenLastCalledWith('apfm-web', expect.any(String));
  });

  it('ignores an event for another project', async () => {
    render(<ExplorerPanel />);
    await screen.findByText('README.md');
    const before = readDir.mock.calls.length;

    await act(async () => {
      emitChange?.({ projectId: 'somewhere-else', paths: ['a.ts'] });
    });

    expect(readDir.mock.calls.length).toBe(before);
  });

  /**
   * The watcher's second job: an open buffer whose file changed underneath it
   * is reconciled by the editor store. Clean buffers reload silently.
   */
  it('reconciles open buffers on a change event', async () => {
    render(<ExplorerPanel />);
    await screen.findByText('README.md');

    const reconcile = vi.spyOn(useEditorStore.getState(), 'reconcile');

    await act(async () => {
      emitChange?.({ projectId: 'apfm-web', paths: ['README.md'] });
    });

    expect(reconcile).toHaveBeenCalledWith('apfm-web', ['README.md']);
  });
});

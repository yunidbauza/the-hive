import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExplorerPanel } from '@features/explorer/components/explorer-panel';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';
import { emptySnapshot } from '@shared/config-contract';
import type { DirEntry } from '@shared/fs-contract';
import { useEditorStore } from '@stores/editor-store';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet, seedDemoProjectConfig } from '@tests/support/demo-fleet';

/**
 * The explorer panel and the tree it renders.
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

beforeEach(() => {
  vi.clearAllMocks();

  hasFsBridge.mockReturnValue(true);
  watchProject.mockResolvedValue(true);
  unwatchProject.mockResolvedValue(undefined);
  onFsChanged.mockReturnValue(() => {});
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

  /**
   * The browser e2e cannot reach this state — the explorer needs the desktop
   * fs bridge — so the creature is pinned here instead.
   */
  it('leads the empty repository with a hive at rail size', async () => {
    readDir.mockResolvedValue({ ok: true, value: [] });
    render(<ExplorerPanel />);

    await screen.findByText(/This repository is empty/);
    const img = screen.getByRole('presentation', { hidden: true });

    expect(img).toHaveAttribute('data-creature', 'hive');
    expect(img).toHaveStyle({ height: '44px' });
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

describe('ExplorerPanel — refreshing', () => {
  /**
   * The panel no longer owns the watcher — `useProjectWatcher` does, at the
   * composition root, because an open editor buffer outlives the rail tab that
   * shows this tree. What the panel still owns is re-reading when the shared
   * revision changes, whichever of the two bumped it.
   */
  it('re-reads the expanded directories when the revision changes', async () => {
    render(<ExplorerPanel />);
    await screen.findByText('README.md');
    await userEvent.click(row('src'));
    await screen.findByText('app.ts');

    const before = readDir.mock.calls.length;

    await act(async () => {
      useUiStore.getState().bumpFsRevision();
    });

    await waitFor(() =>
      expect(readDir.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it('does not subscribe to the filesystem itself', async () => {
    render(<ExplorerPanel />);
    await screen.findByText('README.md');

    // The subscription belongs to the hook at the composition root. A panel
    // that also subscribed would double-reconcile every event.
    expect(onFsChanged).not.toHaveBeenCalled();
    expect(watchProject).not.toHaveBeenCalled();
  });
});

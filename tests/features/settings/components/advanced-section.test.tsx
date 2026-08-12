import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptySnapshot, type ConfigSnapshot } from '@shared/config-contract';
import type { AppInfo } from '@shared/ipc-contract';

import { AdvancedSection } from '@features/settings/components/advanced-section';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';

/**
 * Advanced & diagnostics (story 107).
 *
 * The bridge is mocked at the `@lib/project-config` seam, like every other
 * settings section's test — components never reach `window.hive` directly, so
 * that is the only boundary worth faking.
 */

const readAppInfo = vi.fn();
const revealConfigFile = vi.fn();
const resetConfigToTemplate = vi.fn();
const reloadProjectConfig = vi.fn();

vi.mock('@/lib/project-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/project-config')>();
  return {
    ...actual,
    readAppInfo: () => readAppInfo(),
    revealConfigFile: () => revealConfigFile(),
    resetConfigToTemplate: () => resetConfigToTemplate(),
    reloadProjectConfig: () => reloadProjectConfig(),
  };
});

const CONFIG_PATH = '/Users/me/.hive/config.json';

const info = (over: Partial<AppInfo> = {}): AppInfo => ({
  version: '0.1.0',
  electron: '38.0.0',
  chrome: '140.0.0',
  node: '22.0.0',
  platform: 'darwin',
  logPath: '/Users/me/Library/Logs/The Hive',
  ...over,
});

const install = (over: Partial<ConfigSnapshot> = {}): void => {
  setProjectConfigForTest({ ...emptySnapshot(CONFIG_PATH), ...over });
};

const project = (id: string): ConfigSnapshot['projects'][number] => ({
  id,
  name: id,
  path: `/repos/${id}`,
  icon: 'ph-folder',
  origin: 'local',
  status: 'ok',
  isRepo: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  readAppInfo.mockResolvedValue(info());
  revealConfigFile.mockResolvedValue(undefined);
  resetConfigToTemplate.mockResolvedValue(undefined);
  reloadProjectConfig.mockResolvedValue(undefined);
  install();
});

afterEach(() => {
  resetProjectConfig();
});

describe('AdvancedSection', () => {
  it('shows the config path and reveals it', async () => {
    render(<AdvancedSection />);
    expect(screen.getByText(CONFIG_PATH)).toBeInTheDocument();

    await userEvent.click(
      await screen.findByRole('button', { name: /reveal in finder/i }),
    );
    expect(revealConfigFile).toHaveBeenCalledTimes(1);
  });

  /**
   * From `AppInfo.platform`, not the user agent — Electron's is a Chrome UA and
   * lies by design (story 083).
   */
  it('names the platform file manager', async () => {
    readAppInfo.mockResolvedValue(info({ platform: 'win32' }));
    render(<AdvancedSection />);

    expect(
      await screen.findByRole('button', { name: /reveal in explorer/i }),
    ).toBeInTheDocument();
  });

  it('falls back to a neutral label on an unnamed platform', async () => {
    readAppInfo.mockResolvedValue(info({ platform: 'linux' }));
    render(<AdvancedSection />);

    expect(
      await screen.findByRole('button', { name: /show in file manager/i }),
    ).toBeInTheDocument();
  });

  it('explains why the file is not watched until a reload has happened', () => {
    render(<AdvancedSection />);
    expect(screen.getByText(/deliberately not watched/i)).toBeInTheDocument();
  });

  /**
   * The count must come from the snapshot the reload *installed*, never from
   * the render's closure — which is by definition the pre-reload one.
   */
  it('reports what a reload found', async () => {
    render(<AdvancedSection />);

    reloadProjectConfig.mockImplementation(() => {
      install({ projects: [project('alpha')] });
      return Promise.resolve();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));

    expect(reloadProjectConfig).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Reloaded — 1 project.')).toBeInTheDocument();
  });

  it('pluralises the reload count', async () => {
    render(<AdvancedSection />);

    reloadProjectConfig.mockImplementation(() => {
      install({ projects: [project('alpha'), project('beta')] });
      return Promise.resolve();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));

    expect(await screen.findByText('Reloaded — 2 projects.')).toBeInTheDocument();
  });

  it('reports problems rather than a count when the reload found some', async () => {
    render(<AdvancedSection />);

    reloadProjectConfig.mockImplementation(() => {
      install({ errors: ['config: not a directory'] });
      return Promise.resolve();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));

    expect(await screen.findByText('Reloaded — 1 problem, listed above.')).toBeInTheDocument();
    // And the problem itself is on screen, verbatim, which is what "above" means.
    expect(screen.getByText('config: not a directory')).toBeInTheDocument();
  });

  it('does not reset until the confirmation is accepted', async () => {
    render(<AdvancedSection />);

    await userEvent.click(screen.getByRole('button', { name: 'Reset to template' }));
    expect(resetConfigToTemplate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(resetConfigToTemplate).not.toHaveBeenCalled();
    // Backing out returns the group to its button rather than stranding it.
    expect(
      screen.getByRole('button', { name: 'Reset to template' }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Reset to template' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reset config' }));
    expect(resetConfigToTemplate).toHaveBeenCalledTimes(1);
  });

  it('tells the confirmation how many projects are at stake', async () => {
    install({ projects: [project('alpha'), project('beta')] });
    render(<AdvancedSection />);

    await userEvent.click(screen.getByRole('button', { name: 'Reset to template' }));

    expect(screen.getByText(/2 projects,/)).toBeInTheDocument();
  });

  it('shows the versions and the log path, and is honest about the log', async () => {
    render(<AdvancedSection />);

    expect(await screen.findByText('0.1.0')).toBeInTheDocument();
    expect(screen.getByText('38.0.0')).toBeInTheDocument();
    expect(screen.getByText('140.0.0')).toBeInTheDocument();
    expect(screen.getByText('22.0.0')).toBeInTheDocument();
    expect(screen.getByText('/Users/me/Library/Logs/The Hive')).toBeInTheDocument();
    expect(screen.getByText(/writes no log file/i)).toBeInTheDocument();
  });

  /**
   * `pty` is omitted rather than empty when nothing has run, precisely so this
   * can be distinguished from "sessions ran and moved no bytes".
   */
  it('says so when no session has ever run', async () => {
    render(<AdvancedSection />);
    expect(await screen.findByText(/no session has run yet/i)).toBeInTheDocument();
  });

  it('renders the counters and refreshes them on demand', async () => {
    readAppInfo.mockResolvedValue(
      info({
        pty: [
          {
            sessionId: 's1',
            bytesIn: 2048,
            bytesAcked: 1024,
            unacked: 1024,
            pauses: 2,
            batches: 8,
            dropped: 0,
            paused: true,
          },
        ],
      }),
    );
    render(<AdvancedSection />);

    expect(await screen.findByText('s1')).toBeInTheDocument();
    // Raw, not humanised — the ratios are what diagnose a flow-control bug.
    expect(screen.getByText('2048')).toBeInTheDocument();
    expect(screen.getByText('paused')).toBeInTheDocument();
    expect(readAppInfo).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(readAppInfo).toHaveBeenCalledTimes(2);
    });
  });

  it('renders no pause marker for a session that is flowing', async () => {
    readAppInfo.mockResolvedValue(
      info({
        pty: [
          {
            sessionId: 's2',
            bytesIn: 10,
            bytesAcked: 10,
            unacked: 0,
            pauses: 0,
            batches: 1,
            dropped: 0,
            paused: false,
          },
        ],
      }),
    );
    render(<AdvancedSection />);

    expect(await screen.findByText('s2')).toBeInTheDocument();
    expect(screen.queryByText('paused')).not.toBeInTheDocument();
  });

  /**
   * Three states, and collapsing any two would make the pane lie.
   *
   * A failed channel is *not* "nothing has run" — that would assert a fact the
   * pane does not have, which is the one thing this surface must never do.
   */
  it('says so rather than inventing versions when the channel fails', async () => {
    readAppInfo.mockResolvedValue(null);
    render(<AdvancedSection />);

    expect(await screen.findByText('Reading…')).toBeInTheDocument();
    expect(screen.queryByText(/writes no log file/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/could not read diagnostics/i),
    ).toBeInTheDocument();
    // The claim it must not make: nothing was asked, so nothing is known.
    expect(screen.queryByText(/no session has run yet/i)).not.toBeInTheDocument();
  });

  it('degrades to a sentence with no bridge', () => {
    setProjectConfigForTest(null);
    render(<AdvancedSection />);

    expect(
      screen.getByText(/only available in the desktop app/i),
    ).toBeInTheDocument();
    expect(readAppInfo).not.toHaveBeenCalled();
  });
});

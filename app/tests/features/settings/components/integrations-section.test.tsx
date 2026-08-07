import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  emptySnapshot,
  type ConfigSnapshot,
  type NotificationPrefs,
} from '@shared/config-contract';
import type { GhStatus, IntegrationsStatus } from '@shared/ipc-contract';
import type { JiraStatus } from '@shared/jira-contract';

import { IntegrationsSection } from '@features/settings/components/integrations-section';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';

const setNotificationPrefs = vi.fn();
const readIntegrationsStatus = vi.fn();
const readJiraStatus = vi.fn<() => Promise<JiraStatus | null>>();

vi.mock('@/lib/jira', () => ({
  readJiraStatus: () => readJiraStatus(),
  saveJiraToken: () => Promise.resolve(null),
  clearJiraToken: () => Promise.resolve(null),
  testJiraConnection: () => Promise.resolve(null),
}));

vi.mock('@/lib/project-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/project-config')>();
  return {
    ...actual,
    setNotificationPrefs: (request: unknown) => setNotificationPrefs(request),
    readIntegrationsStatus: () => readIntegrationsStatus(),
  };
});

const gh = (over: Partial<GhStatus> = {}): GhStatus => ({
  installed: true,
  resolved: '/opt/homebrew/bin/gh',
  path: '/usr/bin:/opt/homebrew/bin',
  probes: [
    { directory: '/usr/bin', found: false },
    { directory: '/opt/homebrew/bin', found: true },
  ],
  version: '2.62.0',
  authenticated: true,
  account: 'octocat',
  tokenSource: 'keyring',
  envVar: null,
  error: null,
  ...over,
});

const status = (over: Partial<IntegrationsStatus> = {}): IntegrationsStatus => ({
  gh: gh(),
  notificationsSupported: true,
  ...over,
});

const install = (notifications?: Partial<NotificationPrefs>): void => {
  const base: ConfigSnapshot = emptySnapshot('/tmp/hive/config.json');
  setProjectConfigForTest({
    ...base,
    notifications: { ...base.notifications, ...notifications },
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  readIntegrationsStatus.mockResolvedValue(status());
  readJiraStatus.mockResolvedValue({
    site: null,
    email: null,
    siteSource: null,
    emailSource: null,
    credential: { kind: 'none' },
    encryptionAvailable: true,
  });
  install();
});

afterEach(() => {
  resetProjectConfig();
});

describe('IntegrationsSection — the GitHub CLI', () => {
  it('reports where gh was found, and its version', async () => {
    render(<IntegrationsSection />);

    expect(await screen.findByText('/opt/homebrew/bin/gh')).toBeInTheDocument();
    expect(screen.getByText(/2\.62\.0/)).toBeInTheDocument();
  });

  it('names the signed-in account', async () => {
    render(<IntegrationsSection />);

    expect(await screen.findByText(/octocat/)).toBeInTheDocument();
  });

  it('explains where it looked when gh is not installed', async () => {
    readIntegrationsStatus.mockResolvedValue(
      status({
        gh: gh({
          installed: false,
          resolved: null,
          version: null,
          authenticated: false,
          account: null,
          tokenSource: 'none',
          probes: [{ directory: '/usr/bin', found: false }],
        }),
      }),
    );

    render(<IntegrationsSection />);

    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
    expect(screen.getByText('/usr/bin')).toBeInTheDocument();
  });

  it('says so plainly when gh is installed but not signed in', async () => {
    readIntegrationsStatus.mockResolvedValue(
      status({
        gh: gh({ authenticated: false, account: null, tokenSource: 'none' }),
      }),
    );

    render(<IntegrationsSection />);

    expect(await screen.findByText(/not signed in/i)).toBeInTheDocument();
  });

  it('surfaces an error without pretending it is an answer', async () => {
    readIntegrationsStatus.mockResolvedValue(
      status({ gh: gh({ error: 'spawn ETIMEDOUT', authenticated: false }) }),
    );

    render(<IntegrationsSection />);

    expect(await screen.findByText(/ETIMEDOUT/)).toBeInTheDocument();
  });
});

describe('IntegrationsSection — the token source', () => {
  it('says the PR list is fixture-backed and that nothing here stores a token', async () => {
    render(<IntegrationsSection />);

    expect(await screen.findByText(/does not store a token/i)).toBeInTheDocument();
  });

  it('names the environment variable when that is where a token would come from', async () => {
    readIntegrationsStatus.mockResolvedValue(
      status({ gh: gh({ tokenSource: 'env', envVar: 'GH_TOKEN' }) }),
    );

    render(<IntegrationsSection />);

    expect(await screen.findByText(/GH_TOKEN/)).toBeInTheDocument();
  });

  it('does not tell you to run gh auth login when gh is not installed', async () => {
    readIntegrationsStatus.mockResolvedValue(
      status({
        gh: gh({
          installed: false,
          resolved: null,
          version: null,
          authenticated: false,
          account: null,
          tokenSource: 'none',
        }),
      }),
    );

    render(<IntegrationsSection />);

    expect(await screen.findByText(/No token source/i)).toBeInTheDocument();
    // Advising a command the machine does not have is worse than saying nothing.
    expect(screen.queryByText(/gh auth login/)).toBeNull();
  });

  it('reports the keyring when gh holds the credential itself', async () => {
    render(<IntegrationsSection />);

    expect(await screen.findByText(/keychain|keyring/i)).toBeInTheDocument();
  });
});

describe('IntegrationsSection — notifications', () => {
  it('offers exactly the three classes that are backed by a real event', async () => {
    render(<IntegrationsSection />);

    const switches = await screen.findAllByRole('switch');
    expect(switches).toHaveLength(3);
  });

  it('offers no switch for waiting — the event does not exist', async () => {
    render(<IntegrationsSection />);

    await screen.findAllByRole('switch');
    expect(screen.queryByRole('switch', { name: /waiting/i })).toBeNull();
  });

  it('shows each class in the state the config says it is in', async () => {
    install({ sessionDone: true, sessionIdle: false, cloneDone: false });
    render(<IntegrationsSection />);

    const done = await screen.findByRole('switch', { name: /session finishes/i });
    const clone = screen.getByRole('switch', { name: /clone finishes/i });

    expect(done).toHaveAttribute('aria-checked', 'true');
    expect(clone).toHaveAttribute('aria-checked', 'false');
  });

  it('writes only the class that was toggled', async () => {
    render(<IntegrationsSection />);

    await userEvent.click(
      await screen.findByRole('switch', { name: /session finishes/i }),
    );

    expect(setNotificationPrefs).toHaveBeenCalledWith({ sessionDone: false });
  });

  it('does not re-run the gh probe when a switch is toggled', async () => {
    /**
     * Every mutating verb installs a *fresh* snapshot object, so an effect keyed
     * on the snapshot re-runs on each save. That would put two `gh` subprocess
     * spawns behind every click of a switch — for an answer that cannot have
     * changed, since nothing here installs or signs into `gh`.
     */
    render(<IntegrationsSection />);
    await screen.findAllByRole('switch');

    // What a real save does: main returns a fresh snapshot and it is installed.
    act(() => {
      install({ sessionDone: false });
    });
    await screen.findByRole('switch', { name: /session finishes/i });

    expect(readIntegrationsStatus).toHaveBeenCalledTimes(1);
  });

  it('replaces the switches with an explanation when the OS cannot show them', async () => {
    readIntegrationsStatus.mockResolvedValue(
      status({ notificationsSupported: false }),
    );

    render(<IntegrationsSection />);

    expect(
      await screen.findByText(/cannot show notifications/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('IntegrationsSection — without a bridge', () => {
  it('says the section is desktop-only rather than rendering empty state', () => {
    resetProjectConfig();
    render(<IntegrationsSection />);

    expect(
      screen.getByText(/only available in the desktop app/i),
    ).toBeInTheDocument();
  });

  it('asks main for nothing when there is no snapshot to ask about', () => {
    resetProjectConfig();
    render(<IntegrationsSection />);

    expect(readIntegrationsStatus).not.toHaveBeenCalled();
  });
});

/**
 * HIVE-67's two groups, asserted from the section rather than in isolation.
 *
 * What this covers that the group suites cannot: that the section reads the
 * Jira status on open, and that both groups are actually mounted — a component
 * with perfect unit tests and no call site renders nowhere.
 */
describe('IntegrationsSection — Jira', () => {
  it('reads the Jira status when the pane opens', async () => {
    render(<IntegrationsSection />);

    await screen.findByText('Jira site');
    expect(readJiraStatus).toHaveBeenCalledTimes(1);
  });

  it('renders both groups', async () => {
    render(<IntegrationsSection />);

    expect(await screen.findByText('Jira site')).toBeInTheDocument();
    // By role: "API token" is both the group heading and the field's label.
    expect(
      screen.getByRole('heading', { name: 'API token' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Site')).toBeInTheDocument();
    expect(screen.getByLabelText('Account email')).toBeInTheDocument();
    expect(screen.getByLabelText('API token')).toBeInTheDocument();
  });

  it('says it is checking until the status arrives', () => {
    let resolve: (value: JiraStatus | null) => void = () => {};
    readJiraStatus.mockReturnValue(
      new Promise<JiraStatus | null>((done) => {
        resolve = done;
      }),
    );

    render(<IntegrationsSection />);

    expect(screen.getAllByText('Checking\u2026').length).toBeGreaterThan(0);
    resolve(null);
  });
});

import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  emptySnapshot,
  type ConfigSnapshot,
  type NotificationPrefs,
} from '@shared/config-contract';
import type {
  GhStatus,
  IntegrationsStatus,
  LoginEnvStatus,
} from '@shared/ipc-contract';
import type { JiraStatus } from '@shared/jira-contract';

import { PHRASES } from '@lib/swarm/phrases';
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

/**
 * The ordinary post-HIVE-84 state: the import ran and replaced the `PATH`.
 *
 * Defaulted to the *succeeded* case because that is what every pre-existing
 * assertion in this file is implicitly about — a `gh` that was found, on a
 * `PATH` that was imported. The failure and disabled shapes are passed
 * explicitly by the tests that are about them.
 */
const loginEnv = (over: Partial<LoginEnvStatus> = {}): LoginEnvStatus => ({
  enabled: true,
  imported: true,
  shell: '/bin/zsh',
  inheritedEntries: 4,
  effectiveEntries: 12,
  varsImported: ['PATH'],
  error: null,
  ...over,
});

const status = (over: Partial<IntegrationsStatus> = {}): IntegrationsStatus => ({
  gh: gh(),
  loginEnv: loginEnv(),
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

/**
 * The PATH source group (HIVE-84).
 *
 * Four states, and the distinction between them is the whole feature: a user
 * who cannot tell an imported `PATH` from an inherited one cannot tell a
 * broken import from a genuinely missing binary.
 */
describe('IntegrationsSection — why gh was not found', () => {
  const notInstalled = () =>
    gh({
      installed: false,
      resolved: null,
      version: null,
      authenticated: false,
      account: null,
      tokenSource: 'none',
      probes: [{ directory: '/usr/bin', found: false }],
    });

  /**
   * The cross-pane pointer, which is the only thing keeping this copy honest.
   *
   * PATH source lives in Runtime now, so these branches send the reader there
   * by name. That sentence is the one part of the move a rename or another
   * shuffle can silently break — the pane it names is not this one, so nothing
   * else in this file would notice. It was left with no assertion at all when
   * the PATH-source tests moved out; this is that assertion.
   */
  it('points a failed import at the pane that explains it', async () => {
    readIntegrationsStatus.mockResolvedValue(
      status({
        gh: notInstalled(),
        loginEnv: loginEnv({
          imported: false,
          varsImported: [],
          effectiveEntries: 4,
          error: 'the shell did not finish within 5s and was killed (SIGKILL)',
        }),
      }),
    );

    render(<IntegrationsSection />);

    expect(
      await screen.findByText(/Settings → Runtime → PATH source/),
    ).toBeInTheDocument();
    // And it does not claim to show the PATH itself — that group left.
    expect(screen.queryByText(/the PATH below/)).not.toBeInTheDocument();
  });

  /**
   * The copy that HIVE-84 made conditional.
   *
   * The old fixed sentence — "installing gh where that PATH can see it is the
   * fix" — is now wrong in the ordinary case, and sends a user who simply has
   * not installed `gh` looking for an environment problem they do not have.
   */
  it('blames the missing binary when the PATH really is the login shell’s', async () => {
    readIntegrationsStatus.mockResolvedValue(status({ gh: notInstalled() }));

    render(<IntegrationsSection />);

    expect(await screen.findByText(/brew install gh/)).toBeInTheDocument();
    expect(screen.getByText(/not installed anywhere this app can reach/)).toBeInTheDocument();
  });

  /**
   * The branch that was wrong on the first pass.
   *
   * Launched from a terminal: the probe ran, the shell had nothing to add, so
   * `imported` is false with **no error** — and the PATH is nevertheless
   * exactly the login shell's. Leading the branches with `imported` filed this
   * under "the import did not run", which contradicted the PATH source group
   * one box below and sent a user who had simply not installed `gh` hunting an
   * environment problem.
   */
  it('blames the missing binary when there was simply nothing to import', async () => {
    readIntegrationsStatus.mockResolvedValue(
      status({
        gh: notInstalled(),
        loginEnv: loginEnv({
          imported: false,
          varsImported: [],
          inheritedEntries: 12,
          effectiveEntries: 12,
          error: null,
        }),
      }),
    );

    render(<IntegrationsSection />);

    expect(await screen.findByText(/brew install gh/)).toBeInTheDocument();
    // And it must not contradict the group directly below it.
    expect(screen.queryByText(/the import did not run/)).not.toBeInTheDocument();
  });

  it('blames the environment when the import is off', async () => {
    readIntegrationsStatus.mockResolvedValue(
      status({
        gh: notInstalled(),
        loginEnv: loginEnv({ enabled: false, imported: false, shell: null }),
      }),
    );

    render(<IntegrationsSection />);

    expect(
      await screen.findByText(/Switch the login-shell import on/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/brew install gh/)).not.toBeInTheDocument();
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

    await screen.findByRole('heading', { name: 'Site' });
    expect(readJiraStatus).toHaveBeenCalledTimes(1);
  });

  it('renders both groups', async () => {
    render(<IntegrationsSection />);

    /*
      By role for both, now that the provider band above says "Jira" and the
      group titles have shed the prefix: "Site" and "API token" are each both a
      group heading and a field label, so plain text would match two nodes.
    */
    expect(
      await screen.findByRole('heading', { name: 'Site' }),
    ).toBeInTheDocument();
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

    /**
     * The verb is drawn from a pool, so this asserts the section says it is
     * busy — in whichever words it drew — rather than pinning one of them.
     */
    const busy = PHRASES['loading.diagnostics'].flatMap((verb) =>
      screen.queryAllByText(verb),
    );

    expect(busy.length).toBeGreaterThan(0);
    resolve(null);
  });
});

/**
 * HIVE — the hierarchy pass.
 *
 * The pane was six equal groups with nothing saying three were GitHub's and
 * three were Jira's. These assert the two things that fixed it: that the bands
 * exist and are named, and that a group inside one draws no rule of its own.
 */
describe('IntegrationsSection — the provider bands', () => {
  it('names each provider once, above its groups', async () => {
    render(<IntegrationsSection />);

    expect(
      await screen.findByRole('region', { name: 'GitHub' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Jira' })).toBeInTheDocument();
  });

  it('puts the GitHub groups inside the GitHub band, and Jira’s inside Jira’s', async () => {
    render(<IntegrationsSection />);

    const github = await screen.findByRole('region', { name: 'GitHub' });
    const jira = screen.getByRole('region', { name: 'Jira' });

    expect(
      within(github).getByRole('heading', { name: 'Token source' }),
    ).toBeInTheDocument();
    expect(
      within(github).getByRole('heading', { name: 'Command line' }),
    ).toBeInTheDocument();
    expect(
      within(jira).getByRole('heading', { name: 'Site' }),
    ).toBeInTheDocument();
    expect(
      within(github).queryByRole('heading', { name: 'Site' }),
    ).not.toBeInTheDocument();
  });

  /**
   * The band's own hairline is the only line. A rule under every group inside
   * it would put four where the eye needs one — which is the whole complaint
   * the bands answer.
   */
  it('draws no divider under a group inside a band', async () => {
    render(<IntegrationsSection />);

    const heading = await screen.findByRole('heading', { name: 'Token source' });
    const group = heading.closest('section');

    expect(group).not.toBeNull();
    expect(group?.className).not.toContain('border-b');
  });

  /**
   * PATH source is Runtime's now — it describes the environment every session
   * spawns into, not GitHub. What stays is the probe list, which is about `gh`
   * and nothing else.
   */
  it('no longer carries the PATH source group', async () => {
    render(<IntegrationsSection />);

    await screen.findByRole('heading', { name: 'Command line' });
    expect(
      screen.queryByRole('heading', { name: 'PATH source' }),
    ).not.toBeInTheDocument();
  });
});

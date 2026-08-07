import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { JiraCredentialGroup } from '@features/settings/components/jira-credential-group';
import type {
  JiraCredentialState,
  JiraIdentity,
  JiraResult,
  JiraStatus,
} from '@shared/jira-contract';

/**
 * The credential group (HIVE-67).
 *
 * This is where all four states of the union are proven to render, because it
 * is the only place they can be: two of them are unreachable in a real Electron
 * app, since `unavailable` needs a machine whose `safeStorage` cannot encrypt
 * and `stored` would mean writing a token into a CI runner's keychain. The e2e
 * spec covers the two that are reachable there.
 */

const saveJiraToken = vi.fn((_token: string) => Promise.resolve(null));
const clearJiraToken = vi.fn(() => Promise.resolve(null));
const testJiraConnection = vi.fn<() => Promise<JiraResult<JiraIdentity> | null>>(
  () => Promise.resolve(null),
);

vi.mock('@/lib/jira', () => ({
  saveJiraToken: (token: string) => saveJiraToken(token),
  clearJiraToken: () => clearJiraToken(),
  testJiraConnection: () => testJiraConnection(),
  readJiraStatus: () => Promise.resolve(null),
}));

const status = (
  credential: JiraCredentialState,
  over: Partial<JiraStatus> = {},
): JiraStatus => ({
  site: 'behiques.atlassian.net',
  email: 'me@example.com',
  credential,
  encryptionAvailable: true,
  ...over,
});

const draw = (value: JiraStatus, onChanged = vi.fn()) => {
  render(<JiraCredentialGroup status={value} onChanged={onChanged} />);
  return onChanged;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the four credential states', () => {
  it('says nothing is stored in the none state', () => {
    draw(status({ kind: 'none' }));
    expect(screen.getByText(/No token stored/i)).toBeInTheDocument();
  });

  it('names the account in the stored state', () => {
    draw(status({ kind: 'stored', email: 'me@example.com' }));
    expect(screen.getByText(/A token is stored for/i)).toBeInTheDocument();
    expect(screen.getByText('me@example.com')).toBeInTheDocument();
  });

  it('names JIRA_API_KEY in the env state', () => {
    draw(status({ kind: 'env', variable: 'JIRA_API_KEY' }));
    expect(screen.getByText('JIRA_API_KEY')).toBeInTheDocument();
    expect(
      screen.getByText(/that is the token being used/i),
    ).toBeInTheDocument();
  });

  it("shows main's own reason in the unavailable state", () => {
    draw(
      status(
        { kind: 'unavailable', reason: 'No keyring here. Set JIRA_API_KEY.' },
        { encryptionAvailable: false },
      ),
    );
    expect(
      screen.getByText('No keyring here. Set JIRA_API_KEY.'),
    ).toBeInTheDocument();
  });
});

describe('when this machine cannot encrypt', () => {
  it('hides the token field entirely — absent, not disabled', () => {
    draw(
      status(
        { kind: 'unavailable', reason: 'no keyring' },
        { encryptionAvailable: false },
      ),
    );
    expect(screen.queryByLabelText('API token')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save' }),
    ).not.toBeInTheDocument();
  });

  it('still says what to do instead', () => {
    draw(
      status(
        { kind: 'env', variable: 'JIRA_API_KEY' },
        { encryptionAvailable: false },
      ),
    );
    expect(
      screen.getByText(/will not write a token in plaintext/i),
    ).toBeInTheDocument();
  });
});

describe('writing', () => {
  it('offers Clear only when a token is stored', () => {
    draw(status({ kind: 'none' }));
    expect(
      screen.queryByRole('button', { name: 'Clear' }),
    ).not.toBeInTheDocument();
  });

  it('offers Clear in the stored state, and calls the verb', async () => {
    const user = userEvent.setup();
    const onChanged = draw(status({ kind: 'stored', email: 'me@example.com' }));

    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(clearJiraToken).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('refuses to save an empty field', async () => {
    const user = userEvent.setup();
    draw(status({ kind: 'none' }));

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveJiraToken).not.toHaveBeenCalled();
  });

  it('saves what was typed and clears the field afterwards', async () => {
    const user = userEvent.setup();
    const onChanged = draw(status({ kind: 'none' }));

    const input = screen.getByLabelText('API token');
    await user.type(input, 'ATATT-typed');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveJiraToken).toHaveBeenCalledWith('ATATT-typed');
    // A token left in React state is a token in every heap snapshot from here.
    await waitFor(() => expect(input).toHaveValue(''));
    expect(onChanged).toHaveBeenCalled();
  });

  it('trims surrounding whitespace from a pasted token', async () => {
    const user = userEvent.setup();
    draw(status({ kind: 'none' }));

    await user.type(screen.getByLabelText('API token'), '  ATATT-padded  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveJiraToken).toHaveBeenCalledWith('ATATT-padded');
  });
});

describe('testing the connection', () => {
  it('shows the display name on success', async () => {
    const user = userEvent.setup();
    testJiraConnection.mockResolvedValueOnce({
      ok: true,
      value: { displayName: 'Yunid Bauza', accountId: '712020:9f3c' },
    });
    draw(status({ kind: 'stored', email: 'me@example.com' }));

    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText(/Signed in as/i)).toBeInTheDocument();
    expect(screen.getByText('Yunid Bauza')).toBeInTheDocument();
  });

  it("reports a 401 with Jira's own words and does not clear the credential", async () => {
    const user = userEvent.setup();
    testJiraConnection.mockResolvedValueOnce({
      ok: false,
      error: {
        kind: 'unauthorized',
        message: 'Jira rejected the credential.',
      },
    });
    draw(status({ kind: 'stored', email: 'me@example.com' }));

    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(
      await screen.findByText('Jira rejected the credential.'),
    ).toBeInTheDocument();
    // A transient 401 must not destroy the user's credential.
    expect(clearJiraToken).not.toHaveBeenCalled();
    expect(screen.getByText(/A token is stored for/i)).toBeInTheDocument();
  });

  it('distinguishes a broken channel from a Jira refusal', async () => {
    const user = userEvent.setup();
    testJiraConnection.mockResolvedValueOnce(null);
    draw(status({ kind: 'stored', email: 'me@example.com' }));

    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(
      await screen.findByText(/could not reach its own main process/i),
    ).toBeInTheDocument();
  });

  it('re-reads the status after a test', async () => {
    const user = userEvent.setup();
    const onChanged = draw(status({ kind: 'stored', email: 'me@example.com' }));

    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});

describe('the copy', () => {
  it('says the token cannot be read back', () => {
    draw(status({ kind: 'stored', email: 'me@example.com' }));
    expect(screen.getByText(/no way to read it back/i)).toBeInTheDocument();
  });

  it('says the token is not in the config file', () => {
    draw(status({ kind: 'none' }));
    expect(screen.getByText('~/.hive/config.json')).toBeInTheDocument();
  });
});

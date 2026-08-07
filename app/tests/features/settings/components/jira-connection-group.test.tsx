import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { JiraConnectionGroup } from '@features/settings/components/jira-connection-group';
import type { JiraStatus } from '@shared/jira-contract';

/**
 * The connection group (HIVE-67).
 *
 * Two ordinary settings fields. What is worth testing is the *write* shape:
 * only the field that changed is named, an emptied field clears rather than
 * storing `""`, and an unchanged field writes nothing at all — a settings pane
 * that saves on every blur would rewrite the config file every time the user
 * tabbed through it.
 */

const setJiraConnection = vi.fn((_request: unknown) => Promise.resolve());

vi.mock('@/lib/project-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/project-config')>();
  return {
    ...actual,
    setJiraConnection: (request: unknown) => setJiraConnection(request),
  };
});

const status = (over: Partial<JiraStatus> = {}): JiraStatus => ({
  site: 'behiques.atlassian.net',
  email: 'me@example.com',
  credential: { kind: 'none' },
  encryptionAvailable: true,
  ...over,
});

const draw = (value: JiraStatus = status(), onChanged = vi.fn()) => {
  render(<JiraConnectionGroup status={value} onChanged={onChanged} />);
  return onChanged;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('rendering', () => {
  it('shows the configured site and email', () => {
    draw();
    expect(screen.getByLabelText('Site')).toHaveValue(
      'behiques.atlassian.net',
    );
    expect(screen.getByLabelText('Account email')).toHaveValue(
      'me@example.com',
    );
  });

  it('shows empty fields when nothing is configured', () => {
    draw(status({ site: null, email: null }));
    expect(screen.getByLabelText('Site')).toHaveValue('');
    expect(screen.getByLabelText('Account email')).toHaveValue('');
  });

  it('says where these two live', () => {
    draw();
    expect(screen.getByText(/~\/\.hive\/config\.json/)).toBeInTheDocument();
  });
});

describe('committing', () => {
  it('writes only the site when the site changed', async () => {
    const user = userEvent.setup();
    const onChanged = draw();

    const input = screen.getByLabelText('Site');
    await user.clear(input);
    await user.type(input, 'other.atlassian.net');
    await user.tab();

    // Saving one field must not restate the other.
    expect(setJiraConnection).toHaveBeenCalledWith({
      site: 'other.atlassian.net',
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('writes only the email when the email changed', async () => {
    const user = userEvent.setup();
    draw();

    const input = screen.getByLabelText('Account email');
    await user.clear(input);
    await user.type(input, 'other@example.com');
    await user.tab();

    expect(setJiraConnection).toHaveBeenCalledWith({
      email: 'other@example.com',
    });
  });

  it('sends null when a field is emptied, never an empty string', async () => {
    const user = userEvent.setup();
    draw();

    await user.clear(screen.getByLabelText('Site'));
    await user.tab();

    // `""` would be a site named "" and a request to https:///rest/api/3/myself.
    expect(setJiraConnection).toHaveBeenCalledWith({ site: null });
  });

  it('writes nothing when the value is unchanged', async () => {
    const user = userEvent.setup();
    draw();

    await user.click(screen.getByLabelText('Site'));
    await user.tab();

    expect(setJiraConnection).not.toHaveBeenCalled();
  });

  it('writes nothing when only whitespace was added', async () => {
    const user = userEvent.setup();
    draw();

    await user.type(screen.getByLabelText('Site'), '   ');
    await user.tab();

    expect(setJiraConnection).not.toHaveBeenCalled();
  });

  it('commits on Enter as well as on blur', async () => {
    const user = userEvent.setup();
    draw(status({ site: null, email: null }));

    await user.type(screen.getByLabelText('Site'), 'new.atlassian.net{Enter}');

    expect(setJiraConnection).toHaveBeenCalledWith({
      site: 'new.atlassian.net',
    });
  });

  it('does not clear an already-empty field on blur', async () => {
    const user = userEvent.setup();
    draw(status({ site: null, email: null }));

    await user.click(screen.getByLabelText('Site'));
    await user.tab();

    expect(setJiraConnection).not.toHaveBeenCalled();
  });
});

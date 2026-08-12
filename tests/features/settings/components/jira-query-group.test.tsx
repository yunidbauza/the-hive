import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { JiraQueryGroup } from '@features/settings/components/jira-query-group';

/**
 * The JQL override and its "Test query" button (HIVE-69).
 *
 * The property worth pinning is that the button tests the **draft**, not the
 * saved value — the whole point is checking a query before committing to it —
 * and that a parse error is Jira's own words rather than anything composed here.
 */

const setJiraConnection = vi.fn((_request: unknown) => Promise.resolve());
const searchJiraIssues = vi.fn();

vi.mock('@/lib/project-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/project-config')>();
  return {
    ...actual,
    setJiraConnection: (request: unknown) => setJiraConnection(request),
  };
});

vi.mock('@/lib/jira', () => ({
  searchJiraIssues: (request?: unknown) => searchJiraIssues(request),
  readJiraStatus: () => Promise.resolve(null),
  saveJiraToken: () => Promise.resolve(null),
  clearJiraToken: () => Promise.resolve(null),
  testJiraConnection: () => Promise.resolve(null),
  readJiraIssue: () => Promise.resolve(null),
}));

const draw = (jql: string | null = null, canTest = true) =>
  render(<JiraQueryGroup jql={jql} canTest={canTest} />);

beforeEach(() => {
  vi.clearAllMocks();
  searchJiraIssues.mockResolvedValue({
    ok: true,
    value: { issues: [], capped: false },
  });
});

describe('the field', () => {
  it('shows the default query as its placeholder', () => {
    draw();

    expect(
      screen.getByPlaceholderText(
        'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
      ),
    ).toBeInTheDocument();
  });

  it('shows a saved override', () => {
    draw('project = HIVE');
    expect(screen.getByLabelText('JQL override')).toHaveValue('project = HIVE');
  });

  it('says the override replaces the default rather than adding to it', () => {
    draw();
    expect(screen.getByText(/replaces it entirely/i)).toBeInTheDocument();
  });

  it('commits on blur', async () => {
    const user = userEvent.setup();
    draw();

    await user.type(screen.getByLabelText('JQL override'), 'project = HIVE');
    await user.tab();

    expect(setJiraConnection).toHaveBeenCalledWith({ jql: 'project = HIVE' });
  });

  it('sends null when emptied, restoring the default', async () => {
    const user = userEvent.setup();
    draw('project = HIVE');

    await user.clear(screen.getByLabelText('JQL override'));
    await user.tab();

    // `""` would be an override matching nothing — the opposite of what
    // clearing the field means.
    expect(setJiraConnection).toHaveBeenCalledWith({ jql: null });
  });

  it('writes nothing when unchanged', async () => {
    const user = userEvent.setup();
    draw('project = HIVE');

    await user.click(screen.getByLabelText('JQL override'));
    await user.tab();

    expect(setJiraConnection).not.toHaveBeenCalled();
  });
});

describe('Test query', () => {
  it('tests the draft, not the saved value', async () => {
    const user = userEvent.setup();
    draw('project = OLD');

    const field = screen.getByLabelText('JQL override');
    await user.clear(field);
    await user.type(field, 'project = NEW');
    await user.click(screen.getByRole('button', { name: 'Test query' }));

    expect(searchJiraIssues).toHaveBeenCalledWith({ jql: 'project = NEW' });
  });

  it('tests the default when the field is blank', async () => {
    const user = userEvent.setup();
    draw();

    await user.click(screen.getByRole('button', { name: 'Test query' }));

    expect(searchJiraIssues).toHaveBeenCalledWith({});
  });

  it('reports the match count', async () => {
    const user = userEvent.setup();
    searchJiraIssues.mockResolvedValue({
      ok: true,
      value: { issues: [{}, {}, {}], capped: false },
    });
    draw();

    await user.click(screen.getByRole('button', { name: 'Test query' }));

    expect(await screen.findByText(/Matched 3 issues\./)).toBeInTheDocument();
  });

  it('says a query ran and matched nothing, which is not an error', async () => {
    const user = userEvent.setup();
    draw();

    await user.click(screen.getByRole('button', { name: 'Test query' }));

    expect(
      await screen.findByText(/matched no issues/i),
    ).toBeInTheDocument();
  });

  it('mentions the cap when the query matched more', async () => {
    const user = userEvent.setup();
    searchJiraIssues.mockResolvedValue({
      ok: true,
      value: { issues: new Array(200).fill({}), capped: true },
    });
    draw();

    await user.click(screen.getByRole('button', { name: 'Test query' }));

    expect(await screen.findByText(/there were more/i)).toBeInTheDocument();
  });

  it("surfaces Jira's own parse error verbatim", async () => {
    const user = userEvent.setup();
    searchJiraIssues.mockResolvedValue({
      ok: false,
      error: {
        kind: 'bad-query',
        message: "Error in the JQL Query: expecting 'AND' but got 'projct'.",
      },
    });
    draw();

    await user.click(screen.getByRole('button', { name: 'Test query' }));

    // Jira knows why better than any parser here would.
    expect(
      await screen.findByText(
        "Error in the JQL Query: expecting 'AND' but got 'projct'.",
      ),
    ).toBeInTheDocument();
  });

  it('distinguishes a broken channel from a Jira refusal', async () => {
    const user = userEvent.setup();
    searchJiraIssues.mockResolvedValue(null);
    draw();

    await user.click(screen.getByRole('button', { name: 'Test query' }));

    expect(
      await screen.findByText(/could not reach its own main process/i),
    ).toBeInTheDocument();
  });

  it('is offered but disabled before the connection is complete', () => {
    draw(null, false);

    expect(screen.getByRole('button', { name: 'Test query' })).toBeDisabled();
    expect(
      screen.getByText(/Configure the site, email and token first/i),
    ).toBeInTheDocument();
  });
});

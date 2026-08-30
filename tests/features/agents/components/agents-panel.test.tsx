import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { AgentsPanel } from '@features/agents/components/agents-panel';
import type { AgentSummary } from '@shared/agent-contract';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

/** The three fixture agents, in `agentOrder`, with their subtitles. */
const FIXTURE_AGENTS = [
  ['slack-agent', '#eng-alerts · #deploys · #ask-eng'],
  ['pr-reviewer', 'Auto-reviews open PRs'],
  ['standup-agent', 'Daily summary at 9:05'],
] as const;

const agentRow = (id: string) =>
  screen.getByRole('button', { name: new RegExp(`^${id}`) });

/**
 * Every row, and never the `+ New agent…` footer (HIVE-116).
 *
 * The footer is a button in the same panel, so a bare `getAllByRole('button')`
 * counts it as a tenant. Filtering by name here keeps these assertions exact
 * rather than loosening them to "one more than the rows".
 */
const agentRows = () =>
  screen
    .getAllByRole('button')
    .filter((button) => !button.textContent?.startsWith('+ New agent'));

describe('AgentsPanel', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
  });

  /**
   * The state a fresh launch is actually in.
   *
   * Three agents used to be seeded into the store at boot — a Slack watcher, a
   * PR reviewer, a standup writer — none of which anything could start or stop.
   * Nothing creates a background agent yet, so the panel says that instead of
   * listing three that do not exist.
   */
  it('points at the pane that creates one when empty', () => {
    useHiveStore.getState().reset();

    render(<AgentsPanel />);

    expect(
      screen.getByText(/No agents yet — create one in Settings › Agents/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders every seeded agent, in agentOrder', () => {
    render(<AgentsPanel />);

    const ids = agentRows().map(
      (row) => row.textContent?.match(/^[a-z-]+/)?.[0],
    );

    expect(ids).toEqual(FIXTURE_AGENTS.map(([id]) => id));
  });

  it.each(FIXTURE_AGENTS)('shows %s with its subtitle', (id, sub) => {
    render(<AgentsPanel />);

    expect(agentRow(id)).toBeInTheDocument();
    expect(screen.getByText(sub)).toBeInTheDocument();
  });

  it('gives each agent its own icon', () => {
    render(<AgentsPanel />);

    const glyphs = agentRows().map((row) => row.querySelector('svg')?.innerHTML);

    expect(new Set(glyphs).size).toBe(3);
    expect(glyphs.every(Boolean)).toBe(true);
  });

  it('opens an agent’s terminal when clicked', async () => {
    render(<AgentsPanel />);

    await userEvent.click(agentRow('pr-reviewer'));

    expect(useUiStore.getState().activeTab).toBe('pr-reviewer');
  });

  it('highlights the agent whose tab is open', () => {
    useUiStore.getState().openTab('standup-agent');
    render(<AgentsPanel />);

    expect(agentRow('standup-agent')).toHaveClass('bg-active');
    expect(agentRow('standup-agent')).toHaveAttribute('aria-current', 'true');
    expect(agentRow('slack-agent')).not.toHaveClass('bg-active');
  });

  it('moves the highlight when another tab opens', async () => {
    render(<AgentsPanel />);

    await userEvent.click(agentRow('slack-agent'));
    expect(agentRow('slack-agent')).toHaveClass('bg-active');

    await userEvent.click(agentRow('pr-reviewer'));
    expect(agentRow('pr-reviewer')).toHaveClass('bg-active');
    expect(agentRow('slack-agent')).not.toHaveClass('bg-active');
  });

  it('highlights nothing while a session tab is open', () => {
    useUiStore.getState().openTab('hero-refresh');
    render(<AgentsPanel />);

    for (const [id] of FIXTURE_AGENTS) {
      expect(agentRow(id)).not.toHaveClass('bg-active');
    }
  });

  /** State is never carried by the dot's colour alone (HIVE-114). */
  it('names each state in words as well as colour', () => {
    render(<AgentsPanel />);

    expect(screen.getAllByText('sleeping')).toHaveLength(3);
  });

  /**
   * A definition that failed to parse is *listed*, not hidden (HIVE-114).
   *
   * The row shows the reason where a working agent shows its description,
   * because a broken file has no description to show and the reason is the one
   * thing that helps the user fix it.
   */
  it('shows a broken definition with its reason', () => {
    act(() => {
      useHiveStore.getState().hydrateAgents([
        {
          name: 'broken',
          description: '',
          icon: 'Warning',
          status: 'sleeping',
          wake: { on: [] },
          rotateAfter: 50,
          runs: [],
          invalid: 'nope: Unknown key. Remove it or fix the spelling.',
        },
      ]);
    });

    render(<AgentsPanel />);

    expect(screen.getByText(/Unknown key/)).toBeInTheDocument();
    expect(screen.getByText('invalid')).toBeInTheDocument();
  });

  it('still lets a broken definition be opened, so it can be fixed', () => {
    act(() => {
      useHiveStore.getState().hydrateAgents([
        {
          name: 'broken',
          description: '',
          icon: 'Warning',
          status: 'sleeping',
          wake: { on: [] },
          rotateAfter: 50,
          runs: [],
          invalid: 'nope: Unknown key.',
        },
      ]);
    });

    render(<AgentsPanel />);

    expect(agentRow('broken')).toBeEnabled();
  });

  it('skips an id that is not an agent', () => {
    act(() => {
      useHiveStore.setState({ agentOrder: ['hero-refresh', 'slack-agent'] });
    });

    render(<AgentsPanel />);

    expect(agentRows()).toHaveLength(1);
    expect(agentRow('slack-agent')).toBeInTheDocument();
  });

  it('skips an id the store does not know', () => {
    act(() => {
      useHiveStore.setState({ agentOrder: ['ghost', 'slack-agent'] });
    });

    render(<AgentsPanel />);

    expect(agentRows()).toHaveLength(1);
  });

  /**
   * Grouping by state (HIVE-116).
   *
   * A rail is read to answer "what needs me", not "what do I have", which is
   * what the groups put first. The ordering rules themselves are
   * `useAgentsByGroup`'s and are tested there; these are about the panel
   * drawing what it is handed.
   */
  describe('grouped by state', () => {
    const summary = (name: string, status: AgentSummary['status']) => ({
      name,
      description: `${name} watches things`,
      icon: 'ph-robot',
      status,
      wake: { on: [] },
      rotateAfter: 50,
      runs: [],
    });

    it('draws a header and a count for every non-empty group', () => {
      act(() => {
        useHiveStore
          .getState()
          .hydrateAgents([
            summary('asker', 'asking'),
            summary('busy', 'working'),
            summary('held', 'paused'),
          ]);
      });

      render(<AgentsPanel />);

      expect(screen.getByText('Awake')).toBeInTheDocument();
      expect(screen.getByText('Paused')).toBeInTheDocument();
      // Two awake, one paused — the counts sit beside their headers.
      expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('omits a group with nothing in it, rather than a header reading zero', () => {
      act(() => {
        useHiveStore.getState().hydrateAgents([summary('sleeper', 'sleeping')]);
      });

      render(<AgentsPanel />);

      expect(screen.getByText('Sleeping')).toBeInTheDocument();
      expect(screen.queryByText('Awake')).not.toBeInTheDocument();
      expect(screen.queryByText('Paused')).not.toBeInTheDocument();
    });
  });

  describe('the way to make another one', () => {
    it('opens Settings › Agents, because that is where authoring lives', async () => {
      render(<AgentsPanel />);

      await userEvent.click(
        screen.getByRole('button', { name: /New agent/i }),
      );

      expect(useUiStore.getState().settings).toBe(true);
      expect(useUiStore.getState().settingsSection).toBe('agents');
    });

    it('is absent while the empty state is up, which names the pane itself', () => {
      useHiveStore.getState().reset();

      render(<AgentsPanel />);

      expect(
        screen.queryByRole('button', { name: /New agent/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(/create one in Settings › Agents/i),
      ).toBeInTheDocument();
    });
  });
});

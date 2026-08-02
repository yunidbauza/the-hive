import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { AgentsPanel } from '@features/agents/components/agents-panel';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

/** The three fixture agents, in `agentOrder`, with their subtitles. */
const FIXTURE_AGENTS = [
  ['slack-agent', '#eng-alerts · #deploys · #ask-eng'],
  ['pr-reviewer', 'Auto-reviews open PRs'],
  ['standup-agent', 'Daily summary at 9:05'],
] as const;

const agentRow = (id: string) =>
  screen.getByRole('button', { name: new RegExp(`^${id}`) });

describe('AgentsPanel', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
  });

  it('renders every fixture agent, in agentOrder', () => {
    render(<AgentsPanel />);

    const ids = screen
      .getAllByRole('button')
      .map((row) => row.textContent?.match(/^[a-z-]+/)?.[0]);

    expect(ids).toEqual(FIXTURE_AGENTS.map(([id]) => id));
  });

  it.each(FIXTURE_AGENTS)('shows %s with its subtitle', (id, sub) => {
    render(<AgentsPanel />);

    expect(agentRow(id)).toBeInTheDocument();
    expect(screen.getByText(sub)).toBeInTheDocument();
  });

  it('gives each agent its own icon', () => {
    render(<AgentsPanel />);

    const glyphs = screen
      .getAllByRole('button')
      .map((row) => row.querySelector('svg')?.innerHTML);

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

  /** Agents are always online in this phase, but never by colour alone. */
  it('marks every agent online in words as well as colour', () => {
    render(<AgentsPanel />);

    expect(screen.getAllByText('online')).toHaveLength(3);
  });

  it('skips an id that is not an agent', () => {
    act(() => {
      useHiveStore.setState({ agentOrder: ['hero-refresh', 'slack-agent'] });
    });

    render(<AgentsPanel />);

    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(agentRow('slack-agent')).toBeInTheDocument();
  });

  it('skips an id the store does not know', () => {
    act(() => {
      useHiveStore.setState({ agentOrder: ['ghost', 'slack-agent'] });
    });

    render(<AgentsPanel />);

    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});

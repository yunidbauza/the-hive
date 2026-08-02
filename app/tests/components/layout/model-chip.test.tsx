import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ModelChip } from '@components/layout/model-chip';
import { contextMeter, contextPct } from '@/lib/session-metrics';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

/**
 * The chip is conditional on *what kind of thing* the active tab is — the
 * acceptance criterion story 021 cares most about. Each case gets its own
 * assertion rather than one parameterised loop, so a regression names itself.
 */
describe('ModelChip', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
  });

  it('is absent for the orchestrator', () => {
    useUiStore.setState({ activeTab: 'orch' });

    const { container } = render(<ModelChip />);

    expect(container).toBeEmptyDOMElement();
  });

  it('is absent for an agent — agents are not a metered conversation', () => {
    useUiStore.setState({ activeTab: 'slack-agent' });

    const { container } = render(<ModelChip />);

    expect(container).toBeEmptyDOMElement();
  });

  it('is absent for an unknown tab id', () => {
    useUiStore.setState({ activeTab: 'no-such-entity' });

    const { container } = render(<ModelChip />);

    expect(container).toBeEmptyDOMElement();
  });

  it('is present for a session', () => {
    useUiStore.setState({ activeTab: 'hero-refresh' });

    render(<ModelChip />);

    expect(screen.getByText(/Opus 4.5 \(1M\) · high/)).toBeInTheDocument();
  });

  it('shows the context meter and both percentages', () => {
    useUiStore.setState({ activeTab: 'hero-refresh' });

    render(<ModelChip />);

    const pct = contextPct('hero-refresh', 'feat/hero-refresh');
    expect(
      screen.getByText(new RegExp(`${contextMeter(pct)} ${pct}%`)),
    ).toBeInTheDocument();
    expect(screen.getByText(/resets 02:30 PM/)).toBeInTheDocument();
  });

  it('falls back to Opus at high effort when the session names neither', () => {
    useUiStore.setState({ activeTab: 'webhooks' });

    render(<ModelChip />);

    // Fixture sessions carry no model/effort; the concept defaults the same way.
    expect(screen.getByText(/Opus 4.5 \(1M\) · high/)).toBeInTheDocument();
  });

  it('reads the model and effort a spawned session was given', () => {
    const id = useHiveStore
      .getState()
      .spawnSession('apfm-web', 'ship it', 'haiku', 'low');
    useUiStore.setState({ activeTab: id });

    render(<ModelChip />);

    expect(screen.getByText(/Haiku 4.5 \(1M\) · low/)).toBeInTheDocument();
  });

  it('swaps when the active tab moves from one session to another', () => {
    useUiStore.setState({ activeTab: 'hero-refresh' });
    const { rerender } = render(<ModelChip />);

    const first = contextPct('hero-refresh', 'feat/hero-refresh');
    expect(screen.getByText(new RegExp(`${first}%`))).toBeInTheDocument();

    useUiStore.setState({ activeTab: 'webhooks' });
    rerender(<ModelChip />);

    const second = contextPct('webhooks', 'feat/partner-webhooks');
    expect(screen.getByText(new RegExp(`${second}%`))).toBeInTheDocument();
  });
});

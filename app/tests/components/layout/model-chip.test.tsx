import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ModelChip } from '@components/layout/model-chip';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

/**
 * The chip is conditional on *what kind of thing* the active tab is — the
 * acceptance criterion story 021 cares most about. Each case gets its own
 * assertion rather than one parameterised loop, so a regression names itself.
 *
 * HIVE-79 changed what it renders. The numbers are no longer derived from the
 * session id, so the interesting cases are now the two ends: a session that has
 * reported, and one that has not.
 */
describe('ModelChip', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
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

    expect(screen.getByText(/Opus 4.5 · high/)).toBeInTheDocument();
  });

  describe('before the session has reported anything', () => {
    /**
     * The whole point of the rewrite. A session that has not reported — the
     * first seconds of every session, and the entire life of one authenticated
     * with an API key — must show that it does not know, not a zero.
     */
    it('shows an em dash for all three stats and never a zero', () => {
      useUiStore.setState({ activeTab: 'hero-refresh' });

      render(<ModelChip />);

      expect(screen.getAllByText('—')).toHaveLength(3);
      expect(screen.queryByText('0%')).not.toBeInTheDocument();
    });

    it('marks every gauge unknown for assistive tech', () => {
      useUiStore.setState({ activeTab: 'hero-refresh' });

      render(<ModelChip />);

      expect(screen.getByLabelText('context: unknown')).toBeInTheDocument();
      expect(screen.getByLabelText('session limit: unknown')).toBeInTheDocument();
      expect(screen.getByLabelText('weekly limit: unknown')).toBeInTheDocument();
    });
  });

  describe('once it has', () => {
    /** 2026-08-11 14:30 and 2026-08-13 17:00 local, in epoch seconds. */
    const fiveHourResetsAt = new Date(2026, 7, 11, 14, 30).getTime() / 1000;
    const sevenDayResetsAt = new Date(2026, 7, 13, 17, 0).getTime() / 1000;

    beforeEach(() => {
      useUiStore.setState({ activeTab: 'hero-refresh' });
      useHiveStore.getState().setSessionMetrics('hero-refresh', {
        model: 'Opus 4.5',
        effort: 'high',
        contextPct: 46,
        contextWindow: 1_000_000,
        fiveHourPct: 12,
        fiveHourResetsAt,
        // Distinct from the context percentage on purpose: three stats that
        // share a number make an ambiguous assertion, not a stronger one.
        sevenDayPct: 63,
        sevenDayResetsAt,
      });
    });

    it('renders all three percentages', () => {
      render(<ModelChip />);

      expect(screen.getByText('46%')).toBeInTheDocument();
      expect(screen.getByText('12%')).toBeInTheDocument();
      expect(screen.getByText('63%')).toBeInTheDocument();
      expect(screen.getByText('ctx')).toBeInTheDocument();
    });

    /**
     * Both windows, each with its own reset — the gap this closed. The old chip
     * showed one unlabelled percentage and a reset time with **no day**, so
     * neither of those facts was recoverable from what was on screen.
     */
    it('renders a reset for each window, with the weekday on the weekly one', () => {
      render(<ModelChip />);

      expect(screen.getByText('↻ 2:30p')).toBeInTheDocument();
      expect(screen.getByText('↻ Thu 5p')).toBeInTheDocument();
    });

    it('names the extended context window the session reported', () => {
      render(<ModelChip />);

      expect(screen.getByText(/Opus 4.5 \(1M\) · high/)).toBeInTheDocument();
    });

    it('spells everything out in the tooltip, so truncation loses no meaning', () => {
      render(<ModelChip />);

      const title = screen.getByTitle(/weekly limit/);
      expect(title.getAttribute('title')).toContain('context 46%');
      expect(title.getAttribute('title')).toContain(
        'session limit 12%, resets 2:30p',
      );
      expect(title.getAttribute('title')).toContain(
        'weekly limit 63%, resets Thu 5p',
      );
    });
  });

  it('falls back to Opus at high effort when the session names neither', () => {
    useUiStore.setState({ activeTab: 'webhooks' });

    render(<ModelChip />);

    // Fixture sessions carry no model/effort; the concept defaults the same way.
    expect(screen.getByText(/Opus 4.5 · high/)).toBeInTheDocument();
  });

  it('reads the model and effort a spawned session was given', () => {
    const id = useHiveStore
      .getState()
      .spawnSession('apfm-web', 'ship it', 'haiku', 'low');
    useUiStore.setState({ activeTab: id });

    render(<ModelChip />);

    expect(screen.getByText(/Haiku 4.5 · low/)).toBeInTheDocument();
  });

  it('swaps when the active tab moves from one session to another', () => {
    useHiveStore.getState().setSessionMetrics('hero-refresh', { contextPct: 46 });
    useHiveStore.getState().setSessionMetrics('webhooks', { contextPct: 12 });

    useUiStore.setState({ activeTab: 'hero-refresh' });
    const { rerender } = render(<ModelChip />);
    expect(screen.getByText('46%')).toBeInTheDocument();

    useUiStore.setState({ activeTab: 'webhooks' });
    rerender(<ModelChip />);
    expect(screen.getByText('12%')).toBeInTheDocument();
    expect(screen.queryByText('46%')).not.toBeInTheDocument();
  });
});

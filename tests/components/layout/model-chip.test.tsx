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
     * The whole point of this pass. A session that has not reported
     * — the first seconds of every session, and the entire life of one
     * authenticated with an API key — shows the model it is running and nothing
     * else. It used to show three em dashes beside three empty rings, which is
     * a promise of numbers rather than an absence of them.
     */
    it('renders the model alone — no stat, no placeholder, no zero', () => {
      useUiStore.setState({ activeTab: 'hero-refresh' });

      render(<ModelChip />);

      expect(screen.getByText(/Opus 4.5 · high/)).toBeInTheDocument();
      expect(screen.queryByText('—')).not.toBeInTheDocument();
      expect(screen.queryByText('0%')).not.toBeInTheDocument();
      expect(screen.queryByText('ctx')).not.toBeInTheDocument();
    });

    it('draws no gauge for a number nobody reported', () => {
      useUiStore.setState({ activeTab: 'hero-refresh' });

      const { container } = render(<ModelChip />);

      expect(container.querySelector('svg[role="img"]')).toBeNull();
    });

    /** Nothing to spell out, so the tooltip is the label and only the label. */
    it('keeps the tooltip free of stats it does not have', () => {
      useUiStore.setState({ activeTab: 'hero-refresh' });

      render(<ModelChip />);

      expect(screen.getByTitle('Opus 4.5 · high')).toBeInTheDocument();
    });
  });

  /**
   * The state a real session sits in for as long as the user takes to send a
   * first prompt, and the one that prompted this change.
   *
   * Claude Code reports `rate_limits` within seconds of launch — they follow the
   * session's first API response — while `context_window.used_percentage` stays
   * null until the first **assistant turn**, because it is computed from the
   * last message carrying a `usage` block. Verified against 2.1.228: an idle
   * session reports both limits every thirty seconds and no context percentage
   * at all. So the two windows must be able to appear without the context stat
   * waiting on them, or dragging an em dash along beside them.
   */
  describe('when the limits have arrived but the context has not', () => {
    beforeEach(() => {
      useUiStore.setState({ activeTab: 'hero-refresh' });
      useHiveStore.getState().setSessionMetrics('hero-refresh', {
        model: 'Opus 4.5',
        effort: 'high',
        fiveHourPct: 3,
        sevenDayPct: 46,
      });
    });

    it('renders the two limits and omits the context stat entirely', () => {
      render(<ModelChip />);

      expect(screen.getByText('3%')).toBeInTheDocument();
      expect(screen.getByText('46%')).toBeInTheDocument();
      expect(screen.queryByText('ctx')).not.toBeInTheDocument();
      expect(screen.queryByText('—')).not.toBeInTheDocument();
    });

    /**
     * A percentage with no reset keeps the window's *name* as its detail. The
     * two travel together in every payload observed, but the contract makes them
     * independently optional and a lone number has to say which window it counts.
     */
    it('names each window when the payload carried no reset time', () => {
      render(<ModelChip />);

      expect(screen.getByText('session')).toBeInTheDocument();
      expect(screen.getByText('week')).toBeInTheDocument();
    });

    it('leaves the context out of the tooltip too', () => {
      render(<ModelChip />);

      const title = screen.getByTitle(/weekly limit/).getAttribute('title');
      expect(title).toContain('session limit 3%');
      expect(title).not.toContain('context');
    });
  });

  /**
   * The other direction, and the one a merge could get wrong.
   *
   * After `/compact` the session reports a context window with a null
   * percentage. The stat must go away rather than keep showing the pre-compact
   * number, which describes a conversation that no longer exists — see the null
   * handling in `metrics-contract.ts` and the store's merge.
   */
  it('drops the context stat when a later report nulls it', () => {
    useUiStore.setState({ activeTab: 'hero-refresh' });
    useHiveStore.getState().setSessionMetrics('hero-refresh', {
      contextPct: 92,
    });

    const { rerender } = render(<ModelChip />);
    expect(screen.getByText('92%')).toBeInTheDocument();

    useHiveStore.getState().setSessionMetrics('hero-refresh', {
      contextPct: null,
    });
    rerender(<ModelChip />);

    expect(screen.queryByText('92%')).not.toBeInTheDocument();
    expect(screen.queryByText('ctx')).not.toBeInTheDocument();
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
      .spawnSession('nova-web', 'ship it', 'haiku', 'low');
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

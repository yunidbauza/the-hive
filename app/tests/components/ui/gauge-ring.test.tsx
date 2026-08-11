import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  GaugeRing,
  gaugeTone,
  GAUGE_CRITICAL_PCT,
  GAUGE_WARN_PCT,
} from '@components/ui/gauge-ring';

describe('gaugeTone', () => {
  it('is calm below the warning threshold', () => {
    expect(gaugeTone(0)).toBe('brand');
    expect(gaugeTone(GAUGE_WARN_PCT - 1)).toBe('brand');
  });

  it('turns at the thresholds themselves, not past them', () => {
    expect(gaugeTone(GAUGE_WARN_PCT)).toBe('amber');
    expect(gaugeTone(GAUGE_CRITICAL_PCT)).toBe('red');
  });

  it('stays urgent all the way to full', () => {
    expect(gaugeTone(100)).toBe('red');
  });
});

describe('GaugeRing', () => {
  /**
   * happy-dom performs no layout, so the arc's *appearance* is not assertable
   * here. What is: that the geometry is computed at all, that it moves with the
   * value, and — most importantly — that an unknown value draws no arc.
   */
  it('draws a track and an arc when the value is known', () => {
    const { container } = render(<GaugeRing pct={46} label="context" />);

    expect(container.querySelectorAll('circle')).toHaveLength(2);
  });

  /**
   * The assertion this component exists for. An empty ring must be empty, not a
   * ring at zero — the difference between "not reported" and "none used".
   */
  it('draws only the track when the value is unknown', () => {
    const { container } = render(<GaugeRing pct={null} label="weekly limit" />);

    expect(container.querySelectorAll('circle')).toHaveLength(1);
    expect(screen.getByLabelText('weekly limit: unknown')).toBeInTheDocument();
  });

  it('names the value for assistive tech', () => {
    render(<GaugeRing pct={46.4} label="context" />);

    // Rounded, so a screen reader is not given three decimal places.
    expect(screen.getByLabelText('context: 46%')).toBeInTheDocument();
  });

  it('shortens the arc as the value grows', () => {
    const { container: low } = render(<GaugeRing pct={10} label="a" />);
    const { container: high } = render(<GaugeRing pct={90} label="b" />);

    const offset = (root: HTMLElement) =>
      Number(root.querySelectorAll('circle')[1]?.getAttribute('stroke-dashoffset'));

    // More used ⇒ more of the circumference drawn ⇒ a smaller remaining offset.
    expect(offset(high)).toBeLessThan(offset(low));
  });

  it('clamps a value from outside rather than wrapping the arc past itself', () => {
    const { container } = render(<GaugeRing pct={140} label="context" />);

    const arc = container.querySelectorAll('circle')[1];
    expect(arc?.getAttribute('stroke-dashoffset')).toBe('0');
    expect(screen.getByLabelText('context: 100%')).toBeInTheDocument();
  });

  /**
   * Colour comes from `currentColor` on a token-backed utility class, never from
   * a hex in component code — the ban AGENTS.md places on the whole codebase.
   */
  it('takes its colour from a token class, not a literal', () => {
    const { container } = render(<GaugeRing pct={90} label="context" />);

    const arc = container.querySelectorAll('circle')[1];
    expect(arc).toHaveClass('text-red');
    expect(arc?.getAttribute('stroke')).toBe('currentColor');
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{6}/i);
  });
});

import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { StatusComb } from '@components/ui/status-comb';

const comb = (ui: ReactElement) => render(ui).container.querySelector('svg')!;

describe('StatusComb (HIVE-229)', () => {
  it.each([
    ['working', 'filled', 'text-green'],
    ['waiting', 'filled', 'text-amber-text'],
    ['asking', 'filled', 'text-amber-text'],
    ['failed', 'filled', 'text-red'],
    ['idle', 'hollow', 'text-subtle'],
    ['sleeping', 'hollow', 'text-subtle'],
  ] as const)('draws %s %s in %s', (status, shape, colour) => {
    const svg = comb(<StatusComb status={status} />);

    expect(svg).toHaveAttribute('data-shape', shape);
    expect(svg).toHaveClass(colour);
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('pulses only while working', () => {
    expect(comb(<StatusComb status="working" />)).toHaveClass('animate-ccpulse');
    expect(comb(<StatusComb status="asking" />)).not.toHaveClass('animate-ccpulse');
  });

  it('draws a quiet session with agents running as a hollow green comb', () => {
    const svg = comb(<StatusComb status="idle" detail="agents" />);

    expect(svg).toHaveAttribute('data-shape', 'hollow');
    expect(svg).toHaveClass('text-green');
    expect(svg).not.toHaveClass('animate-ccpulse');
  });
});

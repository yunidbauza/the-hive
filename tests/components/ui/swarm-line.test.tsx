import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SwarmLine } from '@components/ui/swarm-line';
import { PHRASES } from '@lib/swarm/phrases';

describe('SwarmLine', () => {
  it('renders a phrase from the pool it names', () => {
    render(<SwarmLine phraseKey="empty.pullRequests" />);

    const line = document.querySelector('[data-swarm-line]');

    expect(line).not.toBeNull();
    expect(PHRASES['empty.pullRequests']).toContain(line?.textContent);
  });

  /**
   * It leads, so it sits one step brighter than the `text-subtle` body — and it
   * is not coloured. Amber means "needs input" and red means "failed"; a
   * flavour line is neither, and a hue would promote a joke above the sentence
   * explaining what actually happened.
   */
  it('is muted, not coloured', () => {
    render(<SwarmLine phraseKey="empty.inbox" />);

    const line = document.querySelector('[data-swarm-line]');

    expect(line).toHaveClass('text-muted');
    expect(line?.className).not.toContain('text-amber');
    expect(line?.className).not.toContain('text-red');
  });
});

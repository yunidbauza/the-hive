import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SkeletonBar } from '@features/shared/components/skeleton-bar';

/**
 * One bar of a loading placeholder. The width is the caller's, because it is
 * what makes each skeleton mirror the card it stands in for.
 */
describe('SkeletonBar', () => {
  it('is a rounded chip-coloured bar carrying the width it is given', () => {
    const { container } = render(<SkeletonBar className="w-8" />);

    expect(container.firstChild).toHaveClass(
      'block',
      'h-2.5',
      'rounded-full',
      'bg-chip',
      'w-8',
    );
  });
});

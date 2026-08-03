import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { KeyHint } from '@components/ui/key-hint';

describe('KeyHint', () => {
  it('joins its hints with the app middot', () => {
    render(<KeyHint hints={['← back to list', '↵ send']} />);

    expect(screen.getByTestId('key-hint')).toHaveTextContent(
      '← back to list · ↵ send',
    );
  });

  it('renders nothing at all when there is nothing to hint', () => {
    // An empty separator-joined string would still paint padding and a
    // baseline, nudging the row it sits in.
    const { container } = render(<KeyHint hints={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('takes the platform chord as a string, not a platform', () => {
    // Deliberately dumb: which chord applies is a question about the surface,
    // and answering it here would drag capability checks into a presentational
    // atom.
    render(<KeyHint hints={['⌘← back to list', '↵ send']} />);

    expect(screen.getByTestId('key-hint')).toHaveTextContent('⌘← back to list');
  });
});

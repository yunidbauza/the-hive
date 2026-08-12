import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DemoChip } from '@components/layout/demo-chip';

function withBridge() {
  (window as { hive?: unknown }).hive = { appInfo: () => Promise.resolve({}) };
}

afterEach(() => {
  delete (window as { hive?: unknown }).hive;
});

describe('DemoChip', () => {
  it('marks the browser build, which has no real terminals', () => {
    render(<DemoChip />);

    expect(screen.getByText('demo')).toBeInTheDocument();
  });

  it('renders nothing on desktop, where the terminals are real', () => {
    withBridge();

    const { container } = render(<DemoChip />);

    expect(container).toBeEmptyDOMElement();
  });

  it('explains itself on hover rather than relying on one word', () => {
    render(<DemoChip />);

    expect(screen.getByText('demo')).toHaveAttribute(
      'title',
      expect.stringContaining('recorded transcripts'),
    );
  });

  it('uses the amber token — the app’s "needs attention" register', () => {
    render(<DemoChip />);

    expect(screen.getByText('demo')).toHaveClass('text-amber');
  });
});

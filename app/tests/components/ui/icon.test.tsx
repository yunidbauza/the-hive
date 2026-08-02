import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Icon } from '@components/ui/icon';

const svg = (container: HTMLElement) => container.querySelector('svg');

describe('Icon', () => {
  it('renders a glyph for a fixture icon name', () => {
    const { container } = render(<Icon name="ph-slack-logo" />);

    expect(svg(container)).toBeInTheDocument();
  });

  /**
   * A missing glyph should be visible in review, not a silent gap where an icon
   * was meant to be.
   */
  it('falls back to a question mark for an unknown name', () => {
    const { container } = render(<Icon name="ph-not-a-real-icon" />);

    expect(svg(container)).toBeInTheDocument();
  });

  it('renders a different glyph per name', () => {
    const { container: a } = render(<Icon name="ph-caret-down" />);
    const { container: b } = render(<Icon name="ph-caret-right" />);

    expect(svg(a)?.innerHTML).not.toBe(svg(b)?.innerHTML);
  });

  /**
   * Every icon in this app sits beside the text it illustrates, so it must not
   * announce a duplicate.
   */
  it('is always hidden from the accessibility tree', () => {
    const { container } = render(<Icon name="ph-cube" />);

    expect(svg(container)).toHaveAttribute('aria-hidden', 'true');
  });

  it('forwards size and className', () => {
    const { container } = render(
      <Icon name="ph-cube" size={15} className="text-subtle" />,
    );

    expect(svg(container)).toHaveAttribute('width', '15');
    expect(svg(container)).toHaveClass('text-subtle');
  });

  /**
   * Guards the map itself. Every icon the fixtures name must resolve to a real
   * glyph — a typo here would silently degrade to the fallback everywhere.
   */
  it.each([
    'ph-globe-hemisphere-west',
    'ph-cube',
    'ph-users-three',
    'ph-swatches',
    'ph-stack',
    'ph-slack-logo',
    'ph-git-pull-request',
    'ph-calendar-check',
    'ph-hand-palm',
    'ph-chat-circle-dots',
    'ph-check-circle',
    'ph-plus-circle',
    'ph-paper-plane-tilt',
    'ph-lightning',
  ])('maps the fixture icon %s to its own glyph', (name) => {
    const { container: named } = render(<Icon name={name} />);
    const { container: fallback } = render(<Icon name="ph-unmapped" />);

    expect(svg(named)?.innerHTML).not.toBe(svg(fallback)?.innerHTML);
  });
});

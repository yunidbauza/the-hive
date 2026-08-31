import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button } from '@components/ui/button';

describe('Button', () => {
  it('defaults to a medium secondary button of type button', () => {
    render(<Button>Cancel</Button>);
    const el = screen.getByRole('button', { name: 'Cancel' });
    expect(el).toHaveAttribute('type', 'button');
    expect(el.className).toContain('border-border');
  });

  it('draws the primary variant with the brand fill', () => {
    render(<Button variant="primary">Send</Button>);
    expect(screen.getByRole('button', { name: 'Send' }).className).toContain(
      'bg-brand-fill',
    );
  });

  it('draws the danger variant with the red token', () => {
    render(<Button variant="danger">Deny</Button>);
    expect(screen.getByRole('button', { name: 'Deny' }).className).toContain(
      'text-red',
    );
  });

  it('draws the ghost variant with no border', () => {
    render(<Button variant="ghost">Clear</Button>);
    expect(screen.getByRole('button', { name: 'Clear' }).className).toContain(
      'border-transparent',
    );
  });

  it('keeps the small size distinct from the medium one', () => {
    const { rerender } = render(<Button size="sm">a</Button>);
    const small = screen.getByRole('button').className;
    rerender(<Button size="md">a</Button>);
    expect(screen.getByRole('button').className).not.toBe(small);
  });

  it('forwards disabled and merges a caller class', () => {
    render(
      <Button disabled className="w-full">
        Send
      </Button>,
    );
    const el = screen.getByRole('button');
    expect(el).toBeDisabled();
    expect(el.className).toContain('w-full');
  });

  it('lets the caller override type for a submit button', () => {
    render(<Button type="submit">Go</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');
  });
});

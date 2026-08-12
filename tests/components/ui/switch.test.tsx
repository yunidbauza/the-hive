import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Switch } from '@components/ui/switch';

/**
 * The app's first boolean control (story 106).
 *
 * What is worth asserting is the part the Radix primitive gives us and a
 * hand-rolled `<div onClick>` would not: a real `switch` role, a state
 * assistive tech can read, and keyboard operability.
 */

describe('Switch', () => {
  it('exposes a switch role carrying its label and state', () => {
    render(<Switch label="Session finished" checked={false} onCheckedChange={vi.fn()} />);

    const control = screen.getByRole('switch', { name: 'Session finished' });
    expect(control).toHaveAttribute('aria-checked', 'false');
  });

  it('reports the checked state', () => {
    render(<Switch label="Session finished" checked onCheckedChange={vi.fn()} />);

    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('reports the new value on click, not the old one', () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch label="Session finished" checked={false} onCheckedChange={onCheckedChange} />,
    );

    screen.getByRole('switch').click();

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('toggles from the keyboard', async () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch label="Session finished" checked={false} onCheckedChange={onCheckedChange} />,
    );

    await userEvent.tab();
    await userEvent.keyboard(' ');

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('toggles when the label is clicked — the row is the target', async () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch label="Session finished" checked={false} onCheckedChange={onCheckedChange} />,
    );

    await userEvent.click(screen.getByText('Session finished'));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('associates a description with the control rather than orphaning it', () => {
    render(
      <Switch
        label="Session idle"
        description="Chatty — a build that pauses is not news."
        checked={false}
        onCheckedChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('switch')).toHaveAccessibleDescription(
      'Chatty — a build that pauses is not news.',
    );
  });

  it('does not fire when disabled', async () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch
        label="Session finished"
        checked={false}
        disabled
        onCheckedChange={onCheckedChange}
      />,
    );

    await userEvent.click(screen.getByRole('switch'));

    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});

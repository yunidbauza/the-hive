import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TextField } from '@components/ui/text-field';

describe('TextField', () => {
  it('associates its label with the input', () => {
    render(<TextField label="Shell" value="/bin/zsh" onChange={vi.fn()} />);

    expect(screen.getByRole('textbox', { name: 'Shell' })).toHaveValue('/bin/zsh');
  });

  it('keeps the hint out of the accessible name', () => {
    render(
      <TextField
        label="Shell"
        value=""
        onChange={vi.fn()}
        hint="Blank inherits the default."
      />,
    );

    // A wrapping <label> would announce this as "Shell Blank inherits the
    // default." The hint is a description, and aria-describedby says so.
    const input = screen.getByRole('textbox', { name: 'Shell' });
    expect(input).toHaveAccessibleDescription('Blank inherits the default.');
  });

  it('reports every keystroke but commits only on Enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <TextField label="Shell" value="" onChange={onChange} onCommit={onCommit} />,
    );

    await user.type(screen.getByRole('textbox', { name: 'Shell' }), 'ab');
    expect(onChange).toHaveBeenCalledTimes(2);
    // Runtime settings write a whole file atomically; committing per keystroke
    // would mean one write per character.
    expect(onCommit).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('commits on blur', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <>
        <TextField label="Shell" value="x" onChange={vi.fn()} onCommit={onCommit} />
        <button type="button">elsewhere</button>
      </>,
    );

    await user.click(screen.getByRole('textbox', { name: 'Shell' }));
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));

    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('shows a placeholder for an inherited value', () => {
    render(
      <TextField
        label="Shell override"
        value=""
        onChange={vi.fn()}
        placeholder="/bin/sh"
        muted
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Shell override' })).toHaveAttribute(
      'placeholder',
      '/bin/sh',
    );
  });
});

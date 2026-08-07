import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SecretField } from '@components/ui/secret-field';

/**
 * The write-only credential input (HIVE-67).
 *
 * Not a masked `TextField`: this field never displays a stored value, because
 * there is none to display. Its input is always a *new* value replacing the
 * old, and these tests are what stop a later refactor from folding the two
 * components together and quietly implying that a token round-trips.
 */

describe('SecretField', () => {
  it('masks the value by default', () => {
    render(<SecretField label="API token" value="s3cret" onChange={vi.fn()} />);

    expect(screen.getByLabelText('API token')).toHaveAttribute(
      'type',
      'password',
    );
  });

  it('reveals and re-hides on the toggle', async () => {
    const user = userEvent.setup();
    render(<SecretField label="API token" value="s3cret" onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Show the token' }));
    expect(screen.getByLabelText('API token')).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'Hide the token' }));
    expect(screen.getByLabelText('API token')).toHaveAttribute(
      'type',
      'password',
    );
  });

  it('reports every keystroke to onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SecretField label="API token" value="" onChange={onChange} />);

    await user.type(screen.getByLabelText('API token'), 'ab');

    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('commits on Enter and on blur', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <SecretField
        label="API token"
        value="x"
        onChange={vi.fn()}
        onCommit={onCommit}
      />,
    );

    const input = screen.getByLabelText('API token');
    await user.click(input);
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledTimes(1);

    await user.tab();
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it('keeps the hint out of the accessible name', () => {
    render(
      <SecretField
        label="API token"
        value=""
        onChange={vi.fn()}
        hint="Stored encrypted by the OS."
      />,
    );

    // A wrapping <label> would announce this as "API token Stored encrypted by
    // the OS." The hint is a description, and aria-describedby says so.
    expect(screen.getByLabelText('API token')).toHaveAccessibleDescription(
      'Stored encrypted by the OS.',
    );
  });

  it('renders a placeholder for what is already stored', () => {
    render(
      <SecretField
        label="API token"
        value=""
        onChange={vi.fn()}
        placeholder="Paste a new token to replace it"
      />,
    );

    expect(
      screen.getByPlaceholderText('Paste a new token to replace it'),
    ).toBeInTheDocument();
  });

  it('never autocompletes or spell-checks a credential', () => {
    render(<SecretField label="API token" value="" onChange={vi.fn()} />);

    const input = screen.getByLabelText('API token');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');
  });

  it('does not submit a surrounding form when Enter commits', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <SecretField
          label="API token"
          value="x"
          onChange={vi.fn()}
          onCommit={vi.fn()}
        />
      </form>,
    );

    await user.click(screen.getByLabelText('API token'));
    await user.keyboard('{Enter}');

    expect(onSubmit).not.toHaveBeenCalled();
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EnvEditor } from '@features/settings/components/env-editor';

/**
 * The env-var editor (story 104).
 *
 * The rules it enforces are the same three `guards.ts` enforces, on purpose —
 * this is not the enforcement, it is the explanation, delivered before a round
 * trip that would otherwise fail with a thrown channel error the user cannot
 * read.
 */
describe('EnvEditor', () => {
  it('renders the existing variables', () => {
    render(<EnvEditor value={{ API_URL: 'https://x.test' }} onSave={vi.fn()} />);

    expect(screen.getByRole('textbox', { name: 'Variable 1 name' })).toHaveValue(
      'API_URL',
    );
    expect(screen.getByRole('textbox', { name: 'Variable 1 value' })).toHaveValue(
      'https://x.test',
    );
  });

  it('says what an empty map means rather than showing nothing', () => {
    render(<EnvEditor value={{}} onSave={vi.fn()} />);

    expect(
      screen.getByText(/Sessions in this project inherit your environment/),
    ).toBeInTheDocument();
  });

  it('adds and saves a variable', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<EnvEditor value={{}} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'Add variable' }));
    await user.type(screen.getByRole('textbox', { name: 'Variable 1 name' }), 'FOO');
    await user.type(screen.getByRole('textbox', { name: 'Variable 1 value' }), 'bar');
    await user.click(screen.getByRole('button', { name: 'Save variables' }));

    expect(onSave).toHaveBeenCalledWith({ FOO: 'bar' });
  });

  it('removes the right row when an earlier one is deleted', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<EnvEditor value={{ A: '1', B: '2', C: '3' }} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'Remove variable 1' }));
    await user.click(screen.getByRole('button', { name: 'Save variables' }));

    // The rows are keyed by a stable row id, not by index: an index key would
    // shift every later row and hand the wrong draft to the wrong input.
    expect(onSave).toHaveBeenCalledWith({ B: '2', C: '3' });
  });

  it('blocks the save and explains an invalid variable name', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<EnvEditor value={{}} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'Add variable' }));
    await user.type(screen.getByRole('textbox', { name: 'Variable 1 name' }), '1BAD');

    expect(screen.getByText(/not a valid variable name/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save variables' })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('blocks a variable the terminal sets for itself', async () => {
    const user = userEvent.setup();
    render(<EnvEditor value={{}} onSave={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Add variable' }));
    await user.type(screen.getByRole('textbox', { name: 'Variable 1 name' }), 'TERM');

    // Main refuses it, so say so before the round trip.
    expect(screen.getByText(/set by the terminal/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save variables' })).toBeDisabled();
  });

  it('blocks a duplicate name', async () => {
    const user = userEvent.setup();
    render(<EnvEditor value={{ FOO: '1' }} onSave={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Add variable' }));
    await user.type(screen.getByRole('textbox', { name: 'Variable 2 name' }), 'FOO');

    expect(screen.getByText(/listed twice/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save variables' })).toBeDisabled();
  });

  it('drops a blank row instead of blocking the save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<EnvEditor value={{ FOO: 'bar' }} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'Add variable' }));
    await user.click(screen.getByRole('button', { name: 'Save variables' }));

    // A blank row is a half-finished thought, not an error worth blocking on.
    expect(onSave).toHaveBeenCalledWith({ FOO: 'bar' });
  });
});

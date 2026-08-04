import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SelectField } from '@components/ui/select-field';

const OPTIONS = [
  { value: 'menlo', label: 'Menlo' },
  { value: 'monaco', label: 'Monaco' },
] as const;

describe('SelectField', () => {
  it('associates its label with the control', () => {
    render(
      <SelectField label="Font" value="menlo" options={OPTIONS} onChange={vi.fn()} />,
    );

    expect(screen.getByRole('combobox', { name: 'Font' })).toBeInTheDocument();
  });

  it('keeps the hint out of the accessible name and in the description', () => {
    render(
      <SelectField
        label="Font"
        value="menlo"
        options={OPTIONS}
        onChange={vi.fn()}
        hint="Falls back."
      />,
    );

    // A wrapping <label> would fold the hint into the name — "Font Falls back."
    // The hint is a description, and `aria-describedby` is what says so.
    const select = screen.getByRole('combobox', { name: 'Font' });
    expect(select).toHaveAccessibleDescription('Falls back.');
  });

  it('renders every option and reflects the current value', () => {
    render(
      <SelectField label="Font" value="monaco" options={OPTIONS} onChange={vi.fn()} />,
    );

    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByRole('combobox', { name: 'Font' })).toHaveValue('monaco');
  });

  it('reports the chosen value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SelectField label="Font" value="menlo" options={OPTIONS} onChange={onChange} />,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: 'Font' }), 'monaco');

    expect(onChange).toHaveBeenCalledWith('monaco');
  });

  it('renders a hint only when given one', () => {
    const { rerender } = render(
      <SelectField label="Font" value="menlo" options={OPTIONS} onChange={vi.fn()} />,
    );
    expect(screen.queryByText('Falls back.')).not.toBeInTheDocument();

    rerender(
      <SelectField
        label="Font"
        value="menlo"
        options={OPTIONS}
        onChange={vi.fn()}
        hint="Falls back."
      />,
    );
    expect(screen.getByText('Falls back.')).toBeInTheDocument();
  });
});

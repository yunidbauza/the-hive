import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SegmentedControl } from '@components/ui/segmented-control';

const OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
] as const;

const renderControl = (value: 'system' | 'dark' | 'light' = 'system') => {
  const onChange = vi.fn();
  render(
    <SegmentedControl
      label="Theme"
      options={OPTIONS}
      value={value}
      onChange={onChange}
    />,
  );
  return onChange;
};

describe('SegmentedControl', () => {
  it('is a radio group, with exactly one option checked', () => {
    renderControl('dark');

    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    const options = screen.getAllByRole('radio');

    expect(group).toBeInTheDocument();
    expect(options).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
    expect(options.filter((option) => option.getAttribute('aria-checked') === 'true'))
      .toHaveLength(1);
  });

  it('puts only the selected option in the tab order', () => {
    renderControl('dark');

    // Roving tabindex: a group is one tab stop, not one per option. Without it
    // three options mean three stops and none announces itself as a choice.
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });

  it('selects on click', async () => {
    const user = userEvent.setup();
    const onChange = renderControl('system');

    await user.click(screen.getByRole('radio', { name: 'Light' }));

    expect(onChange).toHaveBeenCalledWith('light');
  });

  it('arrow keys move and select in one gesture', async () => {
    const user = userEvent.setup();
    const onChange = renderControl('system');

    screen.getByRole('radio', { name: 'System' }).focus();
    await user.keyboard('{ArrowRight}');

    // In a radio group arrowing to an option *chooses* it — focusing without
    // selecting would announce an option that is not the one in effect.
    expect(onChange).toHaveBeenCalledWith('dark');
  });

  it('arrowing left from the first option wraps to the last', async () => {
    const user = userEvent.setup();
    const onChange = renderControl('system');

    screen.getByRole('radio', { name: 'System' }).focus();
    await user.keyboard('{ArrowLeft}');

    expect(onChange).toHaveBeenCalledWith('light');
  });

  it('ArrowDown and ArrowUp behave as right and left', async () => {
    const user = userEvent.setup();
    const onChange = renderControl('dark');

    screen.getByRole('radio', { name: 'Dark' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenCalledWith('light');

    await user.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenCalledWith('system');
  });

  it('Home and End jump to the ends', async () => {
    const user = userEvent.setup();
    const onChange = renderControl('dark');

    screen.getByRole('radio', { name: 'Dark' }).focus();
    await user.keyboard('{End}');
    expect(onChange).toHaveBeenCalledWith('light');

    await user.keyboard('{Home}');
    expect(onChange).toHaveBeenCalledWith('system');
  });

  it('leaves other keys to the browser', async () => {
    const user = userEvent.setup();
    const onChange = renderControl('dark');

    screen.getByRole('radio', { name: 'Dark' }).focus();
    await user.keyboard('{Tab}');

    expect(onChange).not.toHaveBeenCalled();
  });
});

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

  /**
   * A single option the machine cannot honour — notification delivery with no
   * desktop to deliver to. Distinct from `disabled`, which takes the whole
   * group and would remove the choices that still work.
   */
  describe('disabledValues', () => {
    const renderWithDead = (value: 'system' | 'dark' | 'light') => {
      const onChange = vi.fn();
      render(
        <SegmentedControl
          label="Theme"
          options={OPTIONS}
          value={value}
          onChange={onChange}
          disabledValues={['light']}
        />,
      );
      return onChange;
    };

    it('disables only the named option', () => {
      renderWithDead('dark');

      expect(screen.getByRole('radio', { name: 'Light' })).toBeDisabled();
      expect(screen.getByRole('radio', { name: 'Dark' })).toBeEnabled();
      expect(screen.getByRole('radio', { name: 'System' })).toBeEnabled();
    });

    /** An arrow key that lands on a dead option reads as a broken control. */
    it('steps over the dead option rather than stopping on it', async () => {
      const user = userEvent.setup();
      const onChange = renderWithDead('dark');

      screen.getByRole('radio', { name: 'Dark' }).focus();
      await user.keyboard('{ArrowRight}');

      expect(onChange).toHaveBeenCalledWith('system');
      expect(onChange).not.toHaveBeenCalledWith('light');
    });

    it('never lands on it from End either', async () => {
      const user = userEvent.setup();
      const onChange = renderWithDead('dark');

      screen.getByRole('radio', { name: 'Dark' }).focus();
      await user.keyboard('{End}');

      expect(onChange).not.toHaveBeenCalled();
    });

    /**
     * The selected option really can be the dead one — a kind defaulting to
     * desktop delivery on a machine with none. A disabled button cannot hold
     * focus, so without a fallback the group leaves the tab order entirely.
     */
    it('keeps a tab stop when the selected option is the dead one', () => {
      renderWithDead('light');

      expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute(
        'tabindex',
        '-1',
      );
      expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute(
        'tabindex',
        '0',
      );
    });
  });

  it('leaves other keys to the browser', async () => {
    const user = userEvent.setup();
    const onChange = renderControl('dark');

    screen.getByRole('radio', { name: 'Dark' }).focus();
    await user.keyboard('{Tab}');

    expect(onChange).not.toHaveBeenCalled();
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ICON_NAMES } from '@components/ui/icon';
import { IconPicker } from '@components/ui/icon-picker';

const NAMES = ['ph-robot', 'ph-slack-logo', 'ph-lightning'] as const;

const renderPicker = (value: string = 'ph-robot') => {
  const onChange = vi.fn();

  render(
    <IconPicker
      label="Icon"
      names={NAMES}
      value={value}
      onChange={onChange}
    />,
  );

  return onChange;
};

describe('IconPicker', () => {
  it('is a radio group, with exactly one option checked', () => {
    renderPicker('ph-slack-logo');

    const group = screen.getByRole('radiogroup', { name: 'Icon' });
    const options = screen.getAllByRole('radio');

    expect(group).toBeInTheDocument();
    expect(options).toHaveLength(NAMES.length);
    expect(
      options.filter((option) => option.getAttribute('aria-checked') === 'true'),
    ).toHaveLength(1);
    expect(screen.getByRole('radio', { name: 'slack logo' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('reports the name that was clicked', async () => {
    const onChange = renderPicker();

    await userEvent.click(screen.getByRole('radio', { name: 'lightning' }));

    expect(onChange).toHaveBeenCalledWith('ph-lightning');
  });

  it('puts exactly one option in the tab order', () => {
    renderPicker('ph-lightning');

    const inOrder = screen
      .getAllByRole('radio')
      .filter((option) => option.getAttribute('tabindex') === '0');

    expect(inOrder).toHaveLength(1);
    expect(inOrder[0]).toHaveAccessibleName('lightning');
  });

  /*
    The file may name an icon this grid does not offer — a hand-written
    `icon: Robot`, or one the app has since dropped. Without a fallback the
    roving tabindex would leave *every* option at -1, so the whole group falls
    out of the tab order and the one user who most needs to change the value is
    the one who cannot reach the control.
  */
  it('stays reachable when the value is not one of its options', () => {
    renderPicker('Robot');

    expect(
      screen
        .getAllByRole('radio')
        .filter((option) => option.getAttribute('tabindex') === '0'),
    ).toHaveLength(1);
    expect(
      screen
        .getAllByRole('radio')
        .filter((option) => option.getAttribute('aria-checked') === 'true'),
    ).toHaveLength(0);
  });

  it('moves and selects with the arrow keys', async () => {
    const onChange = renderPicker('ph-robot');

    screen.getByRole('radio', { name: 'robot' }).focus();
    await userEvent.keyboard('{ArrowRight}');

    expect(onChange).toHaveBeenLastCalledWith('ph-slack-logo');
    expect(screen.getByRole('radio', { name: 'slack logo' })).toHaveFocus();
  });

  it('wraps at the ends', async () => {
    const onChange = renderPicker('ph-robot');

    // Left from the first option lands on the last.
    screen.getByRole('radio', { name: 'robot' }).focus();
    await userEvent.keyboard('{ArrowLeft}');

    expect(onChange).toHaveBeenLastCalledWith('ph-lightning');
    expect(screen.getByRole('radio', { name: 'lightning' })).toHaveFocus();
  });

  it('jumps to the ends with Home and End', async () => {
    const onChange = renderPicker('ph-slack-logo');

    screen.getByRole('radio', { name: 'slack logo' }).focus();
    await userEvent.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('ph-lightning');

    await userEvent.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith('ph-robot');
  });

  /*
    The property that makes the picker worth building. The field it replaces was
    free text, and `icon: Robot` — the pane's own template — missed the registry
    and drew the fallback question mark on every agent row. A picker whose
    options all resolve cannot reach that state; this is what proves the options
    all resolve.
  */
  it('offers only names the Icon atom can draw', () => {
    for (const name of NAMES) {
      expect(ICON_NAMES).toContain(name);
    }
  });
});

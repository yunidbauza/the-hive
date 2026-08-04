import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ProjectRowMenu } from '@features/settings/components/project-row-menu';

/**
 * The one menu that holds every action on a project row (story 103).
 *
 * A menu rather than a row of icon buttons: this list is read far more often
 * than it is edited, so the resting row is what the design optimises. *Move up*
 * and *Move down* live here too — they are the keyboard path for reordering,
 * and being ordinary menu items is what makes the reorder logic provable
 * without driving a drag.
 */
type Props = Parameters<typeof ProjectRowMenu>[0];

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    projectName: 'The Hive',
    canMoveUp: true,
    canMoveDown: true,
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
    onRename: vi.fn(),
    onRepoint: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
  render(<ProjectRowMenu {...props} />);
  return props;
}

const open = () => userEvent.click(screen.getByRole('button'));

describe('ProjectRowMenu', () => {
  it('names the project it acts on, so the trigger is unambiguous', () => {
    setup();
    // Every row has one of these; a bare "more actions" would be identical on
    // all of them to anyone navigating by accessible name.
    expect(
      screen.getByRole('button', { name: /actions for the hive/i }),
    ).toBeInTheDocument();
  });

  it('offers every action on the row', async () => {
    setup();
    await open();

    for (const label of [
      /move up/i,
      /move down/i,
      /rename/i,
      /change folder/i,
      /remove/i,
    ]) {
      expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
  });

  it.each([
    ['Move up', /move up/i, 'onMoveUp'],
    ['Move down', /move down/i, 'onMoveDown'],
    ['Rename', /rename/i, 'onRename'],
    ['Change folder', /change folder/i, 'onRepoint'],
    ['Remove', /remove/i, 'onRemove'],
  ] as const)('calls the handler for %s', async (_label, pattern, handler) => {
    const props = setup();
    await open();
    await userEvent.click(screen.getByRole('menuitem', { name: pattern }));

    expect(props[handler]).toHaveBeenCalledTimes(1);
  });

  it('disables Move up on the first row', async () => {
    const props = setup({ canMoveUp: false });
    await open();

    const item = screen.getByRole('menuitem', { name: /move up/i });
    // Disabled rather than hidden: an item that vanishes on the first row makes
    // the menu a different shape per row, and disabled still announces that the
    // action exists.
    expect(item).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(item);
    expect(props.onMoveUp).not.toHaveBeenCalled();
  });

  it('disables Move down on the last row', async () => {
    const props = setup({ canMoveDown: false });
    await open();

    expect(screen.getByRole('menuitem', { name: /move down/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(
      screen.getByRole('menuitem', { name: /move up/i }),
    ).not.toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(screen.getByRole('menuitem', { name: /move down/i }));
    expect(props.onMoveDown).not.toHaveBeenCalled();
  });

  it('disables both when the list holds one project', async () => {
    setup({ canMoveUp: false, canMoveDown: false });
    await open();

    expect(screen.getByRole('menuitem', { name: /move up/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: /move down/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ProjectRemoveConfirm } from '@features/settings/components/project-remove-confirm';

/**
 * The confirmation that lifts story 101's disabled remove (story 103).
 *
 * The wording is as much the design as the layout. Removing a project deletes a
 * config entry; it does not kill anything, and the sessions keep running
 * unresolved. Saying otherwise would be false, and killing a user's terminals
 * as a side-effect of a settings edit is a much larger action than this story
 * is authorised to take.
 */
function setup(overrides: Partial<Parameters<typeof ProjectRemoveConfirm>[0]> = {}) {
  const props = {
    projectName: 'The Hive',
    liveSessionCount: 3,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<ProjectRemoveConfirm {...props} />);
  return props;
}

describe('ProjectRemoveConfirm', () => {
  it('names the project being removed', () => {
    setup();
    expect(screen.getByText(/the hive/i)).toBeInTheDocument();
  });

  it('says the sessions keep running rather than implying they are killed', () => {
    setup();

    expect(
      screen.getByText(/3 live sessions will keep running/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/directory on disk is untouched/i),
    ).toBeInTheDocument();
  });

  it('uses the singular for one session', () => {
    setup({ liveSessionCount: 1 });
    expect(
      screen.getByText(/1 live session will keep running/i),
    ).toBeInTheDocument();
  });

  it('is announced as a dialog that interrupts', () => {
    setup();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('calls onConfirm and onCancel from their buttons', async () => {
    const props = setup();

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  /** The safe option is the default — a stray Enter must not destroy anything. */
  it('focuses Cancel, not Remove', () => {
    setup();
    expect(screen.getByRole('button', { name: /cancel/i })).toHaveFocus();
  });

  it('cancels on Escape', async () => {
    const props = setup();

    await userEvent.keyboard('{Escape}');

    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  /** Settings is a Radix dialog; a bubbling Escape would dismiss all of it. */
  it('does not let Escape reach the dialog that contains it', async () => {
    const onAncestorKeyDown = vi.fn();
    render(
      <div onKeyDown={onAncestorKeyDown}>
        <ProjectRemoveConfirm
          projectName="A"
          liveSessionCount={0}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      </div>,
    );

    await userEvent.keyboard('{Escape}');

    expect(onAncestorKeyDown).not.toHaveBeenCalled();
  });
});

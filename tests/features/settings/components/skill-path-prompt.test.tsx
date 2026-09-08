import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SkillPathPrompt } from '@features/settings/components/skill-path-prompt';

/**
 * The one-field question New file, New folder and Rename all share (HIVE-148).
 *
 * It validates nothing beyond emptiness — `assertSkillPath` is the rule, and
 * it lives at the IPC boundary where it cannot be bypassed — so these tests
 * are about the box itself: what it starts with, when Confirm is reachable,
 * and that Escape backs out without reaching the dialog around it.
 */
function setup(overrides: Partial<Parameters<typeof SkillPathPrompt>[0]> = {}) {
  const props = {
    question: 'New file',
    hint: 'A path inside the skill, at most four folders deep.',
    confirmLabel: 'Create',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<SkillPathPrompt {...props} />);
  return props;
}

describe('SkillPathPrompt', () => {
  it('is announced as a dialog that interrupts, named by the question', () => {
    setup({ question: 'New folder' });
    expect(
      screen.getByRole('alertdialog', { name: 'New folder' }),
    ).toBeInTheDocument();
  });

  it('shows the rule beneath the box', () => {
    setup({ hint: 'Moving it into a folder that does not exist creates one.' });
    expect(
      screen.getByText('Moving it into a folder that does not exist creates one.'),
    ).toBeInTheDocument();
  });

  it('starts empty with no initial value', () => {
    setup();
    expect(screen.getByRole('textbox', { name: 'New file' })).toHaveValue('');
  });

  it('starts with the old path for a rename', () => {
    setup({ question: 'Rename build.py', initial: 'build.py' });
    expect(
      screen.getByRole('textbox', { name: 'Rename build.py' }),
    ).toHaveValue('build.py');
  });

  it('disables Confirm while the box is empty, or holds only whitespace', async () => {
    setup();
    const confirm = screen.getByRole('button', { name: 'Create' });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByRole('textbox', { name: 'New file' }), '   ');
    expect(confirm).toBeDisabled();
  });

  it('confirms with the value trimmed, on click and on Enter alike', async () => {
    const onConfirm = vi.fn();
    setup({ onConfirm });
    const box = screen.getByRole('textbox', { name: 'New file' });

    await userEvent.type(box, '  refs/schema.json  ');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(onConfirm).toHaveBeenCalledWith('refs/schema.json');

    onConfirm.mockClear();
    await userEvent.clear(box);
    await userEvent.type(box, 'notes.md{Enter}');

    expect(onConfirm).toHaveBeenCalledWith('notes.md');
  });

  it('cancels on Escape', async () => {
    const onCancel = vi.fn();
    setup({ onCancel });

    await userEvent.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel from its own button', async () => {
    const onCancel = vi.fn();
    setup({ onCancel });

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  /** This question appears beside a live editor the caret usually stays in. */
  it('does not let Escape reach the dialog that contains it', async () => {
    const onAncestorKeyDown = vi.fn();
    render(
      <div onKeyDown={onAncestorKeyDown}>
        <SkillPathPrompt
          question="New file"
          hint="A path inside the skill, at most four folders deep."
          confirmLabel="Create"
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      </div>,
    );

    await userEvent.keyboard('{Escape}');

    expect(onAncestorKeyDown).not.toHaveBeenCalled();
  });
});

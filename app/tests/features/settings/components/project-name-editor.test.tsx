import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ProjectNameEditor } from '@features/settings/components/project-name-editor';

/**
 * Renaming a project in place (story 103).
 *
 * The rule this component owns is "is this worth writing?" — a blank name and
 * an unchanged name are both cancels. Keeping it here means no caller has to
 * re-derive it, and the guard in main rejects a blank name anyway, so this is
 * the convenience rather than the gate.
 */
describe('ProjectNameEditor', () => {
  it('focuses and selects the current name, so typing replaces it', () => {
    render(
      <ProjectNameEditor
        initialName="The Hive"
        onCommit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;

    expect(input).toHaveFocus();
    // Selected, not merely focused: the common edit replaces a derived
    // basename outright, and that should not need a Cmd+A first.
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('The Hive'.length);
  });

  it('commits a changed name on Enter, trimmed', async () => {
    const onCommit = vi.fn();
    render(
      <ProjectNameEditor
        initialName="Old"
        onCommit={onCommit}
        onCancel={vi.fn()}
      />,
    );

    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), '  New  {Enter}');

    expect(onCommit).toHaveBeenCalledWith('New');
  });

  it('cancels on Escape without committing', async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(
      <ProjectNameEditor
        initialName="Old"
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );

    await userEvent.type(screen.getByRole('textbox'), 'X{Escape}');

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  /**
   * Escape blurs the input, and blur commits. Without the guard the cancel
   * would be immediately undone by the very event it caused.
   */
  it('does not commit on the blur that Escape itself causes', async () => {
    const onCommit = vi.fn();
    render(
      <ProjectNameEditor
        initialName="Old"
        onCommit={onCommit}
        onCancel={vi.fn()}
      />,
    );

    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), 'Changed{Escape}');
    await userEvent.tab();

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('cancels rather than committing when the name is blank', async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(
      <ProjectNameEditor
        initialName="Old"
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );

    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), '   {Enter}');

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it('cancels rather than writing an unchanged name', async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(
      <ProjectNameEditor
        initialName="Old"
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );

    await userEvent.type(screen.getByRole('textbox'), '{Enter}');

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it('commits on blur, so clicking away is not a silent discard', async () => {
    const onCommit = vi.fn();
    render(
      <ProjectNameEditor
        initialName="Old"
        onCommit={onCommit}
        onCancel={vi.fn()}
      />,
    );

    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), 'New');
    await userEvent.tab();

    expect(onCommit).toHaveBeenCalledWith('New');
  });
});

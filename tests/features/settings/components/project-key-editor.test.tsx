import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ProjectKeyEditor } from '@features/settings/components/project-key-editor';

/**
 * The inline key editor (HIVE-94).
 *
 * A sibling of `project-name-editor.test.tsx`, and the shared half — focus on
 * mount, blur commits, Escape cancels — is asserted here again rather than
 * assumed: the two editors are separate components, and "it behaves like the
 * other one" is not something a test can inherit.
 *
 * What is unique to this one is validation. A name cannot really be wrong; a
 * key can be too long, not letters, or already someone else's, and each of
 * those has to be visible *before* the user commits rather than arriving as a
 * refusal after the editor has closed.
 */
function setup(overrides: Partial<Parameters<typeof ProjectKeyEditor>[0]> = {}) {
  const props = {
    initialKey: 'hive',
    takenKeys: new Map([['is', 'IncorpX Server']]),
    onCommit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<ProjectKeyEditor {...props} />);
  return props;
}

const field = () => screen.getByRole('textbox', { name: 'Project key' });

describe('ProjectKeyEditor', () => {
  it('starts focused with the current key selected', async () => {
    setup();

    // On the next frame, not synchronously — the editor opens from a Radix
    // menu that moves focus as it unmounts. See the component for the full
    // reason; here it means waiting.
    await waitFor(() => expect(field()).toHaveFocus());
    expect((field() as HTMLInputElement).selectionStart).toBe(0);
    expect((field() as HTMLInputElement).selectionEnd).toBe(4);
  });

  it('teaches the rule at rest', () => {
    setup();

    expect(
      screen.getByText('2–4 lowercase letters · Enter to save'),
    ).toBeInTheDocument();
  });

  it('commits a valid new key on Enter', async () => {
    const user = userEvent.setup();
    const { onCommit } = setup();

    await user.clear(field());
    await user.type(field(), 'ix{Enter}');

    expect(onCommit).toHaveBeenCalledWith('ix');
  });

  it('commits on blur, because clicking away should not discard an edit', async () => {
    const user = userEvent.setup();
    const { onCommit } = setup();

    await user.clear(field());
    await user.type(field(), 'ix');
    await user.tab();

    expect(onCommit).toHaveBeenCalledWith('ix');
  });

  it('cancels on Escape without committing', async () => {
    const user = userEvent.setup();
    const { onCommit, onCancel } = setup();

    await user.clear(field());
    await user.type(field(), 'ix{Escape}');

    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('treats an unchanged key as a cancel', async () => {
    const user = userEvent.setup();
    const { onCommit, onCancel } = setup();

    await user.type(field(), '{Enter}');

    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  /*
    Lowercased as it is typed rather than refused. Keys are lowercase by
    definition, so a capital is a shift key that was still down — a slip, not
    an intent.
  */
  it('lowercases what the user types', async () => {
    const user = userEvent.setup();
    const { onCommit } = setup();

    await user.clear(field());
    await user.type(field(), 'IX{Enter}');

    expect(onCommit).toHaveBeenCalledWith('ix');
  });

  describe('validation', () => {
    it('shows the rule in red and refuses to commit a key that is too short', async () => {
      const user = userEvent.setup();
      const { onCommit } = setup();

      await user.clear(field());
      await user.type(field(), 'i');

      expect(field()).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText('2–4 lowercase letters')).toBeInTheDocument();

      await user.type(field(), '{Enter}');
      expect(onCommit).not.toHaveBeenCalled();
    });

    it('cannot be made too long, because the field will not take it', async () => {
      const user = userEvent.setup();
      setup();

      await user.clear(field());
      await user.type(field(), 'abcdef');

      expect(field()).toHaveValue('abcd');
    });

    it('names the project already holding the key', async () => {
      const user = userEvent.setup();
      const { onCommit } = setup();

      await user.clear(field());
      await user.type(field(), 'is');

      // "already used" would send the user hunting; naming the row they can go
      // and look at is the difference between a refusal and an answer.
      expect(
        screen.getByText('already used by IncorpX Server'),
      ).toBeInTheDocument();

      await user.type(field(), '{Enter}');
      expect(onCommit).not.toHaveBeenCalled();
    });

    /**
     * Its own key is not "taken".
     *
     * Re-opening the editor and pressing Enter has to be a no-op rather than a
     * refusal against itself — the same allowance `setProjectKey` makes in main
     * when it skips the entry being edited.
     */
    it('does not refuse the key the project already has', () => {
      setup({ takenKeys: new Map([['is', 'IncorpX Server']]) });

      expect(field()).toHaveAttribute('aria-invalid', 'false');
    });

    /*
      Blur on an invalid value cancels rather than commits. Committing would
      mean a refusal arriving from main after the editor had closed, with the
      reason in a snapshot error nothing on the row renders.
    */
    it('cancels rather than commits when blurred while invalid', async () => {
      const user = userEvent.setup();
      const { onCommit, onCancel } = setup();

      await user.clear(field());
      await user.type(field(), 'i');
      await user.tab();

      expect(onCommit).not.toHaveBeenCalled();
      expect(onCancel).toHaveBeenCalled();
    });
  });

  it('claims Escape from the settings dialog', () => {
    setup();

    // Radix decides on a document-capture listener that runs before this
    // component's own handler, so the overlay consults this attribute instead.
    expect(field()).toHaveAttribute('data-escape-scope');
  });
});

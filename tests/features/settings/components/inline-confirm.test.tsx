import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InlineConfirm } from '@features/settings/components/inline-confirm';

/**
 * The shell both destructive confirmations share. What matters is that it
 * cannot fire by accident: focus starts on Cancel, Escape backs out without
 * reaching the settings overlay, and only the destructive button confirms.
 */

function renderConfirm(onConfirm = vi.fn(), onCancel = vi.fn()) {
  render(
    <InlineConfirm
      label="Drop the thing?"
      title="Drop the thing for good?"
      confirmLabel="Drop"
      className="border border-red"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      Nothing on disk changes.
    </InlineConfirm>,
  );
  return { onConfirm, onCancel };
}

const outside = vi.fn();

afterEach(() => {
  document.removeEventListener('keydown', outside);
  outside.mockReset();
});

describe('InlineConfirm', () => {
  it('is an alertdialog that claims Escape from the settings overlay', () => {
    renderConfirm();

    const dialog = screen.getByRole('alertdialog', { name: 'Drop the thing?' });
    expect(dialog).toHaveAttribute('data-escape-scope');
    expect(dialog).toHaveTextContent('Drop the thing for good?');
    expect(dialog).toHaveTextContent('Nothing on disk changes.');
  });

  it('focuses Cancel, not the destructive button', () => {
    renderConfirm();

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('confirms only from the destructive button', async () => {
    const { onConfirm, onCancel } = renderConfirm();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Drop' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape and keeps the key from reaching the document', async () => {
    document.addEventListener('keydown', outside);
    const { onCancel } = renderConfirm();

    await userEvent.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(outside).not.toHaveBeenCalled();
  });

  it('labels the safe button as the caller asks', () => {
    render(
      <InlineConfirm
        label="Discard?"
        title="Discard?"
        confirmLabel="Discard"
        className=""
        cancelLabel="Keep editing"
        onConfirm={() => {}}
        onCancel={() => {}}
      >
        body
      </InlineConfirm>,
    );

    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
  });

  /*
    The case the skill panes need: the caret is in the editor beside the
    confirm, so no button ever sees the key. Capture on the document is what
    makes Escape mean "back out" there rather than nothing at all.
  */
  it('with escape="document", Escape anywhere cancels before anything else sees it', async () => {
    const onCancel = vi.fn();
    document.addEventListener('keydown', outside);
    render(
      <InlineConfirm
        label="Discard?"
        title="Discard?"
        confirmLabel="Discard"
        className=""
        escape="document"
        onConfirm={() => {}}
        onCancel={onCancel}
      >
        body
      </InlineConfirm>,
    );
    document.body.focus();

    await userEvent.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(outside).not.toHaveBeenCalled();
  });
});

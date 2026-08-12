import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConfigResetConfirm } from '@features/settings/components/config-reset-confirm';

/**
 * The reset confirmation (story 107).
 *
 * What is worth asserting is not that it renders, but that it cannot fire by
 * accident: focus starts on Cancel, Escape backs out, and the destructive
 * callback runs only from the destructive button.
 */

describe('ConfigResetConfirm', () => {
  it('names how many projects are lost, pluralised', () => {
    const { unmount } = render(
      <ConfigResetConfirm projectCount={1} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/1 project,/)).toBeInTheDocument();
    unmount();

    render(
      <ConfigResetConfirm projectCount={3} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/3 projects,/)).toBeInTheDocument();
  });

  /**
   * The one promise every other write keeps and this one breaks.
   *
   * The template is deliberately comment-heavy and the product encourages
   * hand-editing, so a user who annotated their config is exactly who this
   * confirmation is for. If this sentence ever goes missing, the confirmation
   * has stopped naming the thing that is actually irreversible.
   */
  it('says the comments go too', () => {
    render(
      <ConfigResetConfirm projectCount={0} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/comments you added/i)).toBeInTheDocument();
  });

  it('does not claim anything happens to the repositories', () => {
    render(
      <ConfigResetConfirm projectCount={2} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/nothing on disk is deleted/i)).toBeInTheDocument();
  });

  it('focuses Cancel, not the destructive button', () => {
    render(
      <ConfigResetConfirm projectCount={2} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('calls onConfirm only from the destructive button', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfigResetConfirm
        projectCount={2}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Reset config' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('backs out on Escape from either button', async () => {
    const onCancel = vi.fn();
    render(
      <ConfigResetConfirm projectCount={0} onConfirm={vi.fn()} onCancel={onCancel} />,
    );

    // Focus starts on Cancel.
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);

    screen.getByRole('button', { name: 'Reset config' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  /**
   * Without this the whole overlay closes on Escape instead of the
   * confirmation, because Radix listens on the document in the capture phase —
   * a `stopPropagation` can never win that race. See `settings-overlay.tsx`.
   */
  it('claims Escape from the settings dialog', () => {
    render(
      <ConfigResetConfirm projectCount={0} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole('alertdialog')).toHaveAttribute('data-escape-scope');
  });
});

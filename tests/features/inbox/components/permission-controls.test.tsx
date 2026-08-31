import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PermissionControls } from '@/features/inbox/components/permission-controls';

const RUNGS = [
  { id: 'allow-once' as const, label: 'once', caption: 'runs this once. asks again next time.' },
  { id: 'allow-family' as const, label: 'git *', caption: 'never asks again for git commands.', rule: 'Bash(git *)' },
  { id: 'allow-tool' as const, label: 'all Bash', caption: 'never asks again for Bash.', rule: 'Bash' },
];

const setup = (overrides = {}) => {
  const onAnswer = vi.fn();
  render(
    <PermissionControls
      rungs={RUNGS}
      initial="allow-family"
      sending={false}
      onAnswer={onAnswer}
      {...overrides}
    />,
  );
  return { onAnswer };
};

describe('PermissionControls', () => {
  it('offers one scope per rung and preselects the default', () => {
    setup();
    for (const rung of RUNGS) expect(screen.getByRole('radio', { name: rung.label })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'git *' }).getAttribute('aria-checked')).toBe('true');
  });

  it('shows the caption for the selected scope, and follows the selection', () => {
    setup();
    expect(screen.getByText('never asks again for git commands.')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'once' }));
    expect(screen.getByText('runs this once. asks again next time.')).toBeTruthy();
  });

  it('answers with the selected rung id', () => {
    const { onAnswer } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onAnswer).toHaveBeenCalledWith('allow-family');

    fireEvent.click(screen.getByRole('radio', { name: 'all Bash' }));
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onAnswer).toHaveBeenLastCalledWith('allow-tool');
  });

  it('answers deny', () => {
    const { onAnswer } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onAnswer).toHaveBeenCalledWith('deny');
  });

  it('keeps two buttons when a tool has no family rung', () => {
    setup({ rungs: [RUNGS[0]!, RUNGS[2]!], initial: 'allow-tool' });
    expect(screen.queryByRole('radio', { name: 'git *' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
  });

  it('disables both buttons while an answer is in flight', () => {
    setup({ sending: true });
    expect(screen.getByRole('button', { name: 'Allow' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveProperty('disabled', true);
  });

  /**
   * Fix round 1, finding 1: the scope segment is `SegmentedControl`, not a
   * hand-rolled radiogroup, specifically so arrow keys move between rungs.
   * This proves the wiring actually works end to end, not just that the
   * atom exists.
   */
  it('moves the scope with arrow keys, and Allow posts whatever arrow keys landed on', () => {
    const { onAnswer } = setup();
    fireEvent.keyDown(screen.getByRole('radio', { name: 'git *' }), { key: 'ArrowRight' });
    expect(
      screen.getByRole('radio', { name: 'all Bash' }).getAttribute('aria-checked'),
    ).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onAnswer).toHaveBeenCalledWith('allow-tool');
  });
});

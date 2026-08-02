import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { ConsoleInput } from '@features/orchestrator/components/console-input';
import { useHiveStore, useNavOrder } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

const input = () => screen.getByRole('textbox', { name: 'Orchestrator command' });

const transcript = () =>
  useHiveStore
    .getState()
    .orchLines.map((line) => line.text)
    .join('\n');

/**
 * The command row (story 041). The grammar itself is covered by the parser and
 * store tests; this file covers the keyboard contract — what Enter, the arrows,
 * and ordinary typing do.
 */
describe('ConsoleInput', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
  });

  it('autofocuses so the arrow keys work without a click', async () => {
    render(<ConsoleInput />);

    // The hint bar promises these shortcuts; an unfocused input would make it
    // a lie.
    expect(input()).toHaveFocus();
  });

  it('runs a typed command on Enter and clears the prompt', async () => {
    const user = userEvent.setup();
    render(<ConsoleInput />);

    await user.type(input(), 'help{Enter}');

    expect(transcript()).toContain('❯ help');
    expect(input()).toHaveValue('');
  });

  it('reports an unknown command rather than swallowing it', async () => {
    const user = userEvent.setup();
    render(<ConsoleInput />);

    await user.type(input(), 'frobnicate{Enter}');

    expect(transcript()).toContain('command not found: frobnicate');
  });

  describe('selection', () => {
    it('moves down and up with the arrow keys', async () => {
      const user = userEvent.setup();
      render(<ConsoleInput />);

      await user.keyboard('{ArrowDown}{ArrowDown}');
      expect(useUiStore.getState().selIdx).toBe(2);

      await user.keyboard('{ArrowUp}');
      expect(useUiStore.getState().selIdx).toBe(1);
    });

    it('clamps at both ends instead of wrapping', async () => {
      const user = userEvent.setup();
      const { result } = renderNavOrder();
      render(<ConsoleInput />);

      await user.keyboard('{ArrowUp}');
      // Running off the top and reappearing at the bottom loses the user's
      // place; clamping keeps it.
      expect(useUiStore.getState().selIdx).toBe(0);

      for (let i = 0; i < result.length + 3; i += 1) {
        await user.keyboard('{ArrowDown}');
      }
      expect(useUiStore.getState().selIdx).toBe(result.length - 1);
    });
  });

  describe('opening the selected session', () => {
    it('opens on Enter when the prompt is empty', async () => {
      const user = userEvent.setup();
      render(<ConsoleInput />);

      await user.keyboard('{ArrowDown}{Enter}');

      expect(useUiStore.getState().activeTab).toBe('lead-form');
    });

    it('opens on ArrowRight when the prompt is empty', async () => {
      const user = userEvent.setup();
      render(<ConsoleInput />);

      await user.keyboard('{ArrowRight}');

      expect(useUiStore.getState().activeTab).toBe('hero-refresh');
    });

    it('leaves ArrowRight alone while there is text to move through', async () => {
      const user = userEvent.setup();
      render(<ConsoleInput />);

      await user.type(input(), 'help');
      await user.keyboard('{ArrowRight}');

      // Hijacking ArrowRight mid-edit would make the prompt unusable.
      expect(useUiStore.getState().activeTab).toBe('orch');
      expect(input()).toHaveValue('help');
    });
  });

  it('shows the grammar as placeholder text', () => {
    render(<ConsoleInput />);

    expect(input()).toHaveAttribute(
      'placeholder',
      'help · status · send <session> <message> · spawn <repo> <task>',
    );
  });

  it('keeps the hint bar beneath the prompt', () => {
    render(<ConsoleInput />);

    // The concept shows both; the hint bar is what says the console is
    // read-only and the orchestrator keeps working regardless.
    expect(screen.getByText('↑↓ select')).toBeInTheDocument();
    expect(
      screen.getByText('read-only — the orchestrator coordinates in the background'),
    ).toBeInTheDocument();
  });
});

/** Read `navOrder` once, outside a component, for the clamp bounds. */
function renderNavOrder() {
  let result: string[] = [];
  function Probe() {
    result = useNavOrder();
    return null;
  }
  render(<Probe />);
  return { result };
}

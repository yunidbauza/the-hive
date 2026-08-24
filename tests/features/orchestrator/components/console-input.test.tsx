import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { CONSOLE_VERBS } from '@/types/command';
import { ConsoleInput } from '@features/orchestrator/components/console-input';
import { useHiveStore, useNavOrder } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

const input = () => screen.getByRole('textbox', { name: 'Overmind command' });

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
    seedDemoFleet();
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
      'help · status · send <session> <message> · spawn <project> <task>',
    );
  });

  /**
   * The hint bar lists the grammar instead of claiming to be read-only
   * (HIVE-93).
   *
   * The old third hint — `read-only — the orchestrator coordinates in the
   * background` — spent the one remaining slot on a reassurance nobody needed,
   * and was also simply wrong: `send` and `spawn` both act on the fleet from this
   * row. The verbs go there because the grammar was otherwise discoverable only
   * by typing `help`, which you have to already know exists.
   */
  it('keeps the hint bar beneath the prompt, listing every verb', () => {
    render(<ConsoleInput />);

    expect(screen.getByText('↑↓ select')).toBeInTheDocument();

    /*
      Asserted against `CONSOLE_VERBS` rather than a copy of the string: the whole
      point of that constant is that the footer and the grammar cannot drift, and
      a literal here would be a third place to update.
    */
    expect(
      screen.getByText(CONSOLE_VERBS.join(' · ')),
    ).toBeInTheDocument();
    // The claim that is gone, pinned so it cannot come back by accident.
    expect(screen.queryByText(/read-only/)).toBeNull();
    expect(screen.queryByText(/orchestrator/i)).toBeNull();
  });

  /**
   * `⇧↵` inserts a line, `↵` alone runs.
   *
   * The row was an `<input>` until this story, which is why the bug could not
   * be fixed by handling a key: a single-line input has nowhere to *put* a
   * newline. The element type is therefore part of the contract, not an
   * implementation detail, and is asserted as such.
   */
  describe('multi-line input', () => {
    it('is a textarea, because an input cannot hold a line break', () => {
      render(<ConsoleInput />);

      expect(input().tagName).toBe('TEXTAREA');
    });

    it('inserts a newline on Shift+Enter instead of running', async () => {
      const user = userEvent.setup();
      render(<ConsoleInput />);

      await user.type(input(), 'send lead-form first{Shift>}{Enter}{/Shift}second');

      expect(input()).toHaveValue('send lead-form first\nsecond');
      // Nothing ran: the transcript is still empty of this command.
      expect(transcript()).not.toContain('first');
    });

    it('still runs the whole thing on a bare Enter, newlines and all', async () => {
      const user = userEvent.setup();
      render(<ConsoleInput />);

      await user.type(input(), 'send lead-form first{Shift>}{Enter}{/Shift}second');
      await user.keyboard('{Enter}');

      expect(input()).toHaveValue('');
      /**
       * The continuation line is indented under the prompt glyph because the
       * echo is now **one transcript entry per line** — `ORCH_LINE_CAP` counts
       * entries while the surface renders `convertEol: true`, so an entry
       * holding newlines was one line to the cap and many rows on screen.
       */
      expect(transcript()).toContain('❯ send lead-form first\n  second');
    });

    it('opens the selected session on Shift+Enter never — even when empty', async () => {
      /**
       * The ordering trap. With an empty row a bare `↵` opens the selected
       * session, so a `⇧↵` check placed *after* that branch would throw a user
       * starting a message with a blank first line straight into a terminal.
       */
      const user = userEvent.setup();
      render(<ConsoleInput />);

      const before = useUiStore.getState().activeTab;

      await user.keyboard('{Shift>}{Enter}{/Shift}');

      expect(input()).toHaveValue('\n');
      expect(useUiStore.getState().activeTab).toBe(before);
    });

    it('gives the arrow keys back to the caret once there are two lines', async () => {
      /**
       * The regression this change could have introduced: a field you can type
       * three lines into but cannot move the caret back up through. Single-line
       * content — every command the console had before — keeps navigating, and
       * the tests above this block prove that half.
       */
      const user = userEvent.setup();
      render(<ConsoleInput />);

      await user.keyboard('{ArrowDown}');
      const selected = useUiStore.getState().selIdx;

      await user.type(input(), 'one{Shift>}{Enter}{/Shift}two');
      await user.keyboard('{ArrowUp}{ArrowUp}');

      // The selection did not move: the textarea kept the key.
      expect(useUiStore.getState().selIdx).toBe(selected);
      expect(input()).toHaveValue('one\ntwo');
    });
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

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageInput } from '@features/sessions/components/message-input';
import { ACK_DELAY_MS, useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

const input = (id = 'lead-form') =>
  screen.getByRole('textbox', { name: `Message ${id}` });

const linesOf = (id: string) =>
  useHiveStore.getState().entities[id].lines.map((line) => line.text);

/**
 * Type and submit synchronously.
 *
 * `fireEvent` rather than `userEvent` in the fake-timer tests: userEvent awaits
 * internally, and pairing those waits with a mocked clock makes every
 * interaction hang. The component reads `value` and `key`, both of which these
 * two events deliver faithfully.
 */
const submit = (field: HTMLElement, text: string) => {
  fireEvent.change(field, { target: { value: text } });
  fireEvent.keyDown(field, { key: 'Enter' });
};

/**
 * The message row (story 043) — the product's core promise in one component.
 * A session parked on a question is answered here, and resumes.
 */
describe('MessageInput', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prompts with the entity id and the routing hint', () => {
    render(<MessageInput entityId="lead-form" />);

    expect(screen.getByText('lead-form ❯')).toBeInTheDocument();
    expect(screen.getByText('← back to list · ↵ send')).toBeInTheDocument();
  });

  /**
   * The placeholder is where the browser build stops pretending (story 083).
   * The row still sends in both targets — the fake round-trip is the
   * prototype's core promise — but what sits above it differs, and this is
   * where that stops being a surprise.
   */
  it('says the transcript is a recording when there is no bridge', () => {
    render(<MessageInput entityId="lead-form" />);

    expect(input()).toHaveAttribute(
      'placeholder',
      'demo mode — this transcript is a recording',
    );
  });

  it('offers the real routing hint on desktop', () => {
    (window as { hive?: unknown }).hive = { appInfo: () => Promise.resolve({}) };
    try {
      render(<MessageInput entityId="lead-form" />);

      expect(input()).toHaveAttribute(
        'placeholder',
        'message this session — routed by the orchestrator',
      );
    } finally {
      delete (window as { hive?: unknown }).hive;
    }
  });

  it('advertises the bare arrow — the only binding this row has', () => {
    /**
     * The row exists only beneath a **recording** now (story 108): a live
     * session has Claude's own prompt, and a second text box beside it is two
     * places to type with no way to tell which owns the keyboard. So there is no
     * live variant of this hint left to pick between, and `←` is simply true.
     */
    render(<MessageInput entityId="lead-form" />);

    const hint = screen.getByTestId('key-hint').textContent ?? '';
    expect(hint).toContain('← back to list');
    expect(hint).toContain('↵ send');
  });

  it('autofocuses when the view opens', () => {
    render(<MessageInput entityId="lead-form" />);

    expect(input()).toHaveFocus();
  });

  describe('the send flow', () => {
    it('echoes the message in cyan after a blank line, and clears the prompt', async () => {
      const user = userEvent.setup();
      render(<MessageInput entityId="lead-form" />);

      await user.type(input(), 'yes go ahead{Enter}');

      const lines = useHiveStore.getState().entities['lead-form'].lines;
      expect(lines.at(-1)).toEqual({ text: '❯ yes go ahead', color: 'cyan' });
      // The blank line above makes it read as a new turn rather than more
      // output from the agent.
      expect(lines.at(-2)).toEqual({ text: '', color: 'ink' });
      expect(input()).toHaveValue('');
    });

    it('acknowledges and flips the session to working after the delay', () => {
      vi.useFakeTimers();
      render(<MessageInput entityId="lead-form" />);

      submit(input(), 'yes');
      expect(useHiveStore.getState().entities['lead-form']).toMatchObject({
        status: 'waiting',
      });

      act(() => {
        vi.advanceTimersByTime(ACK_DELAY_MS);
      });

      // The payoff: a blocked session picks the answer up and resumes.
      expect(linesOf('lead-form')).toContain('● Acknowledged — working on it');
      expect(linesOf('lead-form')).toContain('✱ Working…');
      expect(useHiveStore.getState().entities['lead-form']).toMatchObject({
        status: 'working',
      });
    });

    it('gives two rapid sends their own acknowledgements', () => {
      vi.useFakeTimers();
      render(<MessageInput entityId="lead-form" />);

      submit(input(), 'first');
      submit(input(), 'second');

      act(() => {
        vi.advanceTimersByTime(ACK_DELAY_MS);
      });

      // One timer per message: the second must not cancel the first.
      const acks = linesOf('lead-form').filter(
        (text) => text === '● Acknowledged — working on it',
      );
      expect(acks).toHaveLength(2);
    });

    it('keeps an agent online rather than marking it working', () => {
      vi.useFakeTimers();
      render(<MessageInput entityId="slack-agent" />);

      submit(input('slack-agent'), 'status?');
      act(() => {
        vi.advanceTimersByTime(ACK_DELAY_MS);
      });

      // Agents are long-lived workers; `working` is a session lifecycle state.
      expect(useHiveStore.getState().entities['slack-agent']).toMatchObject({
        status: 'online',
      });
    });

    it('ignores an empty or whitespace-only message', async () => {
      const user = userEvent.setup();
      render(<MessageInput entityId="lead-form" />);
      const before = linesOf('lead-form').length;

      await user.type(input(), '{Enter}');
      await user.type(input(), '   {Enter}');

      expect(linesOf('lead-form')).toHaveLength(before);
    });

    it('keeps focus after sending', async () => {
      const user = userEvent.setup();
      render(<MessageInput entityId="lead-form" />);

      await user.type(input(), 'yes{Enter}');

      expect(input()).toHaveFocus();
    });
  });

  describe('ArrowLeft', () => {
    it('returns to the orchestrator when the prompt is empty', async () => {
      const user = userEvent.setup();
      useUiStore.getState().openTab('lead-form');
      render(<MessageInput entityId="lead-form" />);

      await user.keyboard('{ArrowLeft}');

      expect(useUiStore.getState().activeTab).toBe('orch');
    });

    it('leaves the caret alone while there is text', async () => {
      const user = userEvent.setup();
      useUiStore.getState().openTab('lead-form');
      render(<MessageInput entityId="lead-form" />);

      await user.type(input(), 'draft');
      await user.keyboard('{ArrowLeft}');

      // Hijacking ArrowLeft mid-edit would make the prompt unusable.
      expect(useUiStore.getState().activeTab).toBe('lead-form');
      expect(input()).toHaveValue('draft');
    });

    it.each([
      ['⌘← — start of line', '{Meta>}{ArrowLeft}{/Meta}'],
      ['⌥← — back one word', '{Alt>}{ArrowLeft}{/Alt}'],
      ['⇧← — extend selection', '{Shift>}{ArrowLeft}{/Shift}'],
    ])('stays put for %s, even on an empty prompt (HIVE-65)', async (_label, keys) => {
      /**
       * The empty-prompt guard was here from the start; the modifier guard was
       * not, so every one of these navigated away from an empty row. They are
       * text-editing keys, and a field that answers them by changing screen
       * punishes muscle memory — the same mistake the terminal made with `⌘←`.
       */
      const user = userEvent.setup();
      useUiStore.getState().openTab('lead-form');
      render(<MessageInput entityId="lead-form" />);

      await user.keyboard(keys);

      expect(useUiStore.getState().activeTab).toBe('lead-form');
    });
  });
});

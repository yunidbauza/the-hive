import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '@/types/entity';

import { AskCard } from '@features/inbox/components/ask-card';
import { useHiveStore } from '@stores/hive-store';

import { seedLedger } from '@tests/support/ledger';

const ask = {
  id: 'a41',
  ts: Date.now(),
  from: 'drone',
  to: 'overmind',
  kind: 'ask' as const,
  body: 'ship it?',
  meta: { options: ['yes', 'no'] },
};

const notif = {
  id: 'a41',
  kind: 'agent.ask' as const,
  title: 'ship it?',
  body: '',
  unread: true,
  createdAt: Date.now(),
  action: { type: 'ask' as const, thread: 'a41' },
};

describe('AskCard', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'hive');
  });

  it('names the asker and draws one button per option, the first primary', () => {
    seedLedger([ask]);
    render(<AskCard notif={notif} thread="a41" />);

    expect(screen.getByText('drone')).toBeInTheDocument();
    const yes = screen.getByRole('button', { name: 'yes' });
    expect(yes.className).toContain('bg-brand-fill');
    expect(screen.getByRole('button', { name: 'no' })).toBeInTheDocument();
  });

  it('answers with the option id', async () => {
    const answerAsk = vi.fn().mockResolvedValue(undefined);
    seedLedger([ask], { answerAsk });
    render(<AskCard notif={notif} thread="a41" />);

    await userEvent.click(screen.getByRole('button', { name: 'yes' }));
    expect(answerAsk).toHaveBeenCalledWith('a41', 'yes');
  });

  it('offers a text input and Send when the ask carries no options', async () => {
    const answerAsk = vi.fn().mockResolvedValue(undefined);
    seedLedger([{ ...ask, meta: {} }], { answerAsk });
    render(<AskCard notif={notif} thread="a41" />);

    await userEvent.type(screen.getByRole('textbox'), 'the staging one');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(answerAsk).toHaveBeenCalledWith('a41', 'the staging one');
  });

  it('shows a quote and opens it for editing, sending body approve plus meta.edited', async () => {
    const answerAsk = vi.fn().mockResolvedValue(undefined);
    seedLedger(
      [{ ...ask, meta: { quote: 'draft text', options: ['approve', 'edit', 'reject'] } }],
      { answerAsk },
    );
    render(<AskCard notif={notif} thread="a41" />);

    expect(screen.getByText('draft text')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /edit/i }));

    const box = screen.getByRole('textbox');
    await userEvent.clear(box);
    await userEvent.type(box, 'edited text');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(answerAsk).toHaveBeenCalledWith('a41', 'approve', {
      edited: 'edited text',
    });
  });

  it('collapses to one line once the thread has an answer', () => {
    seedLedger([
      ask,
      { ...ask, id: 'x2', kind: 'answer' as const, thread: 'a41', from: 'overmind', body: 'yes', meta: {} },
    ]);
    render(<AskCard notif={notif} thread="a41" />);

    expect(screen.getByText(/answered/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'yes' })).not.toBeInTheDocument();
  });

  it('falls back to the notification text when the entry has aged out of the store', () => {
    seedLedger([]);
    render(<AskCard notif={notif} thread="a41" />);

    expect(screen.getByText('ship it?')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('draws the permission variant with three buttons', () => {
    seedLedger([
      {
        ...ask,
        body: 'Allow Bash?',
        meta: { kind: 'permission', tool: 'Bash', options: ['allow-once', 'allow-agent', 'deny'] },
      },
    ]);
    render(<AskCard notif={{ ...notif, kind: 'agent.permission' }} thread="a41" />);

    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  /**
   * Whole-branch review, finding 5: `EDIT` used to be a prefix match
   * (`/^edit/i`), so an option that merely *starts* with those letters — a
   * model choosing more descriptive copy — hijacked the draft affordance
   * instead of sending the answer the model actually offered.
   */
  it('sends a look-alike option verbatim rather than opening the draft', async () => {
    const answerAsk = vi.fn().mockResolvedValue({ ok: true, id: 'a41' });
    seedLedger(
      [{ ...ask, meta: { quote: 'draft text', options: ['editorial pass', 'reject'] } }],
      { answerAsk },
    );
    render(<AskCard notif={notif} thread="a41" />);

    await userEvent.click(screen.getByRole('button', { name: 'editorial pass' }));

    expect(answerAsk).toHaveBeenCalledWith('a41', 'editorial pass');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  /**
   * Whole-branch review, finding 6: `ask.from` is a party id, and handing an
   * agent's name to `useDisplayName` risks resolving it through session
   * lookup — a collision `isAgentId` already closes on the toast path. The
   * card must show the agent's own name outright, never a session's.
   */
  it('shows an agent asker by its own name, never through session lookup', () => {
    const agent: Agent = {
      kind: 'agent',
      id: 'drone',
      icon: 'ph-robot',
      sub: '',
      task: '',
      status: 'sleeping',
      wake: { on: [] },
      runsSinceRotate: 0,
      rotateAfter: 50,
      runs: [],
      lines: [],
    };

    seedLedger([ask]);
    useHiveStore.setState((state) => ({
      entities: { ...state.entities, [agent.id]: agent },
      agentOrder: [...state.agentOrder, agent.id],
    }));

    render(<AskCard notif={notif} thread="a41" />);

    expect(screen.getByText('drone')).toBeInTheDocument();
  });

  /**
   * Whole-branch review, finding 3: `Ledger.answer` refuses as a value, not a
   * throw, once a thread is no longer an open ask. Discarding that result —
   * the bug this proves is fixed — left the buttons re-enabled with nothing
   * to distinguish "it worked" from "it was refused".
   */
  it('surfaces a refusal inline and leaves the card open, buttons enabled', async () => {
    const answerAsk = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      reason: 'This ask is no longer open.',
    });
    seedLedger([ask], { answerAsk });
    render(<AskCard notif={notif} thread="a41" />);

    await userEvent.click(screen.getByRole('button', { name: 'yes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This ask is no longer open.',
    );
    // Still an open ask, not the collapsed one-liner.
    expect(screen.getByRole('button', { name: 'yes' })).toBeEnabled();
  });

  /**
   * Whole-branch review, finding 3, second half: three call sites used to
   * fire `void send(...)`, which discarded the promise and turned a genuine
   * IPC rejection into an unhandled one. `send` now catches it itself, so the
   * rejection surfaces as the same inline message a refusal would.
   */
  it('does not produce an unhandled rejection when the bridge call rejects', async () => {
    const onUnhandledRejection = vi.fn();
    process.on('unhandledRejection', onUnhandledRejection);

    const answerAsk = vi.fn().mockRejectedValue(new Error('bridge is gone'));
    seedLedger([ask], { answerAsk });
    render(<AskCard notif={notif} thread="a41" />);

    await userEvent.click(screen.getByRole('button', { name: 'yes' }));
    await screen.findByRole('alert');

    // Give any stray rejection a tick to surface before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onUnhandledRejection).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('bridge is gone');
    process.off('unhandledRejection', onUnhandledRejection);
  });
});

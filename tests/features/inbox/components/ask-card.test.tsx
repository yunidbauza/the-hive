import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AskCard } from '@features/inbox/components/ask-card';

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
});

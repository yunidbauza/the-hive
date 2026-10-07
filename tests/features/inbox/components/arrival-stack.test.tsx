import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { announcement, ArrivalStack, CARD_OUT_MS } from '@features/inbox/components/arrival-stack';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

import { seedLedger } from '@tests/support/ledger';
import { notif, resetNotifIds } from '@tests/support/notifications';

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock('@hooks/use-reduced-motion', () => ({ useReducedMotion: () => motion.reduced }));

const BASE = 1_700_000_000_000;

const askEntry = (id: string) => ({
  id,
  ts: Date.now(),
  from: 'builder',
  to: 'overmind',
  kind: 'ask' as const,
  body: 'Run the ledger tests?',
  meta: { options: ['yes', 'no'] },
});

// a1 oldest, a3 newest: the stack deals newest first.
const askRow = (id: string, at: number) =>
  notif({ id, kind: 'agent.ask', title: `Question ${id}?`, createdAt: BASE + at, action: { type: 'ask', thread: id } });

const blocked = () =>
  notif({ id: 's1', kind: 'session.blocked', createdAt: BASE + 10, action: { type: 'session', entityId: 'nova' } });

/** Close `thread` the way another device's answer does: the ledger gains the answer. */
const answer = (thread: string) =>
  act(() =>
    useHiveStore.getState().hydrateLedger([
      { id: `x-${thread}`, ts: Date.now(), from: 'overmind', to: 'builder', kind: 'answer', body: 'yes', thread },
    ]),
  );

/** The queue holds exactly `rows`: `hydrateNotifs` merges into what the suite seeded. */
const only = (...rows: ReturnType<typeof notif>[]) => useHiveStore.setState({ notifs: rows });

const top = () => screen.getByRole('article').getAttribute('data-notification');

beforeEach(() => {
  motion.reduced = false;
  resetNotifIds();
  useUiStore.getState().reset();
  seedLedger(['a1', 'a2', 'a3', 'a4'].map(askEntry));
  useHiveStore.getState().hydrateNotifs([askRow('a1', 0), askRow('a2', 1), askRow('a3', 2)]);
});

afterEach(() => vi.useRealTimers());

describe('ArrivalStack (HIVE-198, HIVE-228)', () => {
  it('draws nothing while the stack is down, however much waits', () => {
    render(<ArrivalStack onStage={null} />);
    expect(screen.queryByTestId('arrival-stack')).toBeNull();
  });

  it('up, it shows the whole queue newest first: the newest card, two slivers at most', () => {
    useUiStore.getState().toggleStack();
    const { container } = render(<ArrivalStack onStage={null} />);
    expect(top()).toBe('a3');
    expect(container.querySelectorAll('[data-sliver]')).toHaveLength(2);
    expect(screen.queryByText(/arrived just now/)).toBeNull();
  });

  it('one row: the card and no slivers; two rows: one sliver', () => {
    only(askRow('a1', 0));
    useUiStore.getState().pushArrival('a1', false);
    const { container, rerender } = render(<ArrivalStack onStage={null} />);
    expect(container.querySelectorAll('[data-sliver]')).toHaveLength(0);
    act(() => useHiveStore.getState().pushNotif(askRow('a2', 1)));
    rerender(<ArrivalStack onStage={null} />);
    expect(container.querySelectorAll('[data-sliver]')).toHaveLength(1);
  });

  it('the card rises with motion on, and appears in place under reduced motion', () => {
    useUiStore.getState().pushArrival('a3', false);
    const { container, unmount } = render(<ArrivalStack onStage={null} />);
    expect(container.querySelector('.motion-safe\\:animate-ccrise')).not.toBeNull();
    unmount();
    motion.reduced = true;
    const again = render(<ArrivalStack onStage={null} />);
    expect(again.container.querySelector('.motion-safe\\:animate-ccrise')).toBeNull();
  });

  it('never folds on its own', () => {
    vi.useFakeTimers();
    useUiStore.getState().pushArrival('a3', false);
    render(<ArrivalStack onStage={null} />);
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(useUiStore.getState().stackUp).toBe(true);
    expect(top()).toBe('a3');
  });

  it('✕ hides the stack and leaves every row in the queue', () => {
    useUiStore.getState().pushArrival('a3', false);
    render(<ArrivalStack onStage={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fold into the pill' }));
    expect(useUiStore.getState().stackUp).toBe(false);
    expect(screen.queryByTestId('arrival-stack')).toBeNull();
    expect(useHiveStore.getState().notifs).toHaveLength(3);
  });

  it('answering the top card diffuses it out, then the next one rises', () => {
    vi.useFakeTimers();
    useUiStore.getState().pushArrival('a3', false);
    render(<ArrivalStack onStage={null} />);
    answer('a3');
    const leaving = screen.getByTestId('arrival-stack').querySelector('[data-leaving]');
    expect(leaving?.className).toContain('motion-safe:animate-ccdiffuse');
    expect(leaving).toHaveAttribute('inert');
    act(() => vi.advanceTimersByTime(CARD_OUT_MS - 1));
    expect(screen.getByTestId('arrival-stack').querySelector('[data-leaving]')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId('arrival-stack').querySelector('[data-leaving]')).toBeNull();
    expect(top()).toBe('a2');
    expect(screen.getByTestId('arrival-stack').firstElementChild?.className).toContain('motion-safe:animate-ccrise');
  });

  it('a queue change mid-beat does not strand the leaving card', () => {
    vi.useFakeTimers();
    useUiStore.getState().pushArrival('a3', false);
    render(<ArrivalStack onStage={null} />);
    answer('a3');
    act(() => vi.advanceTimersByTime(100));
    act(() => useHiveStore.getState().pushNotif(askRow('a4', 3)));
    act(() => vi.advanceTimersByTime(CARD_OUT_MS));
    expect(screen.getByTestId('arrival-stack').querySelector('[data-leaving]')).toBeNull();
    expect(top()).toBe('a4');
  });

  it('the last card answered: it diffuses out, then the stack is gone', () => {
    vi.useFakeTimers();
    only(askRow('a1', 0));
    useUiStore.getState().pushArrival('a1', false);
    render(<ArrivalStack onStage={null} />);
    answer('a1');
    expect(screen.getByTestId('arrival-stack')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(CARD_OUT_MS));
    expect(screen.queryByTestId('arrival-stack')).toBeNull();
  });

  it('under reduced motion the next card takes the place at once', () => {
    motion.reduced = true;
    useUiStore.getState().pushArrival('a3', false);
    render(<ArrivalStack onStage={null} />);
    answer('a3');
    expect(screen.getByTestId('arrival-stack').querySelector('[data-leaving]')).toBeNull();
    expect(top()).toBe('a2');
  });

  it('a newer ask arriving mid-reply gets a fresh card, not the typed draft of the one before', () => {
    useUiStore.getState().pushArrival('a3', false);
    render(<ArrivalStack onStage={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Other…' }));
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'for a3 only' } });
    act(() => {
      useHiveStore.getState().pushNotif(askRow('a4', 3));
      useUiStore.getState().pushArrival('a4', false);
    });
    expect(top()).toBe('a4');
    expect(screen.queryByLabelText('Your answer')).toBeNull();
  });

  it('a session off stage: a note, whose Later hides the stack', () => {
    useHiveStore.getState().hydrateNotifs([blocked()]);
    useUiStore.getState().pushArrival('s1', false);
    render(<ArrivalStack onStage={null} />);
    expect(screen.getByRole('button', { name: 'Open the session' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(useUiStore.getState().stackUp).toBe(false);
  });

  it('a review request: the plain notification card', () => {
    only(notif({ id: 'r1', kind: 'pr.review_requested', title: 'Review #12', action: { type: 'none' } }));
    useUiStore.getState().pushArrival('r1', false);
    render(<ArrivalStack onStage={null} />);
    expect(screen.getByText('Review #12')).toBeInTheDocument();
  });

  it('never the session on stage', () => {
    only(blocked());
    useUiStore.getState().pushArrival('s1', false);
    render(<ArrivalStack onStage="nova" />);
    expect(screen.queryByTestId('arrival-stack')).toBeNull();
  });

  it('holds while Settings is open, and rises when it closes', () => {
    useUiStore.getState().pushArrival('a3', false);
    useUiStore.getState().openSettings();
    render(<ArrivalStack onStage={null} />);
    expect(screen.queryByRole('article')).toBeNull();
    act(() => useUiStore.getState().closeSettings());
    expect(screen.getByRole('article')).toBeInTheDocument();
  });

  it('an arrival never moves focus', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    render(<ArrivalStack onStage={null} />);
    act(() => useUiStore.getState().pushArrival('a3', false));
    expect(screen.getByRole('article')).toBeInTheDocument();
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it('announcement reads as the ticket words it', () => {
    expect(announcement(notif({ kind: 'agent.permission', title: 'Run the ledger tests?' }), 'builder')).toBe(
      'builder wants to run a command: Run the ledger tests?',
    );
    expect(announcement(notif({ kind: 'agent.ask', title: 'Which repo?' }), 'pr-patrol')).toBe(
      'pr-patrol asks: Which repo?',
    );
    expect(announcement(notif({ kind: 'session.blocked', title: 'asked a question' }), 'inbox-redesign')).toBe(
      'inbox-redesign asked a question',
    );
    expect(announcement(notif({ kind: 'session.idle', title: 'is yours again' }), 'inbox-redesign')).toBe(
      'inbox-redesign is yours again',
    );
  });
});

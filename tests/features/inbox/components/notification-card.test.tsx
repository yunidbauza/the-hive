import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CARD_EXIT_MS,
  NotificationCard,
} from '@features/inbox/components/notification-card';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

import { seedDemoFleet } from '@tests/support/demo-fleet';
import { seedLedger } from '@tests/support/ledger';

import { notif, resetNotifIds } from '../../../support/notifications';

/**
 * The exit path branches on the motion preference, so the hook is mocked rather
 * than the media query — `matchMedia` in jsdom would have to be stubbed per test
 * anyway, and the branch under test is "what did the component decide", not "how
 * did it read the preference".
 */
const reducedMotion = vi.hoisted(() => vi.fn(() => false));
vi.mock('@hooks/use-reduced-motion', () => ({
  useReducedMotion: reducedMotion,
}));

beforeEach(() => {
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
  resetNotifIds();
  reducedMotion.mockReturnValue(false);
});

afterEach(() => {
  /**
   * Unmount **before** the timers are swapped back, and do it here rather than
   * leaving it to auto-cleanup.
   *
   * The card holds a live `setTimeout` for its exit animation, and Testing
   * Library's automatic cleanup runs in its own `afterEach` — registered by the
   * setup file, so it runs *after* this one. Restoring real timers first left the
   * card's unmount calling `clearTimeout` on a **fake** handle against Node's real
   * timer list, which surfaces later as an uncaught
   * `TypeError: timer._onTimeout is not a function` from `listOnTimeout` — in
   * whichever unrelated test happened to be running when Node next swept its
   * timers.
   *
   * `cleanup()` is idempotent, so the automatic pass afterwards is a no-op.
   */
  cleanup();
  vi.useRealTimers();
});

describe('NotificationCard', () => {
  it('renders the title, the body, and a derived time', () => {
    render(<NotificationCard notif={notif({ createdAt: Date.now() })} />);

    expect(screen.getByText('lead-form needs approval')).toBeInTheDocument();
    expect(
      screen.getByText('prisma migrate dev — lead_phone_idx'),
    ).toBeInTheDocument();
    // Derived from `createdAt`, not carried on the record.
    expect(screen.getByText('now')).toBeInTheDocument();
  });

  /** An empty body renders nothing rather than an empty line. */
  it('omits the body when there is none', () => {
    render(<NotificationCard notif={notif({ body: '' })} />);

    expect(screen.getByText('lead-form needs approval')).toBeInTheDocument();
    expect(screen.queryByText('prisma migrate dev — lead_phone_idx')).toBeNull();
  });

  /**
   * The glyph and its colour come from the kind's registry entry. Nothing on
   * the record says `amber`, and that is the point.
   */
  it('takes its tone from the kind, not from the record', () => {
    const { rerender } = render(
      <NotificationCard notif={notif({ kind: 'session.blocked' })} />,
    );
    expect(document.querySelector('.text-amber')).not.toBeNull();

    rerender(<NotificationCard notif={notif({ kind: 'pr.merged' })} />);
    expect(document.querySelector('.text-green')).not.toBeNull();
  });

  /** Unread is a chip fill plus a stronger border; read is transparent. */
  it('fills an unread card and flattens a read one', () => {
    const { rerender } = render(<NotificationCard notif={notif()} />);
    expect(screen.getByRole('button')).toHaveClass('bg-chip');

    rerender(<NotificationCard notif={notif({ unread: false })} />);
    expect(screen.getByRole('button')).not.toHaveClass('bg-chip');
  });

  /**
   * An acted-on card leaves the list (HIVE-93).
   *
   * It used to mark itself read and stay. Read-and-kept is right for something
   * you glance at and wrong for something you act on: the click already navigated
   * the user somewhere, so the row has spent its purpose, and keeping it makes the
   * inbox a log to prune by hand.
   *
   * Fake timers because the removal is scheduled behind the exit animation —
   * `CARD_EXIT_MS` is the component's own constant, so this cannot drift from the
   * duration it actually waits.
   */
  it('opens the session it names and then removes only this card', async () => {
    /*
      `shouldAdvanceTime` so `userEvent`'s own awaits still resolve — a plain
      `useFakeTimers()` freezes the clock its internal delays wait on, and the
      click never completes.
    */
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const first = notif({ id: 'a' });
    const second = notif({ id: 'b' });
    useHiveStore.getState().hydrateNotifs([first, second]);

    render(<NotificationCard notif={first} />);
    await user.click(screen.getByRole('button'));

    // Navigation is immediate; the row's removal waits for the animation.
    expect(useUiStore.getState().activeTab).toBe('lead-form');
    expect(useHiveStore.getState().notifs.map((n) => n.id)).toEqual(['a', 'b']);

    await act(async () => {
      vi.advanceTimersByTime(CARD_EXIT_MS);
    });

    expect(useHiveStore.getState().notifs.map((n) => n.id)).toEqual(['b']);
  });

  /**
   * The regression the id migration exists to prevent.
   *
   * A notification landing between render and click used to shift every row
   * down one, so the click dismissed the row above the one the user aimed at.
   */
  it('removes the card that was clicked even when the list changed underneath', async () => {
    /*
      `shouldAdvanceTime` so `userEvent`'s own awaits still resolve — a plain
      `useFakeTimers()` freezes the clock its internal delays wait on, and the
      click never completes.
    */
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const target = notif({ id: 'target' });
    useHiveStore.getState().hydrateNotifs([target]);

    render(<NotificationCard notif={target} />);

    // Something arrives and takes position zero.
    useHiveStore.getState().pushNotif(notif({ id: 'newcomer' }));
    await user.click(screen.getByRole('button'));
    await act(async () => {
      vi.advanceTimersByTime(CARD_EXIT_MS);
    });

    expect(useHiveStore.getState().notifs.map((n) => n.id)).toEqual(['newcomer']);
  });

  /**
   * A clone has nowhere to go, and is still dismissed.
   *
   * Nothing was navigated to, but the click is the user dealing with it — and now
   * that the header bell no longer marks everything read, refusing to dismiss
   * would leave no way to clear such a row at all.
   */
  it('removes a card whose action has no destination, without navigating', async () => {
    /*
      `shouldAdvanceTime` so `userEvent`'s own awaits still resolve — a plain
      `useFakeTimers()` freezes the clock its internal delays wait on, and the
      click never completes.
    */
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const entry = notif({ id: 'c', kind: 'clone.done', action: { type: 'none' } });
    useHiveStore.getState().hydrateNotifs([entry]);

    render(<NotificationCard notif={entry} />);
    await user.click(screen.getByRole('button'));
    await act(async () => {
      vi.advanceTimersByTime(CARD_EXIT_MS);
    });

    expect(useUiStore.getState().activeTab).toBe('orch');
    expect(useHiveStore.getState().notifs).toEqual([]);
  });

  /**
   * The exit animation is wired, and hands the keyframes a **measured** height.
   *
   * jsdom runs no animations, so this pins the wiring rather than the result:
   * the class that carries `--animate-ccslideout`, and the inline
   * `--cc-card-h` the keyframes collapse from. `max-height` cannot animate from
   * `auto`, and a hard-coded start value would either clip a two-line body or
   * collapse a taller card from a height it never had.
   *
   * The visual result itself is not asserted anywhere: producing a real
   * notification needs a real hub event, which the e2e suite has no way to raise.
   */
  it('arms the slide-out with the card’s own height', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    useHiveStore.getState().hydrateNotifs([notif({ id: 'a' })]);

    render(<NotificationCard notif={notif({ id: 'a' })} />);
    const card = screen.getByRole('button');
    await user.click(card);

    expect(card).toHaveClass('animate-ccslideout');
    // Also inert while it leaves, so a second click cannot act twice.
    expect(card).toHaveClass('pointer-events-none');
    expect(card.style.getPropertyValue('--cc-card-h')).toMatch(/^\d+px$/);
  });

  /**
   * Under `prefers-reduced-motion` the row goes at once (HIVE-93).
   *
   * `global.css` already collapses animation durations under the query, so the
   * slide would not play — but the timer would still hold the row on screen for
   * 220ms with nothing happening, which reads as lag rather than as restraint.
   */
  it('removes the card immediately when motion is reduced', async () => {
    reducedMotion.mockReturnValue(true);
    const user = userEvent.setup();
    useHiveStore.getState().hydrateNotifs([notif({ id: 'a' })]);

    render(<NotificationCard notif={notif({ id: 'a' })} />);
    await user.click(screen.getByRole('button'));

    // No timer advance anywhere in this test.
    expect(useHiveStore.getState().notifs).toEqual([]);
  });

  /** The count is what the badges read; an unread card must say so out loud. */
  it('announces its unread state', () => {
    render(<NotificationCard notif={notif()} />);
    expect(screen.getByText('unread')).toBeInTheDocument();
  });

  it('says nothing extra once read', () => {
    render(<NotificationCard notif={notif({ unread: false })} />);
    expect(screen.queryByText('unread')).toBeNull();
  });

  describe('opening the session it is about', () => {
    beforeEach(() => {
      seedDemoFleet();
    });

    it('opens the session', async () => {
      const user = userEvent.setup();
      render(
        <NotificationCard
          notif={notif({ action: { type: 'session', entityId: 'hero-refresh' } })}
        />,
      );

      await user.click(screen.getByRole('button'));

      expect(useUiStore.getState().activeTab).toBe('hero-refresh');
    });

    it('follows the terminal to its live row after a /clear', async () => {
      /**
       * The reported bug. Notifications come from hooks, and hooks speak
       * *terminal* ids — baked into a pty's environment and never changed. A
       * `/clear` in between retires the row that id pointed at, and
       * `openEntity` refuses an ended session by design, dropping the user on
       * the orchestrator instead of the session the notification was about.
       *
       * The desktop toast (`use-notification-activate`) resolved this all
       * along; this row did not, so one notification meant two different things
       * depending on where it was clicked.
       */
      const user = userEvent.setup();
      const successor = useHiveStore.getState().clearSession('hero-refresh')!;

      render(
        <NotificationCard
          notif={notif({ action: { type: 'session', entityId: 'hero-refresh' } })}
        />,
      );

      await user.click(screen.getByRole('button'));

      // The successor, not the retired row — and emphatically not the fleet view.
      expect(useUiStore.getState().activeTab).toBe(successor);
      expect(useUiStore.getState().activeTab).not.toBe('hero-refresh');
    });
  });

  /**
   * The structural fact Step 3 exists for: an ask cannot be a branch inside
   * the button, so an `ask` action forks the whole render onto `AskCard`
   * (HIVE-118).
   */
  describe('dispatching an ask instead of drawing the button row', () => {
    it('renders an AskCard for an ask action instead of the button row', () => {
      seedLedger([
        {
          id: 'a41',
          ts: Date.now(),
          from: 'drone',
          to: 'overmind',
          kind: 'ask',
          body: 'ship it?',
        },
      ]);

      render(
        <NotificationCard
          notif={notif({
            title: 'ship it?',
            action: { type: 'ask', thread: 'a41' },
          })}
        />,
      );

      // No button anywhere named after the ask — the old button row is gone,
      // not merely relabelled.
      expect(
        screen.queryByRole('button', { name: /ship it/ }),
      ).not.toBeInTheDocument();
      // `AskCard` renders an `<article>`, never a `<button>` (see its own
      // doc comment on why the two cannot share a role).
      expect(screen.getByRole('article')).toBeInTheDocument();
    });
  });

  /**
   * An agent's entity id *is* its name (`hive-store.ts`'s
   * `entities[summary.name]`), so opening one from the row is a direct
   * `openEntity` call — never `currentRowFor`, which exists to translate a
   * *terminal* id and has nothing to translate here (HIVE-118).
   */
  describe('opening the agent it is about', () => {
    it('opens the agent for an agent action, without going through currentRowFor', async () => {
      const openEntity = vi.fn();
      // The same direct-`setState` idiom `seedLedger` uses for `answerAsk`:
      // this is the last test in the file to touch `openEntity`, so nothing
      // downstream depends on `reset()` having restored the real action.
      useHiveStore.setState({ openEntity });
      const user = userEvent.setup();

      render(
        <NotificationCard
          notif={notif({ action: { type: 'agent', name: 'drone' } })}
        />,
      );

      await user.click(screen.getByRole('button'));

      expect(openEntity).toHaveBeenCalledWith('drone');
    });
  });
});

/**
 * What the row calls the session it is about (HIVE-110).
 *
 * The bug these close: main used to compose `` `${name} ${predicate}` `` when it
 * raised the row, from its own map of *raw terminal titles*. Since HIVE-108 a
 * session opens unnamed and titles itself several turns in, so a row raised in
 * between said `sess-11` for ever — the rail showed a name, the inbox did not,
 * about the same session.
 *
 * The row carries the terminal id now and resolves the name on every render, so
 * these assert the two things a frozen string could never do: follow a rename
 * that lands *after* the row, and follow a `/clear` to the successor the click
 * already went to.
 */
describe('naming the session a row is about', () => {
  beforeEach(() => {
    seedDemoFleet();
  });

  const idle = (subject: string) =>
    notif({
      kind: 'session.idle',
      title: 'is yours again',
      subject,
      body: '',
      action: { type: 'session', entityId: subject },
    });

  it('renders the session’s current name in front of the predicate', () => {
    act(() => {
      useHiveStore.getState().renameSession('lead-form', 'Mutex explanation');
    });

    render(<NotificationCard notif={idle('lead-form')} />);

    expect(
      screen.getByText('mutex-explanation is yours again'),
    ).toBeInTheDocument();
  });

  /** The case the whole change exists for. */
  it('follows a rename that lands after the row did', () => {
    render(<NotificationCard notif={idle('lead-form')} />);

    expect(screen.getByText('lead-form is yours again')).toBeInTheDocument();

    act(() => {
      useHiveStore.getState().renameSession('lead-form', 'Mutex explanation');
    });

    expect(
      screen.getByText('mutex-explanation is yours again'),
    ).toBeInTheDocument();
    expect(screen.queryByText('lead-form is yours again')).not.toBeInTheDocument();
  });

  /*
    HIVE-108: a session opens unnamed, and the rail shows its id until Claude
    titles it. The row shows the same thing rather than inventing a word for it.
  */
  it('falls back to the id, exactly as the rail does', () => {
    render(<NotificationCard notif={idle('lead-form')} />);

    expect(screen.getByText('lead-form is yours again')).toBeInTheDocument();
  });

  /*
    A terminal whose row was retired by a `/clear` belongs to the successor now.
    The click already goes there (see the test above); the words have to agree,
    or the row names one session and opens another.
  */
  it('names the successor after a /clear, as the click already does', () => {
    const successor = useHiveStore.getState().clearSession('lead-form')!;
    act(() => {
      useHiveStore.getState().renameSession(successor, 'Mutex explanation');
    });

    render(<NotificationCard notif={idle('lead-form')} />);

    expect(
      screen.getByText('mutex-explanation is yours again'),
    ).toBeInTheDocument();
  });

  /* A row about no session at all keeps its title verbatim. */
  it('leaves a row with no subject exactly as it was raised', () => {
    render(
      <NotificationCard
        notif={notif({
          kind: 'clone.done',
          title: 'Clone finished',
          body: '',
          action: { type: 'none' },
        })}
      />,
    );

    expect(screen.getByText('Clone finished')).toBeInTheDocument();
  });

  /**
   * HIVE-123: a `done` card can carry a validated Slack permalink. Main
   * builds `link` — `notify.ts`'s producer tests cover the validation itself
   * — so the card's own job is only to draw what it was handed, and to keep
   * a click on it from also dismissing the row.
   */
  describe('a card carrying a link', () => {
    it('renders the fixed label as a real link to the given href', () => {
      render(
        <NotificationCard
          notif={notif({
            kind: 'agent.done',
            action: { type: 'agent', name: 'slack-watcher' },
            link: {
              href: 'https://behiques.slack.com/archives/C1/p123',
              label: 'Open in Slack',
            },
          })}
        />,
      );

      const link = screen.getByRole('link', { name: 'Open in Slack' });
      expect(link).toHaveAttribute(
        'href',
        'https://behiques.slack.com/archives/C1/p123',
      );
    });

    it('renders no link at all when the notification carries none', () => {
      render(<NotificationCard notif={notif({ kind: 'agent.done' })} />);

      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });

    /**
     * The card is a `<button>` that dismisses itself on click. The link sits
     * beside it, not inside it — an anchor nested in a button is invalid
     * HTML — so a click on the link must not also fire the button's own
     * `onClick` and slide the card away underneath it.
     */
    it('does not dismiss the card when the link itself is clicked', async () => {
      const user = userEvent.setup();
      useHiveStore.getState().hydrateNotifs([
        notif({
          id: 'a',
          kind: 'agent.done',
          action: { type: 'agent', name: 'slack-watcher' },
          link: {
            href: 'https://behiques.slack.com/archives/C1/p123',
            label: 'Open in Slack',
          },
        }),
      ]);

      render(
        <NotificationCard
          notif={notif({
            id: 'a',
            kind: 'agent.done',
            action: { type: 'agent', name: 'slack-watcher' },
            link: {
              href: 'https://behiques.slack.com/archives/C1/p123',
              label: 'Open in Slack',
            },
          })}
        />,
      );

      await user.click(screen.getByRole('link', { name: 'Open in Slack' }));

      // The button row is still here, unanimated — the click on the link
      // never reached it.
      expect(screen.getByRole('button')).not.toHaveClass('animate-ccslideout');
    });

    /**
     * The exit belongs to the **root**, and with a link the root is the wrapper
     * (HIVE-123 self-review).
     *
     * It shipped on the button: the anchor below it and the wrapper's own list
     * margin stayed at full height while the button collapsed, so the card came
     * apart on its way out and the list jumped when what was left unmounted.
     * The measured `--cc-card-h` has to come off the same element, or the
     * keyframes collapse from a height the row never had.
     */
    it('collapses the wrapper, link and margin included, rather than the button alone', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const linked = notif({
        id: 'a',
        kind: 'agent.done',
        action: { type: 'agent', name: 'slack-watcher' },
        link: {
          href: 'https://behiques.slack.com/archives/C1/p123',
          label: 'Open in Slack',
        },
      });
      useHiveStore.getState().hydrateNotifs([linked]);

      render(<NotificationCard notif={linked} />);

      const button = screen.getByRole('button');
      const wrapper = button.parentElement;

      expect(wrapper).not.toBeNull();
      // The margin is the wrapper's, so the gap goes with the row.
      expect(wrapper).toHaveClass('mb-[var(--cc-list-gap-sm)]');
      expect(button).not.toHaveClass('mb-[var(--cc-list-gap-sm)]');

      await user.click(button);

      expect(wrapper).toHaveClass('animate-ccslideout');
      expect(wrapper).toHaveClass('overflow-hidden');
      expect(wrapper).toHaveClass('pointer-events-none');
      expect(button).not.toHaveClass('animate-ccslideout');
      expect(wrapper?.style.getPropertyValue('--cc-card-h')).toMatch(/^\d+px$/);
    });

    /** …while a card with no link is still its own root, exactly as before. */
    it('keeps the exit on the button when there is no link', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      useHiveStore.getState().hydrateNotifs([notif({ id: 'a' })]);

      render(<NotificationCard notif={notif({ id: 'a' })} />);

      const button = screen.getByRole('button');
      await user.click(button);

      expect(button).toHaveClass('animate-ccslideout');
      expect(button).toHaveClass('mb-[var(--cc-list-gap-sm)]');
      expect(button.style.getPropertyValue('--cc-card-h')).toMatch(/^\d+px$/);
    });
  });
});

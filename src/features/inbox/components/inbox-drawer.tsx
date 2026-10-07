import { X } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';

import { useLeavingAsks } from '@features/inbox/hooks/use-leaving-asks';
import { useDismissNotif, useEchoes, useSummons } from '@stores/hive-store';
import { NEWS_SECTION, useInboxActions, useInboxDrawer } from '@stores/ui-store';

import { AskCard } from './ask-card';
import { AskLeaving } from './ask-leaving';
import { NotificationCard } from './notification-card';
import { SessionNote } from './session-note';

interface InboxDrawerProps {
  /** The terminal on this window's stage, left out of the sessions. */
  onStage: string | null;
}

const plural = (n: number, one: string): string => `${String(n)} ${one}${n === 1 ? '' : 's'}`;

/**
 * Everything that needs you, whole (HIVE-198): every ask as an answerable
 * card, then the sessions off stage, then the news under New (HIVE-231). A 400px panel at the window's right edge
 * with no veil, so the stage stays readable beside it.
 *
 * Focus moves in because the user asked for it (the pill, the bell, a toast),
 * onto the card for `thread` when one was named, and goes back where it was
 * on close. Emptied by answering, it says so and stays until closed.
 *
 * It runs the window's full height, over the title bar's drag strip (macOS):
 * `no-drag` hands that strip back to the drawer, or its header, the close
 * button with it, would move the window instead of taking the click.
 */
export function InboxDrawer({ onStage }: InboxDrawerProps) {
  const { open, thread } = useInboxDrawer();
  const { closeInboxDrawer } = useInboxActions();
  const { asks, sessions } = useSummons(onStage);
  const echoes = useEchoes();
  const dismiss = useDismissNotif();
  // A closed ask keeps its place for one beat with its reason (HIVE-218); the count stays on live rows.
  const placed = useLeavingAsks(asks);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const card =
      thread === null ? null : ref.current?.querySelector<HTMLElement>(`[data-thread="${CSS.escape(thread)}"]`);
    const target = card ?? ref.current;
    target?.scrollIntoView?.({ block: 'nearest' });
    target?.focus();
    return () => before?.focus();
  }, [open, thread]);

  /*
    Esc closes, from anywhere inside. A listener on the element rather than an
    `onKeyDown` prop: the aside is a dialog region, not a control.
  */
  useEffect(() => {
    const drawer = ref.current;
    if (!open || drawer === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeInboxDrawer();
    };
    drawer.addEventListener('keydown', onKey);
    return () => drawer.removeEventListener('keydown', onKey);
  }, [open, closeInboxDrawer]);

  if (!open) return null;

  return (
    <aside
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-label="Needs you"
      tabIndex={-1}
      className="fixed inset-y-0 right-0 z-40 flex w-[400px] flex-col gap-2.5 overflow-y-auto border-l border-border bg-panel px-3.5 py-3 shadow-drawer outline-none [-webkit-app-region:no-drag]"
    >
      <div className="flex items-baseline gap-2.5 px-0.5 pb-1.5 text-control">
        <b className="text-ui-lg text-ink">Needs you</b>
        <span className="text-muted">{`${plural(asks.length, 'ask')} · ${plural(sessions.length, 'session')}`}</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Close the inbox"
          onClick={closeInboxDrawer}
          className="grid size-7 place-items-center self-center rounded-full text-muted hover:bg-hover"
        >
          <X size={14} />
        </button>
      </div>
      {asks.length + sessions.length === 0 ? (
        <p className="px-0.5 text-control text-muted">Nothing waits on you.</p>
      ) : null}
      {placed.map(({ row, leaving }) => (
        <div
          key={row.id}
          data-thread={row.action.type === 'ask' ? row.action.thread : undefined}
          tabIndex={-1}
          className="outline-none"
        >
          {row.action.type !== 'ask' ? (
            <NotificationCard notif={row} />
          ) : leaving ? (
            <AskLeaving notif={row} thread={row.action.thread} />
          ) : (
            <AskCard notif={row} thread={row.action.thread} openLink />
          )}
        </div>
      ))}
      {sessions.length > 0 ? (
        <>
          <div className="flex gap-1.5 px-2 pt-3.5 pb-1 text-micro font-semibold tracking-[.06em] text-subtle uppercase">
            <span>Sessions off stage</span>
            <span className="tabular-nums tracking-normal">{sessions.length}</span>
          </div>
          {sessions.map((row) => (
            <SessionNote key={row.id} notif={row} variant="row" />
          ))}
        </>
      ) : null}
      {echoes.length > 0 ? (
        <section
          aria-label="New"
          data-thread={NEWS_SECTION}
          tabIndex={-1}
          className="flex flex-col gap-2.5 outline-none"
        >
          <div className="flex items-baseline gap-1.5 px-2 pt-3.5 pb-1 text-micro font-semibold tracking-[.06em] text-subtle uppercase">
            <span>New</span>
            <span className="tabular-nums tracking-normal">{echoes.length}</span>
            <span className="flex-1" />
            <button
              type="button"
              aria-label="Clear the news"
              // One dismiss per row, never `clearNotifs`: that empties what waits on you too.
              onClick={() => echoes.forEach((row) => dismiss(row.id))}
              className="tracking-normal normal-case text-brand hover:underline"
            >
              Clear
            </button>
          </div>
          {echoes.map((row) => (
            <NotificationCard key={row.id} notif={row} />
          ))}
        </section>
      ) : null}
    </aside>
  );
}

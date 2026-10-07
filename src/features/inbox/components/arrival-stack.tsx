import { useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import type { HiveNotification } from '@/types/notification';

import { useReducedMotion } from '@hooks/use-reduced-motion';
import { isSessionSummons } from '@shared/notification-lanes';
import { useSummons } from '@stores/hive-store';
import { useInboxActions, useSettingsOpen, useStackUp } from '@stores/ui-store';

import { AskCard } from './ask-card';
import { NotificationCard } from './notification-card';
import { SessionNote } from './session-note';

/** How long an answered card takes to diffuse out before the next one rises (HIVE-228). */
export const CARD_OUT_MS = 280;

/** What the corner's polite live region says for the newest arrival. */
export const announcement = (row: HiveNotification, asker: string): string =>
  isSessionSummons(row)
    ? `${asker} ${row.title}`
    : `${asker} ${row.kind === 'agent.permission' ? 'wants to run a command' : 'asks'}: ${row.title}`;

/**
 * Everything that needs you, as the stack deals it: asks and sessions off stage
 * together, newest first (HIVE-228). The top card is the newest, so an arrival
 * that raises the stack is the card it shows.
 */
export function useStackCards(onStage: string | null): HiveNotification[] {
  const { asks, sessions } = useSummons(onStage);
  return useMemo(() => [...asks, ...sessions].sort((a, b) => b.createdAt - a.createdAt), [asks, sessions]);
}

/**
 * The card that was on top until it left the queue (answered, expired, opened), held for
 * {@link CARD_OUT_MS} so it can diffuse out. A card hidden by ✕ never leaves the queue, so
 * it never comes back through here. Nothing is held under reduced motion.
 */
function useOutgoing(cards: readonly HiveNotification[], reduced: boolean): HiveNotification | null {
  const [out, setOut] = useState<HiveNotification | null>(null);
  const top = useRef(cards[0]);
  // Held across renders, not per effect run: a queue change mid-beat must not strand `out`.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const was = top.current;
    top.current = cards[0];
    if (reduced || was === undefined || cards.some((row) => row.id === was.id)) return;
    clearTimeout(timer.current);
    setOut(was);
    timer.current = setTimeout(() => setOut(null), CARD_OUT_MS);
  }, [cards, reduced]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return out;
}

function Card({ row, onHide }: { row: HiveNotification; onHide: () => void }) {
  if (isSessionSummons(row)) return <SessionNote notif={row} variant="note" onFold={onHide} />;
  if (row.action.type === 'ask') return <AskCard notif={row} thread={row.action.thread} onClose={onHide} />;
  return <NotificationCard notif={row} />;
}

interface ArrivalStackProps {
  /** The terminal on this window's stage, never drawn. */
  onStage: string | null;
}

/**
 * The queue over the pill (HIVE-198, HIVE-228): the newest as an answerable card,
 * or a note for a session off stage, with up to two slivers under it for the
 * rest. It never takes focus, and it never folds on a timer.
 *
 * Up while `stackUp` holds: an arrival or the pill raises it, ✕ or the drawer
 * takes it down, and the rows stay in the queue either way. Answering the top
 * card resolves it: it diffuses out and the next rises in its place.
 *
 * Not drawn while Settings is open: it rises again when Settings closes.
 */
export function ArrivalStack({ onStage }: ArrivalStackProps) {
  const cards = useStackCards(onStage);
  const stackUp = useStackUp();
  const settings = useSettingsOpen();
  const { hideStack } = useInboxActions();
  const reduced = useReducedMotion();
  const out = useOutgoing(cards, reduced);

  const shown = out ?? cards[0];
  if (!stackUp || settings || shown === undefined) return null;

  const under = Math.max(0, Math.min(out === null ? cards.length - 1 : cards.length, 2));

  return (
    <div data-testid="arrival-stack" className="relative w-[380px] max-w-full">
      <div
        // Keyed by the card shown, so the next one rises fresh, and a newer ask never inherits a draft.
        key={shown.id}
        data-leaving={out === null ? undefined : true}
        inert={out !== null}
        className={cn(
          'relative z-[2] rounded-xl shadow-xl [&>article]:border-amber-edge',
          !reduced && (out === null ? 'motion-safe:animate-ccrise' : 'motion-safe:animate-ccdiffuse'),
        )}
      >
        <Card row={shown} onHide={hideStack} />
      </div>
      {under >= 1 ? (
        <span
          data-sliver
          aria-hidden
          className="absolute inset-x-3 -bottom-[7px] z-[1] h-3 rounded-b-xl border border-t-0 border-border bg-panel-2"
        />
      ) : null}
      {under >= 2 ? (
        <span
          data-sliver
          aria-hidden
          className="absolute inset-x-6 -bottom-[13px] z-0 h-3 rounded-b-xl border border-t-0 border-border bg-panel-2 opacity-70"
        />
      ) : null}
    </div>
  );
}

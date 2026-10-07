import { useEffect, useMemo, useState } from 'react';

import { cn } from '@/lib/utils';
import type { HiveNotification } from '@/types/notification';

import { useReducedMotion } from '@hooks/use-reduced-motion';
import { isSessionSummons } from '@shared/notification-lanes';
import { rises, useEchoes, useSummons } from '@stores/hive-store';
import { useInboxActions, useSettingsOpen, useStackUp } from '@stores/ui-store';

import { AskCard } from './ask-card';
import { NotificationCard } from './notification-card';
import { SessionNote } from './session-note';

/** How long an answered card takes to diffuse out before the next one rises (HIVE-228). */
export const CARD_OUT_MS = 280;

/**
 * What the corner's polite live region says for the newest arrival. A card
 * nobody asked (an update ready, a review request) reads its own words: there
 * is no asker to name (HIVE-231).
 */
export const announcement = (row: HiveNotification, asker: string): string => {
  if (isSessionSummons(row)) return `${asker} ${row.title}`;
  if (row.action.type !== 'ask') return row.body === '' ? row.title : `${row.title}. ${row.body}`;
  return `${asker} ${row.kind === 'agent.permission' ? 'wants to run a command' : 'asks'}: ${row.title}`;
};

/**
 * Everything that needs you, as the stack deals it: asks and sessions off stage
 * together, newest first (HIVE-228), and an update ready to install, the one
 * piece of news that rises (HIVE-231). The top card is the newest, so an arrival
 * that raises the stack is the card it shows.
 */
export function useStackCards(onStage: string | null): HiveNotification[] {
  const { asks, sessions } = useSummons(onStage);
  const echoes = useEchoes();
  return useMemo(
    () => [...asks, ...sessions, ...echoes.filter(rises)].sort((a, b) => b.createdAt - a.createdAt),
    [asks, sessions, echoes],
  );
}

/**
 * The card that was on top until it left the queue (answered, expired, opened), held for
 * {@link CARD_OUT_MS} so it can diffuse out. A card hidden by ✕ never leaves the queue, so
 * it never comes back through here. Nothing is held under reduced motion.
 *
 * Derived while rendering, not in an effect: an effect runs after the commit, so the next
 * card would be put in the DOM for a frame before the leaving one swapped back over it.
 */
function useOutgoing(cards: readonly HiveNotification[], reduced: boolean): HiveNotification | null {
  const [out, setOut] = useState<HiveNotification | null>(null);
  const [lastTop, setLastTop] = useState(cards[0]);
  const top = cards[0];
  if (top?.id !== lastTop?.id) {
    setLastTop(top);
    if (!reduced && lastTop !== undefined && !cards.some((row) => row.id === lastTop.id)) setOut(lastTop);
  }

  // Keyed on the leaving card alone, so a queue change mid-beat never restarts or strands it.
  useEffect(() => {
    if (out === null) return;
    const timer = setTimeout(() => setOut(null), CARD_OUT_MS);
    return () => clearTimeout(timer);
  }, [out]);

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
 * card resolves it: it diffuses out and the next rises in its place. Answering
 * the last one lowers it, so a quiet arrival after that only pulses the pill.
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

  // An emptied queue lowers the stack, so the next quiet arrival pulses the pill instead of drawing it.
  const emptied = stackUp && cards.length === 0 && out === null;
  useEffect(() => {
    if (emptied) hideStack();
  }, [emptied, hideStack]);

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

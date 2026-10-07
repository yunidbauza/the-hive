import { Bell } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';

import { useReducedMotion } from '@hooks/use-reduced-motion';
import { useSummons } from '@stores/hive-store';
import { useArrivalPulse, useInboxActions, useInboxDrawer, useSettingsOpen, useStackUp } from '@stores/ui-store';

interface InboxPillProps {
  /** The terminal on this window's stage, left out of the count. */
  onStage: string | null;
}

/**
 * What needs you, as a count in the stage's corner (HIVE-198). Nothing
 * waiting draws nothing; the drawer open hides it, since the drawer is the
 * same queue whole.
 *
 * Two halves past one row (HIVE-228): the count shows or hides the stack over
 * it, and `Open all` opens the drawer. With one row there is nothing to open
 * that the stack does not already show.
 *
 * A quiet arrival (the keyboard was in a terminal) never rises as a card; the
 * pill pulses once for it instead, and only when the row is one it counts, so
 * the session you are typing into never pulses it.
 */
export function InboxPill({ onStage }: InboxPillProps) {
  const { asks, sessions } = useSummons(onStage);
  const pulse = useArrivalPulse();
  const { open } = useInboxDrawer();
  const stackUp = useStackUp();
  const settings = useSettingsOpen();
  const { openInboxDrawer, toggleStack } = useInboxActions();
  const reduced = useReducedMotion();

  const count = asks.length + sessions.length;
  if (count === 0 || open) return null;

  const counted = pulse !== null && [...asks, ...sessions].some((row) => row.id === pulse);
  const needs = count === 1 ? 'needs' : 'need';

  return (
    <div
      // Keyed by the pulsing id, so each quiet arrival plays the pulse once.
      key={counted ? pulse : 'still'}
      className={cn(
        'flex items-stretch overflow-hidden rounded-full border border-amber-edge bg-panel-2 text-control text-muted shadow-lg',
        counted && !reduced && 'motion-safe:animate-ccpulse motion-safe:[animation-iteration-count:1]',
      )}
    >
      <button
        type="button"
        // The exact number, singular-aware, even when the face says 99+ (HIVE-211).
        aria-label={`Inbox, ${String(count)} ${needs} you`}
        aria-expanded={stackUp && !settings}
        onClick={toggleStack}
        className="flex items-center gap-[7px] py-1.5 pr-3 pl-2.5 hover:bg-hover aria-expanded:bg-amber-soft aria-expanded:text-ink"
      >
        <Bell size={14} className="text-amber-text" aria-hidden />
        <b className="tabular-nums font-semibold text-amber-text">{count > 99 ? '99+' : count}</b>
        <span>{`${needs} you`}</span>
      </button>
      {count > 1 ? (
        <>
          <span aria-hidden className="my-1.5 w-px bg-amber-edge" />
          <button type="button" onClick={() => openInboxDrawer()} className="px-3 py-1.5 text-brand hover:bg-hover">
            Open all
          </button>
        </>
      ) : null}
    </div>
  );
}

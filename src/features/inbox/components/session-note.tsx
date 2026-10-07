import { CaretRight, X } from '@phosphor-icons/react';

import { isSession } from '@/types/entity';
import type { HiveNotification } from '@/types/notification';

import { Button } from '@components/ui/button';
import { useCurrentRow, useDisplayName, useEntity, useOpenEntity } from '@stores/hive-store';

interface SessionNoteProps {
  notif: HiveNotification;
  /** `note` rises above the pill; `row` is its line in the drawer. */
  variant: 'note' | 'row';
  /** Later and ✕: fold it into the pill. The note only. */
  onFold?: () => void;
}

/**
 * A session off stage that waits on you (HIVE-198): it asked, or its turn is
 * over. Either is answered in its own terminal, so this only takes you there.
 */
export function SessionNote({ notif, variant, onFold }: SessionNoteProps) {
  const terminalId = notif.action.type === 'session' ? notif.action.entityId : '';
  const rowId = useCurrentRow(terminalId);
  const entity = useEntity(rowId);
  const name = useDisplayName(terminalId);
  const openEntity = useOpenEntity();
  const project = entity !== undefined && isSession(entity) ? entity.project : '';
  const open = () => openEntity(rowId);
  const asked = notif.kind === 'session.blocked';

  if (variant === 'row') {
    // The whole row opens the session; its caret shows only on hover or focus.
    return (
      <button
        type="button"
        onClick={open}
        aria-label={`Open ${name}, ${notif.title}`}
        className="group flex w-full items-center gap-2.5 rounded-lg p-2 text-left text-control hover:bg-hover focus-visible:bg-hover"
      >
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-amber" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">
            <b className="font-semibold text-ink">{name}</b> <span className="text-muted">{notif.title}</span>
          </span>
          <span className="text-ui-sm text-muted">
            {`${project} · ${asked ? 'answer it in the session' : 'pick it up in the session'}`}
          </span>
        </span>
        <CaretRight
          aria-hidden
          size={14}
          className="shrink-0 text-brand opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
        />
      </button>
    );
  }

  return (
    <article
      data-notification={notif.id}
      aria-label={`${name} ${notif.title}`}
      className="flex w-[380px] max-w-full flex-col gap-[9px] rounded-xl border border-amber-edge bg-panel-2 px-3.5 py-3 text-control shadow-xl"
    >
      <div className="flex items-center gap-[7px] text-control text-muted">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-amber" />
        <b className="font-semibold text-ink">{name}</b>
        <span>{notif.title}</span>
        <span className="flex-1" />
        <span className="tabular-nums text-amber-text">now</span>
        <button
          type="button"
          aria-label="Fold into the pill"
          onClick={onFold}
          className="grid size-7 place-items-center rounded-full hover:bg-hover"
        >
          <X size={14} />
        </button>
      </div>
      <span className="text-muted">
        {`${project} · ${asked ? 'it waits in the session; the answer goes there' : 'its turn is over; it waits for you'}`}
      </span>
      <div className="flex gap-1.5">
        <Button size="sm" variant="primary" onClick={open}>
          Open the session
        </Button>
        <Button size="sm" onClick={onFold}>
          Later
        </Button>
      </div>
    </article>
  );
}

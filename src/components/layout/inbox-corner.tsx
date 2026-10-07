import type { RefObject } from 'react';


import { ArrivalStack, announcement, useStackCards } from '@features/inbox/components/arrival-stack';
import { InboxPill } from '@features/inbox/components/inbox-pill';
import { useOnStage } from '@hooks/use-on-stage';
import { useStageInset } from '@hooks/use-stage-inset';
import { isSessionSummons } from '@shared/notification-lanes';
import { useDisplayName, useThread } from '@stores/hive-store';
import { useSettingsOpen, useStackUp } from '@stores/ui-store';

interface InboxCornerProps {
  /** The stage it sits on, measured for the page's own input. */
  stage: RefObject<HTMLElement | null>;
  /** Which view is up, so the inset re-reads the input when it changes. */
  viewKey: string;
}

/**
 * The Inbox's corner of the stage (HIVE-198): the arrival stack over the
 * pill, 24px in from the stage's right edge and just above the page's own
 * input. Absolute, so nothing on the stage reflows or refits. The polite
 * live region is always mounted, so a reader hears an arrival without the
 * card ever taking focus.
 */
export function InboxCorner({ stage, viewKey }: InboxCornerProps) {
  const onStage = useOnStage();
  const bottom = useStageInset(stage, viewKey);
  // The stack's top card, which an arrival puts there (HIVE-228); read out only while it is drawn.
  const [top] = useStackCards(onStage);
  const newest = useStackUp() ? top : undefined;

  // Both lookups run every render (hooks are unconditional); each reads '' when it does not apply.
  const thread = newest?.action.type === 'ask' ? newest.action.thread : '';
  const from = useThread(thread).find((entry) => entry.id === thread)?.from ?? '';
  const sessionName = useDisplayName(newest?.action.type === 'session' ? newest.action.entityId : '');
  // Silent while Settings holds the stack back: a reader hears what is drawn, when it is drawn.
  const settings = useSettingsOpen();
  const said =
    newest === undefined || settings
      ? ''
      : announcement(newest, isSessionSummons(newest) ? sessionName : from);

  return (
    <div
      className="pointer-events-none absolute right-6 z-20 flex max-w-[calc(100%-3rem)] flex-col items-end gap-3.5"
      style={{ bottom }}
    >
      <div className="pointer-events-auto">
        <ArrivalStack onStage={onStage} />
      </div>
      <div className="pointer-events-auto">
        <InboxPill onStage={onStage} />
      </div>
      <span data-testid="inbox-live" aria-live="polite" className="sr-only">
        {said}
      </span>
    </div>
  );
}

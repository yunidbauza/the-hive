import { useState } from 'react';

import { cn } from '@/lib/utils';

import { Button } from '@components/ui/button';
import type { Rung, RungId } from '@shared/permission-rules';

/**
 * The scope ladder on a permission ask (HIVE-119).
 *
 * ## Why the scope is a control and not three more buttons
 *
 * The rail is 316px and its contents are unpredictable — a button row reading
 * "Allow once / Allow git * / Allow all NotebookEdit / Deny" wraps at a point
 * that moves with the tool's name, and a card whose footprint changes per
 * agent reads as broken. Splitting the decision (allow or deny) from its blast
 * radius (how far) gives a two-button row that never wraps, and buys the space
 * to say in words what the selected rung will do — which the button-only
 * layouts had nowhere to put.
 *
 * The rungs arrive as **data** on the ask, computed once by the tool that
 * wrote it. This component does no rule logic, and could not: `@shared` may
 * only cross into the renderer as types.
 */

interface PermissionControlsProps {
  rungs: readonly Rung[];
  initial: RungId;
  sending: boolean;
  onAnswer: (body: string) => void;
}

export function PermissionControls({
  rungs,
  initial,
  sending,
  onAnswer,
}: PermissionControlsProps) {
  const [scope, setScope] = useState<RungId>(initial);
  const selected = rungs.find((rung) => rung.id === scope) ?? rungs[0];

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      <div
        role="radiogroup"
        aria-label="How far this permission reaches"
        className="flex overflow-hidden rounded-md border border-border"
      >
        {rungs.map((rung) => (
          <button
            key={rung.id}
            type="button"
            role="radio"
            aria-checked={rung.id === scope}
            aria-label={rung.label}
            disabled={sending}
            onClick={() => setScope(rung.id)}
            className={cn(
              'flex-1 border-r border-border px-1.5 py-1 text-[10px] last:border-r-0',
              rung.id === scope
                ? 'bg-brand-fill text-on-brand'
                : 'text-muted hover:text-ink',
            )}
          >
            {rung.label}
          </button>
        ))}
      </div>

      {selected === undefined ? null : (
        <span className="text-[10px] text-subtle">{selected.caption}</span>
      )}

      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="primary"
          disabled={sending}
          onClick={() => onAnswer(scope)}
        >
          Allow
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={sending}
          onClick={() => onAnswer('deny')}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}

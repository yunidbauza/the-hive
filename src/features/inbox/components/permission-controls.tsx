import { useState } from 'react';

import { Button } from '@components/ui/button';
import { SegmentedControl } from '@components/ui/segmented-control';
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
 *
 * ## Fix round 1
 *
 * The scope segment used to be hand-rolled — every rung its own tab stop, no
 * arrow keys, no roving tabindex. `SegmentedControl` already implements the
 * radio-group keyboard pattern this codebase settled on (`option-stepper.tsx`
 * and the appearance section both build on it), so this reuses that atom
 * instead of a second, worse copy of the same behaviour.
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
      <SegmentedControl
        label="How far this permission reaches"
        options={rungs.map((rung) => ({ value: rung.id, label: rung.label }))}
        value={scope}
        onChange={setScope}
        disabled={sending}
      />

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

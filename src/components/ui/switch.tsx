import { Switch as SwitchPrimitive } from 'radix-ui';
import { useId } from 'react';

import { cn } from '@/lib/utils';

/**
 * An on/off control (story 106).
 *
 * The first boolean control in the app. `segmented-control` was the nearest
 * existing thing and is the wrong shape here — three On/Off segmented controls
 * stacked in a column reads as three unrelated choices rather than three
 * switches, and doubles the width of a settings row that says one word.
 *
 * **No new dependency.** Radix's `Switch` ships inside the `radix-ui` package
 * the settings overlay already imports its `Dialog` from, so this is a vendored
 * wrapper in the same spirit as `dialog.tsx`: the primitive supplies the
 * `role="switch"`, `aria-checked`, the space/enter handling and the disabled
 * semantics, and this file supplies the app's tokens and nothing else.
 *
 * The whole row is the label, so the hit target is the sentence rather than a
 * 36px rectangle beside it.
 */
interface SwitchProps {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Rendered under the label, for the "why you might want this" line. */
  description?: string;
  disabled?: boolean;
}

export function Switch({
  label,
  checked,
  onCheckedChange,
  description,
  disabled = false,
}: SwitchProps) {
  const id = useId();
  const describedBy = description === undefined ? undefined : `${id}-description`;

  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label
          htmlFor={id}
          className={cn(
            'text-[12.5px]',
            disabled ? 'text-subtle' : 'cursor-pointer text-ink',
          )}
        >
          {label}
        </label>
        {description === undefined ? null : (
          <p id={describedBy} className="text-[11.5px] text-subtle">
            {description}
          </p>
        )}
      </div>

      <SwitchPrimitive.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-describedby={describedBy}
        className={cn(
          'relative h-[18px] w-[32px] shrink-0 rounded-full outline-none transition-colors',
          'focus-visible:ring-1 focus-visible:ring-brand',
          checked ? 'bg-brand' : 'bg-chip',
          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        )}
      >
        <SwitchPrimitive.Thumb
          className={cn(
            'block h-[14px] w-[14px] rounded-full bg-panel-2 transition-transform',
            'translate-x-[2px] will-change-transform',
            'data-[state=checked]:translate-x-[16px]',
          )}
        />
      </SwitchPrimitive.Root>
    </div>
  );
}

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import type { Tone } from '@/types/notification';

const TONE_TEXT: Record<Tone, string> = {
  brand: 'text-brand',
  green: 'text-green',
  amber: 'text-amber',
  red: 'text-red',
};

interface ChipProps {
  children: ReactNode;
  /** Colours the text; the fill is always `--cc-chip`. Omit for muted. */
  tone?: Tone;
  title?: string;
  className?: string;
}

/**
 * A pill of dense, mono status text — the header's model chip, the session
 * meta bar's branch and PR chips (story 040).
 *
 * `whitespace-nowrap` is deliberate: a chip that wraps stops being a chip, and
 * in the header it would break the 56px row. Callers that can overflow are
 * expected to truncate rather than wrap.
 */
export function Chip({ children, tone, title, className }: ChipProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-chip px-3 py-1 font-mono text-[11.5px]',
        tone ? TONE_TEXT[tone] : 'text-muted',
        className,
      )}
    >
      {children}
    </span>
  );
}

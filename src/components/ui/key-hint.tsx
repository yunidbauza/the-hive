import { cn } from '@/lib/utils';

export interface KeyHintProps {
  /** Rendered in order, separated by the app's middot. */
  hints: readonly string[];
  className?: string;
}

/**
 * The row of keyboard affordances at the end of an input (story 043).
 *
 * Extracted from `message-input.tsx` because story 095 gave it a second reason
 * to exist: with a live terminal, the way *out* of one is a chord the user
 * cannot guess, and an undiscoverable escape hatch is not an escape hatch. Its
 * label differs by platform, so the string is no longer a constant and the row
 * is no longer a single hard-coded span.
 *
 * Deliberately dumb — it takes strings. Which chord applies is a question about
 * the surface, not about how a hint is drawn, and answering it here would drag
 * platform and capability checks into a presentational atom.
 */
export function KeyHint({ hints, className }: KeyHintProps) {
  if (hints.length === 0) return null;

  return (
    <span
      className={cn(
        'shrink-0 font-mono text-[10.5px] whitespace-nowrap text-subtle',
        className,
      )}
      data-testid="key-hint"
    >
      {hints.join(' · ')}
    </span>
  );
}

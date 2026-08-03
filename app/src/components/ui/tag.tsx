import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type TagTone = 'brand' | 'green' | 'amber' | 'red' | 'subtle';

const TONE_TEXT: Record<TagTone, string> = {
  brand: 'text-brand',
  green: 'text-green',
  amber: 'text-amber',
  red: 'text-red',
  subtle: 'text-subtle',
};

interface TagProps {
  children: ReactNode;
  tone: TagTone;
  /**
   * Native tooltip text, exactly as `Chip` already takes it.
   *
   * The Radix `Tooltip` atom is the richer answer, but its trigger cannot be
   * nested inside the left rail's project row — that row *is* a `<button>`,
   * and a button inside a button is invalid markup that React will warn about
   * and screen readers will read wrong. `title` is announced by assistive tech
   * and needs no wrapper (story 090).
   */
  title?: string;
  className?: string;
}

/**
 * A small text pill — the PRs panel's state, findings, and checks badges (052).
 *
 * Distinct from the two neighbouring atoms on purpose. `Badge` takes a `count`
 * and renders nothing at zero, so it cannot carry a word. `Chip` is a larger
 * mono pill for dense status text (the header's model chip) and has no `subtle`
 * tone. This one is proportional text at badge scale: the fill is always
 * `--cc-chip` and only the ink changes, which is what lets four of them sit in
 * one wrapping row without competing.
 */
export function Tag({ children, tone, title, className }: TagProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center rounded-full bg-chip px-2 py-0.5 text-[10.5px] font-semibold',
        TONE_TEXT[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

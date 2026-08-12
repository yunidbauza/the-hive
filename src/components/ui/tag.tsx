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

/**
 * What the tag is sitting *on*, which decides its own fill.
 *
 * A pill is only a pill because it contrasts with what is behind it, and this
 * atom's fill is `--cc-chip` — so on a card that is *itself* filled with
 * `--cc-chip` the shape disappears and only the coloured ink survives. That is
 * exactly the PRs panel's live cards (052).
 *
 * `raised` inverts the relationship instead of inventing a third colour: the
 * pill drops to `--cc-panel`, so it reads as cut *into* the card rather than
 * laid on top of it. Works in both themes for the same reason the fill does —
 * panel and chip are a fixed step apart, whichever direction the theme steps.
 */
export type TagSurface = 'panel' | 'raised';

const SURFACE_FILL: Record<TagSurface, string> = {
  panel: 'bg-chip',
  raised: 'bg-panel',
};

interface TagProps {
  children: ReactNode;
  tone: TagTone;
  /** The surface behind the tag. Defaults to the flat panel. */
  surface?: TagSurface;
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
 * tone. This one is proportional text at badge scale: within a given surface the
 * fill is fixed and only the ink changes, which is what lets four of them sit in
 * one wrapping row without competing. `surface` picks that fill — see
 * `TagSurface` for why it has to.
 */
export function Tag({
  children,
  tone,
  surface = 'panel',
  title,
  className,
}: TagProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold',
        SURFACE_FILL[surface],
        TONE_TEXT[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

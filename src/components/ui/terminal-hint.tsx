import { cn } from '@/lib/utils';

export interface TerminalHintProps {
  /** What just happened, in the user's terms. Left-aligned. */
  said: string;
  /** The key that fixes it, drawn as a cap. Right-aligned. */
  chord: string;
  /**
   * What the chord does — **and where it goes**.
   *
   * A destination rather than a verb, deliberately. "leaves it" tells a user
   * who has just been surprised by a keystroke that another keystroke will
   * surprise them again; "returns to the overmind" tells them where they will
   * be. The word is the app's own — it is what the bar above this one calls
   * the same action.
   */
  does: string;
  className?: string;
}

/**
 * A transient line along the foot of a terminal (HIVE-79).
 *
 * It exists for one situation and is shaped by it: the app tried to take a
 * keystroke, could not, and the user is now somewhere the app did not send
 * them. So the strip states **what happened before it offers the remedy** —
 * "`←` went to the session", then "`⌘[` leaves it" — because a user who has
 * just watched a key do something unexpected needs the cause named first. A
 * bare chord with no explanation is a hint about the app; this is an answer
 * about the thing that just happened.
 *
 * Inside the terminal region rather than on the bar above it, deliberately.
 * The bar already carries the same affordance permanently, and a user watching
 * the caret for a reaction is not looking at the bar — putting the news where
 * their eyes already are is the entire reason a second surface earns its place.
 *
 * Deliberately dumb, like {@link KeyHint} beside it: it takes strings. Which
 * chord applies is a question about the platform, and answering it here would
 * drag `isMac` into a presentational atom. Placement is the caller's too — this
 * draws a row and nothing else, so the stage decides where a row goes.
 *
 * `aria-live="polite"` because the whole defect is a thing that happened
 * silently: a screen-reader user is the one this strip cannot afford to miss.
 */
export function TerminalHint({
  said,
  chord,
  does,
  className,
}: TerminalHintProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="terminal-hint"
      className={cn(
        'pointer-events-none flex items-center gap-3',
        'border-t border-border-soft bg-panel/90 px-3.5 py-1.5 backdrop-blur-sm',
        'font-mono text-[11px] text-muted',
        className,
      )}
    >
      <span className="min-w-0 truncate">{said}</span>
      <span className="flex-1" />
      <span className="flex shrink-0 items-center gap-1.5">
        <kbd className="rounded bg-chip px-1.5 py-0.5 font-semibold text-ink">
          {chord}
        </kbd>
        {does}
      </span>
    </div>
  );
}

import { ArrowSquareOut } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';
import type { Pr } from '@/types/pull-request';

import { Icon } from '@components/ui/icon';
import { Tag } from '@components/ui/tag';
import { composeBadges, prStateText } from '@features/shared/pr-presentation';
import { useOpenEntity } from '@stores/hive-store';

interface PrCardProps {
  pr: Pr;
}

/**
 * One pull request: what it is, where it lives, and what it is waiting on.
 *
 * ## Two actions, and why the markup is shaped like this
 *
 * A PR has two useful destinations, and which one a user wants depends on what
 * they are about to do: read the diff and the review threads (GitHub), or fix
 * the findings (the agent's terminal). The card offers both.
 *
 * The card used to be a single `<button>`. It cannot stay one — an `<a>` inside
 * a `<button>` is invalid HTML, which React warns about and which leaves the
 * inner control unreachable by keyboard. So the box is a plain container with
 * two real controls in it:
 *
 * - **the number** is a link to the PR on GitHub, which the main process opens
 *   externally through its safe-scheme guard;
 * - **everything else** is a stretched button — `absolute inset-0`, sitting
 *   *under* the link — that opens the session.
 *
 * The stretched overlay is what keeps "click anywhere on the card" true without
 * nesting: the link paints above it (`relative z-10`), so the two targets never
 * overlap for a pointer, and each gets its own focus stop with its own label.
 *
 * ## Why the body falls back to GitHub
 *
 * `pr.session` is `null` whenever no session in the fleet is on that branch —
 * a PR raised outside the app, or one whose session has ended. A card that did
 * nothing on click in that case would read as broken, and the useful thing to
 * do with a PR you cannot open a terminal for is to go and look at it.
 *
 * The badge row comes from `composeBadges` in `features/shared` rather than
 * from local `if`s, so the rules cannot drift from the colours the work panel
 * (032) paints the same PRs with.
 *
 * ## Why merged cards sit lower than the rest
 *
 * The list is dominated by merged PRs — they accumulate, and the ones a user
 * still has to do something about are the minority scattered among them. When
 * every card shares one flat surface, finding those means reading each badge in
 * turn, which is the work the panel is supposed to save.
 *
 * So the surface carries the state too: draft, open and approved get the raised
 * `chip` fill and the stronger border, merged keeps the flat `border-soft` card.
 * This is the inbox's unread-vs-read treatment (`notification-card.tsx`) applied
 * to the same question — "does this still want me?" — and reusing it rather than
 * inventing a second visual language is the point.
 *
 * Two things have to move *with* the fill rather than stay shared, because both
 * are calibrated against the flat panel and neither survives the lift:
 *
 * - **the badges.** `Tag`'s fill is `--cc-chip`, the same colour as the raised
 *   card, so on a live card the pills would flatten into bare coloured text —
 *   leaving merged cards as the only ones whose badges still had a shape, which
 *   is precisely backwards. `surface="raised"` drops them to `--cc-panel`, so
 *   they read as cut into the card.
 * - **the hover**, and the repo line's ink; see the two comments below.
 *
 * The inbox needed none of this: its cards carry no `Tag`s, and its hover flaw
 * is real but latent. Copying the fill alone would have copied a treatment that
 * was never asked to hold a badge row.
 */
export function PrCard({ pr }: PrCardProps) {
  const openEntity = useOpenEntity();
  const badges = composeBadges(pr);
  const isLive = pr.state !== 'merged';

  const openSession = () => {
    if (pr.session !== null) {
      openEntity(pr.session);
      return;
    }
    // No terminal to open. `window.open` reaches the same guarded external
    // handler the link does — `window.ts` intercepts both.
    window.open(pr.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div
      className={cn(
        'relative rounded-xl border px-3 py-[var(--cc-card-py)]',
        // Live PRs sit on the raised chip surface; merged ones fall back to the
        // flat card. Same device the inbox uses for unread vs read, and for the
        // same reason: in a column where most cards have landed, the ones still
        // wanting something have to be findable without reading a badge.
        //
        // The hover pairs with the fill rather than being shared: `bg-hover` is
        // calibrated against the panel and lands *under* a chip fill, so a live
        // card would answer the pointer by going flat.
        isLive
          ? 'border-border bg-chip hover:bg-chip-hover'
          : 'border-border-soft hover:bg-hover',
      )}
    >
      {/*
        The primary target. First in the DOM so it is also first in the tab
        order: "open the session" is what the panel is for, and the link is the
        specific alternative to it.
      */}
      <button
        type="button"
        onClick={openSession}
        className="absolute inset-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <span className="sr-only">
          {pr.session !== null
            ? `Open session ${pr.session}`
            : `Open PR #${String(pr.n)} on GitHub`}
        </span>
      </button>

      <div className="pointer-events-none flex items-start gap-2.5 text-left">
        <Icon
          name="ph-git-pull-request"
          size={16}
          className={cn('mt-px shrink-0', prStateText(pr.state))}
        />

        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-1.5">
            {/*
              `pointer-events-auto` re-enables hits on the link alone: the row
              around it stays transparent so the overlay button underneath keeps
              receiving them.
            */}
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open PR #${String(pr.n)} on GitHub`}
              className="pointer-events-auto relative z-10 flex shrink-0 items-center gap-0.5 font-mono text-[12px] text-brand hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              #{pr.n}
              <ArrowSquareOut size={10} aria-hidden />
            </a>
            <span className="truncate text-[12.5px] font-semibold text-ink">
              {pr.title}
            </span>
          </span>

          {/*
            `subtle` at 10.5px is already thin against the panel; on the raised
            fill it drops under 3:1 in light mode. `muted` buys back the step the
            fill costs, on the cards the panel is trying to draw the eye to.
          */}
          <span
            className={cn(
              'pt-px pb-1.5 font-mono text-[10.5px]',
              isLive ? 'text-muted' : 'text-subtle',
            )}
          >
            {pr.repo}
          </span>

          {/*
            Unguarded: every `PrListState` produces at least one badge — merged,
            approved and draft each have their own, and an open PR gets either a
            findings count or "no findings". An `if (badges.length)` here would be
            a branch no state could reach.
          */}
          <span className="flex flex-wrap gap-1.5">
            {badges.map((badge) => (
              <Tag
                key={badge.text}
                tone={badge.tone}
                surface={isLive ? 'raised' : 'panel'}
              >
                {badge.text}
              </Tag>
            ))}
          </span>
        </span>
      </div>
    </div>
  );
}

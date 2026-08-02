import { cn } from '@/lib/utils';
import type { Pr } from '@/types/pull-request';

import { Icon } from '@components/ui/icon';
import { Tag } from '@components/ui/tag';
import { composeBadges, prStateText } from '@features/shared/pr-presentation';
import { useOpenTab } from '@stores/ui-store';

interface PrCardProps {
  pr: Pr;
}

/**
 * One open PR: what it is, where it lives, and what it is waiting on.
 *
 * Clicking opens the *session* that produced it, not the PR on GitHub. A PR has
 * no tab of its own in this app; the agent that owns it does, and that is where
 * a human can actually do something about the findings.
 *
 * The badge row comes from `composeBadges` in `features/shared` rather than
 * from local `if`s, so the rules cannot drift from the colours the work panel
 * (032) paints the same PRs with.
 */
export function PrCard({ pr }: PrCardProps) {
  const openTab = useOpenTab();
  const badges = composeBadges(pr);

  return (
    <button
      type="button"
      onClick={() => openTab(pr.session)}
      className="flex items-start gap-2.5 rounded-xl border border-border-soft px-3 py-2.5 text-left hover:bg-hover"
    >
      <Icon
        name="ph-git-pull-request"
        size={16}
        className={cn('mt-px shrink-0', prStateText(pr.state))}
      />

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 font-mono text-[12px] text-brand">
            #{pr.n}
          </span>
          <span className="truncate text-[12.5px] font-semibold text-ink">
            {pr.title}
          </span>
        </span>

        <span className="pt-px pb-1.5 font-mono text-[10.5px] text-subtle">
          {pr.repo}
        </span>

        {/*
          Unguarded: every `PrListState` produces at least one badge — merged,
          approved and draft each have their own, and an open PR gets either a
          findings count or "no findings". An `if (badges.length)` here would be
          a branch no fixture and no future state could reach.
        */}
        <span className="flex flex-wrap gap-1.5">
          {badges.map((badge) => (
            <Tag key={badge.text} tone={badge.tone}>
              {badge.text}
            </Tag>
          ))}
        </span>
      </span>
    </button>
  );
}

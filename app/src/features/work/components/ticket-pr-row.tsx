import { cn } from '@/lib/utils';
import type { TicketPr } from '@/types/pull-request';

import { Icon } from '@components/ui/icon';
import {
  findingsDescription,
  findingsLabel,
  prStateText,
} from '@features/shared/pr-presentation';
import { useOpenEntity } from '@stores/hive-store';

interface TicketPrRowProps {
  pr: TicketPr;
}

/**
 * One PR reached through a ticket's sessions.
 *
 * Clicking it opens the *owning session's* terminal, not a browser — a PR has
 * no tab of its own in this app; the session that produced it does.
 */
export function TicketPrRow({ pr }: TicketPrRowProps) {
  const openEntity = useOpenEntity();

  const stateText = prStateText(pr.state);
  const findings = findingsLabel(pr.findings);
  const findingsFor = findingsDescription(pr.findings);

  return (
    <button
      type="button"
      onClick={() => openEntity(pr.session)}
      className="-mx-1.5 flex items-center gap-[7px] rounded-md px-1.5 py-[3px] hover:bg-hover"
    >
      <Icon
        name="ph-git-pull-request"
        size={13}
        className={cn('shrink-0', stateText)}
      />

      <span className="shrink-0 font-mono text-[11px] text-brand">
        #{pr.n}
      </span>

      <span className="flex-1 truncate text-left font-mono text-[11px] text-subtle">
        {pr.repo}
      </span>

      <span
        className={cn(
          'shrink-0 text-[10px] font-bold uppercase tracking-[0.05em]',
          stateText,
        )}
      >
        {pr.state}
      </span>

      {findings ? (
        <span className="shrink-0 text-[10px] font-bold text-amber">
          <span aria-hidden="true">{findings}</span>
          <span className="sr-only">{findingsFor}</span>
        </span>
      ) : null}
    </button>
  );
}

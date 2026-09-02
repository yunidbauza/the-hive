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
 * One PR reached through a Jira ticket.
 *
 * Clicking it opens the *owning session's* terminal — a PR has no tab of its
 * own in this app; the session that produced it does, and that is where a human
 * can actually do something about the findings.
 *
 * When no session is on that branch there is no terminal to open, so the row
 * opens the PR on GitHub instead. That is the ordinary case for a PR raised
 * outside the app or one whose session has ended, and it is why the row renders
 * as a link rather than a button in that case: the destination is a page, and a
 * link is what a browser, a screen reader and a middle click all expect.
 *
 * **One action, unlike the PRs panel's card**, which offers the session and
 * GitHub separately. This row is 320px wide and 20px tall; a second target
 * inside it would be a coin toss for the pointer rather than a choice.
 */
export function TicketPrRow({ pr }: TicketPrRowProps) {
  const openEntity = useOpenEntity();

  const stateText = prStateText(pr.state);
  const findings = findingsLabel(pr.findings);
  const findingsFor = findingsDescription(pr.findings);

  const className =
    '-mx-1.5 flex items-center gap-[7px] rounded-md px-1.5 py-[3px] hover:bg-hover';

  const body = (
    <>
      <Icon
        name="ph-git-pull-request"
        size={13}
        className={cn('shrink-0', stateText)}
      />

      <span className="shrink-0 font-mono text-[11px] text-brand">#{pr.n}</span>

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
    </>
  );

  /*
    Read into a `const` before the branch so the closure below narrows without a
    cast. `pr.session` is a property read, and TypeScript will not carry a
    property's narrowing into a callback — the alternative is `as string`, which
    is a lie the compiler agrees to.
  */
  const session = pr.session;

  if (session === null) {
    return (
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open PR #${String(pr.n)} on GitHub`}
        className={className}
      >
        {body}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={() => openEntity(session)}
      className={className}
    >
      {body}
    </button>
  );
}

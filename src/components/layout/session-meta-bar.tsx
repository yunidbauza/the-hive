import { ArrowLeft, GitBranch, GitPullRequest, Robot } from '@phosphor-icons/react';

import {
  branchLabel,
  type Entity,
  entityLabel,
  isSession,
} from '@/types/entity';

import { Chip } from '@components/ui/chip';
import {
  StatusDot,
  STATUS_LABEL,
  STATUS_TEXT,
  statusLabel,
} from '@components/ui/status-dot';
import { prStateText } from '@features/shared/pr-presentation';
import { useBackToOrch } from '@stores/ui-store';

interface SessionMetaBarProps {
  entity: Entity;
}

/**
 * The bar above the terminal in the session and agent views (story 040).
 *
 * It answers "what am I looking at, and is it healthy?" without the user
 * leaving the terminal — id, one-line task, branch, status, PR. Everything here
 * is derived from the entity, so a status change or a PR opening updates the
 * bar the same moment it updates the rails.
 *
 * `flex-wrap` rather than truncation: at narrow widths the chips drop to a
 * second row instead of hiding the PR, which is the one thing on this bar the
 * user is most likely to be waiting on.
 */
export function SessionMetaBar({ entity }: SessionMetaBarProps) {
  const backToOrch = useBackToOrch();
  const session = isSession(entity) ? entity : null;

  return (
    <div
      data-testid="session-meta-bar"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-soft bg-panel px-4 py-2.5"
    >
      {/*
        A native `title` rather than the Radix tooltip: the app mounts no
        TooltipProvider yet, and adding one to the root for a single affordance
        buys nothing a title does not. The keyboard hint in the label is the
        point — story 060 binds ArrowLeft to this same action.
      */}
      <button
        type="button"
        onClick={backToOrch}
        title="Back to overmind (←)"
        aria-label="Back to overmind"
        className="flex shrink-0 items-center gap-1 rounded-full bg-chip px-2.5 py-1 font-mono text-[11.5px] text-muted hover:text-ink"
      >
        <ArrowLeft size={12} weight="bold" aria-hidden="true" />
      </button>

      <span className="shrink-0 font-mono text-[13px] font-semibold text-ink">
        {entityLabel(entity)}
      </span>

      {/*
        `min-w-0` + truncate: the task is the one field with no length bound, and
        without this it pushes the chips off the bar entirely.
      */}
      <span className="min-w-0 flex-1 truncate text-[13px] text-muted">
        {entity.task}
      </span>

      {session ? (
        <>
          <Chip>
            <GitBranch size={13} aria-hidden="true" className="shrink-0" />
            {branchLabel(session)}
          </Chip>

          <Chip className={STATUS_TEXT[session.status]}>
            {/* No `label` — the status word sits immediately beside the dot. */}
            <StatusDot status={session.status} detail={session.idleDetail} />
            {statusLabel(session.status, session.idleDetail)}
          </Chip>

          {session.pr ? (
            <Chip className={prStateText(session.pr.state)}>
              <GitPullRequest size={13} aria-hidden="true" className="shrink-0" />
              {`#${session.pr.n} · ${session.pr.state}`}
            </Chip>
          ) : null}
        </>
      ) : (
        <>
          <Chip>
            <Robot size={13} aria-hidden="true" className="shrink-0" />
            dedicated agent
          </Chip>

          <Chip className={STATUS_TEXT.online}>
            <StatusDot status="online" />
            {STATUS_LABEL.online}
          </Chip>
        </>
      )}
    </div>
  );
}

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
import { useSessionPr } from '@stores/hive-store';
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
  /**
   * The PR chip's subject, resolved from the live GitHub list (HIVE-100).
   *
   * It used to read `entity.pr`, a field nothing ever wrote — so this chip has
   * never once appeared outside a fixture, and the bar's own docstring above
   * promising "a PR opening updates the bar" was describing something that
   * could not happen. The fleet table read the same field and was empty for the
   * same reason; both now resolve by branch, and the field is gone.
   *
   * Safe for an agent, which is not a session and owns no branch: the selector
   * answers `null` for anything it cannot resolve, and the chip is inside the
   * `session` arm regardless.
   */
  const pr = useSessionPr(entity.id);

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

          {pr ? (
            /*
              A link, not a chip-shaped label: the bar sits above the terminal a
              user is watching a PR from, and the number is the fastest way to
              the page it names. Same target and `rel` as every other PR link in
              the app — `pr-card`, `ticket-pr-row`, the fleet table.
            */
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open PR #${String(pr.n)} on GitHub`}
              className="shrink-0 rounded-full hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              <Chip className={prStateText(pr.state)}>
                <GitPullRequest
                  size={13}
                  aria-hidden="true"
                  className="shrink-0"
                />
                {`#${pr.n} · ${pr.state}`}
              </Chip>
            </a>
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

import { cn } from '@/lib/utils';
import { isAgent } from '@/types/entity';

import { Icon } from '@components/ui/icon';
import {
  STATUS_FILL,
  STATUS_LABEL,
  STATUS_TEXT,
} from '@components/ui/status-dot';
import { describeNextRun, describeSkips, slackSignedOut } from '@lib/agents';
import { useAgentAskRef, useEntity, useOpenEntity } from '@stores/hive-store';
import { useActiveTab } from '@stores/ui-store';

interface AgentRowProps {
  id: string;
}

/**
 * One background agent: avatar tile, id, what it watches, and where it stands.
 *
 * Renders nothing for an id that is not an agent, matching the session rows in
 * 031/032 — panels stay defensive about a store that other stories mutate
 * underneath them.
 *
 * ## The right-hand meta answers "should I look?"
 *
 * The row used to carry its status in an `sr-only` span alone, because the
 * only state an agent could be in was `sleeping` and saying so on screen would
 * have been noise. Now that a rail can hold four states at once (HIVE-116),
 * the word is visible and the detail beneath it is whatever makes that word
 * actionable: the open ask's ref, the next wake, or nothing.
 *
 * The status word being on screen is also what lets the dot be decoration: it
 * stays `aria-hidden`, and the state is never carried by colour alone.
 */
export function AgentRow({ id }: AgentRowProps) {
  const entity = useEntity(id);
  const activeTab = useActiveTab();
  const openEntity = useOpenEntity();
  const askRef = useAgentAskRef(id);

  if (!entity || !isAgent(entity)) return null;

  const active = activeTab === id;
  const broken = entity.invalid !== undefined;

  /**
   * The second line of the meta — the fact that makes the status actionable.
   *
   * Only a resting row has one. `asking` and `failed` show nothing: the ref is
   * already beside the word, and a failure's reason belongs in the view rather
   * than squeezed into a rail row. `working` shows nothing either.
   *
   * **The cost is deliberately not here, and this column is why.** The meta is
   * `shrink-0`, so every character it holds is taken out of the name and
   * description beside it: `next 04:46 PM · $0.04` is 21 characters, about half
   * the width of a 268px rail once the avatar and the gaps are paid for, and it
   * truncated `ultralisk` to `ultrali…`. An agent's name is the only thing in
   * this row that identifies it, and a number is a poor trade for it.
   *
   * Nothing is lost by the omission. `entity.cost` is the *last finished* run's
   * spend, and the view's Today tile already carries the day's — which is the
   * figure anyone actually acts on. It was never drawn beside a `working` row
   * anyway: `pushAgentStatus` reads `runs[last]` and a run is only appended
   * when it finalizes, so beside a running agent it was the previous run's
   * money wearing this one's clothes.
   *
   * `skipped 3` stays, and only when there have been any (HIVE-121). The rail
   * is where "why has this done nothing all day?" actually gets asked, so this
   * is where the answer belongs — in the meta's own subtle colour rather than
   * amber, because the count reports the scheduler working exactly as its
   * definition asked, and a warning colour for correct behaviour is a lie the
   * reader has to spend time disproving.
   */
  const detail =
    entity.status === 'sleeping'
      ? [`next ${describeNextRun(entity)}`, describeSkips(entity)]
          .filter((part) => part !== undefined)
          .join(' · ')
      : '';

  /*
    The chip's tooltip, alongside `skipped N` rather than in place of it
    (HIVE-123). `skipped N` already answers "is anything wrong?"; this answers
    "what, specifically?" for the one reason a hover can name without the row
    growing another line — undefined leaves the chip with no `title` at all.
  */
  const slackReason = slackSignedOut(entity) ? 'slack: not signed in' : undefined;

  return (
    <button
      type="button"
      onClick={() => openEntity(id)}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-2.5 py-[var(--cc-row-py)]',
        active ? 'bg-active' : 'hover:bg-hover',
      )}
    >
      <span
        className="relative flex size-7 shrink-0 items-center justify-center rounded-lg bg-chip"
        title={slackReason}
      >
        <Icon name={entity.icon} size={15} className="text-brand" />

        {/*
          Not `StatusDot`: that atom is a 7px unringed dot, and this one is 9px
          with a 2px panel-coloured ring so it reads as lifted off the tile.

          The fill is the agent's real state rather than a hardcoded green
          (HIVE-114). It used to be green unconditionally, which described a
          fixture: an agent is a definition on disk, and between two wakes
          there is no process to be online. An unparseable definition takes
          amber, matching how the Skills pane marks a file it could not read.
        */}
        <span
          aria-hidden="true"
          className={cn(
            'absolute -right-0.5 -bottom-0.5 size-[9px] rounded-full border-2 border-panel',
            broken ? 'bg-amber' : STATUS_FILL[entity.status],
            // The same pulse the atom derives, for the one state that earns it.
            entity.status === 'working' && !broken && 'animate-ccpulse',
          )}
        />
      </span>

      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate font-mono text-[12.5px]">{entity.id}</span>
        {/*
          The reason it is broken, in place of the description — a definition
          that failed to parse has no description to show, and the reason is
          the one thing that helps.
        */}
        <span
          className={cn(
            'truncate text-[11px]',
            broken ? 'text-amber' : 'text-subtle',
          )}
        >
          {broken ? entity.invalid : entity.sub}
        </span>
      </span>

      <span className="shrink-0 text-right text-[10.5px] leading-tight">
        <span
          className={cn(
            'block',
            broken ? 'text-amber' : STATUS_TEXT[entity.status],
          )}
        >
          {broken ? 'invalid' : STATUS_LABEL[entity.status]}
          {askRef === undefined || broken ? null : ` ${askRef}`}
        </span>
        {detail === '' ? null : (
          <span className="block text-subtle">{detail}</span>
        )}
      </span>
    </button>
  );
}

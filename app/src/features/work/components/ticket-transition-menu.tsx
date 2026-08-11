import { CaretDown } from '@phosphor-icons/react';
import { useState } from 'react';

import { cn } from '@/lib/utils';
import type { Ticket } from '@/types/ticket';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@components/ui/dropdown-menu';
import { CATEGORY_TEXT, STATUS_PILL } from '@features/work/ticket-presentation';
import { applyJiraTransition, readJiraTransitions } from '@lib/jira';
import type { JiraTransition } from '@shared/jira-contract';
import { useUpdateTicket } from '@stores/hive-store';

/**
 * Move a ticket, from its card (HIVE-70).
 *
 * ## Why the list is fetched on open
 *
 * Jira does not let you set a status. You read the transitions available **from
 * this issue's current status in its workflow** and apply one by id — and those
 * ids are per-workflow, so an id read from one issue is meaningless on another.
 * That rules out both alternatives: fetching on render would be one request per
 * card every time the panel opens, and caching across issues would offer buttons
 * that cannot work.
 *
 * So the menu asks when it is opened, which is also the only moment the answer
 * matters.
 *
 * ## The primitive's own classes are inert here
 *
 * Same as `project-row-menu.tsx`, whose header explains it: `dropdown-menu.tsx`
 * is shadcn's and its defaults name shadcn's palette (`bg-popover`,
 * `bg-accent`), none of which exists in `tokens.css`. In Tailwind v4 a utility
 * whose token is undefined is never generated, so those classes are no-ops
 * rather than wrong colours — and every surface, border and text colour below
 * is therefore supplied explicitly.
 */

interface TicketTransitionMenuProps {
  /** The issue to move. Also the key the store replaces on success. */
  issueKey: string;
  /** The status the lozenge shows — Jira's own name, whatever the workflow calls it. */
  status: string;
  /** Which of Jira's three buckets colours it. */
  statusCategory: Ticket['statusCategory'];
}

type MenuState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; transitions: JiraTransition[] }
  | { kind: 'applying'; transitions: JiraTransition[] }
  /**
   * `transitions` is present only on the stale path, where the fresh list was
   * read *because* the attempt failed — the user needs the message and the new
   * options together, not one after the other.
   */
  | {
      kind: 'problem';
      message: string;
      details?: string[];
      transitions?: JiraTransition[];
    };

export function TicketTransitionMenu({
  issueKey,
  status,
  statusCategory,
}: TicketTransitionMenuProps) {
  const updateTicket = useUpdateTicket();
  const [state, setState] = useState<MenuState>({ kind: 'idle' });
  /**
   * Controlled, so a failure can keep the menu open.
   *
   * Radix closes on select by default, which would dismiss the panel at the
   * exact moment it has something to say — "you do not have permission", or the
   * field Jira wanted. So selecting calls `preventDefault()` and this closes
   * explicitly on success instead.
   */
  const [open, setOpen] = useState(false);

  const read = async (): Promise<JiraTransition[] | null> => {
    const result = await readJiraTransitions({ key: issueKey });
    if (result === null) {
      setState({
        kind: 'problem',
        message: 'The app could not reach its own main process.',
      });
      return null;
    }
    if (!result.ok) {
      setState({ kind: 'problem', message: result.error.message });
      return null;
    }
    return result.value;
  };

  const load = () => {
    setState({ kind: 'loading' });
    void read().then((transitions) => {
      if (transitions !== null) setState({ kind: 'ready', transitions });
    });
  };

  const apply = (transition: JiraTransition) => {
    const transitions =
      state.kind === 'ready' ? state.transitions : ([] as JiraTransition[]);
    setState({ kind: 'applying', transitions });

    void applyJiraTransition({
      key: issueKey,
      transitionId: transition.id,
    }).then((result) => {
      if (result === null) {
        setState({
          kind: 'problem',
          message: 'The app could not reach its own main process.',
        });
        return;
      }
      if (!result.ok) {
        const problem: MenuState = {
          kind: 'problem',
          message:
            result.error.kind === 'forbidden'
              ? 'You do not have permission to make this change.'
              : result.error.message,
          ...(result.error.details === undefined
            ? {}
            : { details: result.error.details }),
        };

        if (result.error.kind !== 'stale') {
          setState(problem);
          return;
        }

        /**
         * The issue moved underneath us, so what the menu holds is wrong.
         *
         * Shown *with* the fresh list rather than replaced by a spinner and
         * then a list: the message explains why the options just changed, and
         * separating the two would leave the user wondering whether their click
         * did anything.
         */
        setState(problem);
        void read().then((transitions) => {
          if (transitions !== null) setState({ ...problem, transitions });
        });
        return;
      }

      // The re-read issue, never an optimistic guess — that is why the verb
      // answers with one rather than with nothing.
      updateTicket(result.value);
      setState({ kind: 'idle' });
      setOpen(false);
    });
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) load();
        // Dismissing clears whatever the last attempt said, so reopening does
        // not greet the user with a stale error about a thing they already saw.
        else setState({ kind: 'idle' });
      }}
    >
      {/*
        The status lozenge **is** the trigger (HIVE-79).

        It used to be a separate `Move ⌄` control sitting between the key and
        the lozenge, and on a 268px rail — 216px of card, 180px at compact
        density — those three items did not fit: `INCORP-463` wrapped to a
        second line whenever the status was as long as `IN PROGRESS`. Shrinking
        the key was never an option, since it is the card's identity.

        Folding the control into the lozenge frees the whole `Move` label and
        its gap, and it is the honest shape besides: the thing you click to
        change the status is the status. The caret's width is *reserved* rather
        than revealed on hover, because a pill that grows under the pointer
        would shift the row it sits in.

        `bg-chip-hover` on hover, so the pill reads as pressable without a
        border that would make it a second visual weight next to the key.
      */}
      <DropdownMenuTrigger
        /*
          The status leads, because the lozenge is now the only place it appears
          on the card — the separate span `ticket-card.tsx` used to render for a
          real issue is gone. An `aria-label` of just "Move HIVE-70" would
          override the visible text and leave a screen-reader user unable to
          learn the status at all, and it would fail WCAG 2.5.3 (Label in Name)
          for speech input, since the accessible name would not contain the
          words on screen.
        */
        aria-label={`${status} — move ${issueKey}`}
        className={cn(
          STATUS_PILL,
          CATEGORY_TEXT[statusCategory],
          'flex items-center gap-1 hover:bg-chip-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand',
        )}
      >
        {status}
        <CaretDown size={9} aria-hidden="true" />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="min-w-[200px] rounded-[7px] border border-border bg-panel p-1 text-ink shadow-lg"
      >
        {state.kind === 'loading' || state.kind === 'applying' ? (
          <p className="px-2 py-1.5 text-[12px] text-subtle">
            {state.kind === 'loading' ? 'Reading transitions…' : 'Moving…'}
          </p>
        ) : null}

        {state.kind === 'problem' ? (
          <div className="flex flex-col gap-1 px-2 py-1.5">
            <p className="text-[12px] text-red">{state.message}</p>
            {/* Jira's own words, naming the field it wanted. Guessing a
                resolution on the user's behalf is exactly what not to do. */}
            {state.details?.map((detail) => (
              <p key={detail} className="text-[11.5px] text-subtle">
                {detail}
              </p>
            ))}
          </div>
        ) : null}

        {state.kind === 'problem' && state.transitions?.length === 0 ? (
          <p className="px-2 py-1.5 text-[12px] text-subtle">
            Nothing is available from its new status.
          </p>
        ) : null}

        {state.kind === 'problem'
          ? state.transitions?.map((transition) => (
              <DropdownMenuItem
                key={transition.id}
                onSelect={(event) => {
                  event.preventDefault();
                  apply(transition);
                }}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-[5px] px-2 py-1.5 text-[12px] text-ink focus:bg-hover"
              >
                <span>{transition.name}</span>
                <span className="text-[11px] text-subtle">
                  → {transition.to.name}
                </span>
              </DropdownMenuItem>
            ))
          : null}

        {state.kind === 'ready' && state.transitions.length === 0 ? (
          <p className="px-2 py-1.5 text-[12px] text-subtle">
            This issue&rsquo;s workflow offers nothing from here.
          </p>
        ) : null}

        {state.kind === 'ready'
          ? state.transitions.map((transition) => (
              <DropdownMenuItem
                key={transition.id}
                onSelect={(event) => {
                  // Keeps the menu open so a refusal has somewhere to render.
                  event.preventDefault();
                  apply(transition);
                }}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-[5px] px-2 py-1.5 text-[12px] text-ink focus:bg-hover"
              >
                <span>{transition.name}</span>
                {/* The destination, because a transition name is a verb and
                    frequently not the status it lands on. */}
                <span className="text-[11px] text-subtle">
                  → {transition.to.name}
                </span>
              </DropdownMenuItem>
            ))
          : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

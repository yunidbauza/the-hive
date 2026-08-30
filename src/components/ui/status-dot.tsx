import { cn } from '@/lib/utils';
import type { SessionStatus } from '@/types/entity';

import type { AgentStatus } from '@shared/agent-contract';
import type { IdleDetail } from '@shared/hook-contract';

/**
 * Sessions have five states; agents have five of their own (HIVE-114).
 *
 * A union rather than a widened `SessionStatus`, because the two halves answer
 * different questions — one is about a terminal, the other about a
 * correspondent — and `working` appears in both meaning the same thing, so the
 * overlap collapses for free rather than needing a synonym.
 *
 * `'online'` is gone with it. It described a socket, and an agent is not one:
 * between two wakes there is no process to be connected to.
 *
 * The four new members all take `idle`'s grey for now. That is deliberate and
 * temporary — HIVE-116 owns the agent palette — and grey is the honest
 * placeholder because every agent in this story *is* asleep.
 */
export type DotStatus = SessionStatus | AgentStatus;

/**
 * `terminated` is muted, not blue, and not `subtle` either (story 108).
 *
 * Blue is `done` — this palette's "there is something here" colour, and a
 * finished session is something: a PR to read, a diff to merge. A terminated one
 * is a row explaining an absence, so it takes the neutral grey. It is
 * deliberately *not* `subtle`, which `idle` already owns: idle and terminated
 * are the two states most easily confused — both quiet, one still alive — and
 * giving them the same dot would erase the only distinction that matters when
 * deciding whether to go look.
 */
/**
 * Exported since HIVE-114 for the one caller that cannot use `StatusDot`
 * itself: the agent rail row draws a 9px ringed dot lifted off its avatar
 * tile, which this atom deliberately is not. It takes the fill so the two
 * still cannot drift to different colours — the property this file exists to
 * hold.
 */
export const STATUS_FILL: Record<DotStatus, string> = {
  working: 'bg-green',
  waiting: 'bg-amber',
  idle: 'bg-subtle',
  done: 'bg-brand',
  terminated: 'bg-muted',
  // Agent states, all grey until HIVE-116 gives them a palette.
  sleeping: 'bg-subtle',
  asking: 'bg-subtle',
  paused: 'bg-subtle',
  failed: 'bg-subtle',
};

/**
 * The same colours as text, for the label beside the dot.
 *
 * Paired with `STATUS_FILL` deliberately: a dot and its label drifting to
 * different colours is the exact bug this file exists to prevent. Stories 031
 * and 041 render the label; 032 has no visible label and uses the dot alone.
 */
export const STATUS_TEXT: Record<DotStatus, string> = {
  working: 'text-green',
  waiting: 'text-amber',
  idle: 'text-subtle',
  done: 'text-brand',
  terminated: 'text-muted',
  sleeping: 'text-subtle',
  asking: 'text-subtle',
  paused: 'text-subtle',
  failed: 'text-subtle',
};

/**
 * The words that go with the colours.
 *
 * Exported because status is never carried by colour alone: the projects panel
 * (031) and the orchestrator table (041) render these as visible labels, and
 * re-deriving the `waiting → "needs input"` rename in three places is how the
 * three drift apart.
 */
export const STATUS_LABEL: Record<DotStatus, string> = {
  working: 'working',
  waiting: 'needs input',
  idle: 'idle',
  done: 'done',
  terminated: 'terminated',
  sleeping: 'sleeping',
  asking: 'asking',
  paused: 'paused',
  failed: 'failed',
};

/**
 * The hollow variant: a ring in the same colour, for a session that is quiet
 * but not empty (HIVE-83).
 *
 * Filled means nothing is running; hollow means something is. It costs no new
 * colour and no new glyph, and the one genuinely free session is then the only
 * solid grey dot on the panel — which is the glance the fleet view exists to
 * serve. A ring is a border rather than a fill, so it survives the light theme
 * where a lightened grey washes out.
 *
 * **Only ever applied to one status**, `idle` with a detail — the one state
 * where the main agent is quiet and something else is not. `waiting` keeps its
 * solid amber so "something needs you" stays the loudest thing on screen.
 *
 * That entry is now `working`'s green rather than `idle`'s grey, because the
 * label beside it says `working (agents)` and a grey ring under a green word
 * would be the dot and the text disagreeing. The ring is what still separates
 * it from a solid green session; the hue no longer is. `STATUS_RING.idle` is
 * therefore unreachable in practice and is kept only so the record stays total
 * — the same reason `STATUS_FILL` lists every member.
 */
const STATUS_RING: Record<DotStatus, string> = {
  working: 'border-green',
  waiting: 'border-amber',
  idle: 'border-subtle',
  done: 'border-brand',
  terminated: 'border-muted',
  sleeping: 'border-subtle',
  asking: 'border-subtle',
  paused: 'border-subtle',
  failed: 'border-subtle',
};

/**
 * What a quiet session with something still running is *called*.
 *
 * `working (agents)` and `working (scripts)`, not `idle (agents)`.
 *
 * The status is still `idle` and that is still correct — it is what a hook
 * observed about the **main agent**, and nothing about the observation has
 * changed. What changed is the reading. "Idle" is a word about a person having
 * stopped, and a user scanning a fleet table for something to pick up read it
 * as exactly that, while three subagents were mid-task and a build was running.
 * The parenthetical was carrying the entire meaning and losing, because the
 * first word is the one the eye takes.
 *
 * `scripts` rather than the detail's own `script`: the value names a *kind* of
 * thing still running and the label names however many of them there are, and
 * the plural reads correctly for one. Written here rather than widening
 * `IdleDetail`, because the union is what a hook payload says and this is what
 * a table says.
 *
 * A function rather than two more entries in `STATUS_LABEL`, because the detail
 * is orthogonal to the status: it rides alongside `SessionStatus` rather than
 * multiplying its members.
 */
const DETAIL_LABEL: Record<IdleDetail, string> = {
  agents: 'agents',
  script: 'scripts',
};

export function statusLabel(status: DotStatus, detail?: IdleDetail): string {
  if (status === 'idle' && detail !== undefined) {
    return `working (${DETAIL_LABEL[detail]})`;
  }
  return STATUS_LABEL[status];
}

/**
 * The colour that goes with {@link statusLabel}'s word.
 *
 * A function for the same reason the label is one, and it has to exist rather
 * than callers indexing `STATUS_TEXT` directly: a row that now *says* `working`
 * must not be painted in `idle`'s grey, or the two loudest signals in the cell
 * disagree with each other.
 *
 * The dot keeps carrying the distinction the colour no longer does. It is a
 * hollow ring here and a solid disc on a genuinely working session, so "the
 * agent itself is producing output" and "the agent is parked while its
 * subagents run" are still two different marks — see {@link STATUS_RING}.
 */
export function statusText(status: DotStatus, detail?: IdleDetail): string {
  if (status === 'idle' && detail !== undefined) return STATUS_TEXT.working;
  return STATUS_TEXT[status];
}

interface StatusDotProps {
  status: DotStatus;
  /** Defaults to pulsing only while `working`. Pass `false` to force it off. */
  pulse?: boolean;
  /**
   * What the dot describes — e.g. `'lead-form status'`, which is announced as
   * `"lead-form status: needs input"`.
   *
   * **Omit it when a visible status label sits beside the dot**, which is the
   * common case; the dot is then decoration and is hidden from the
   * accessibility tree rather than duplicating the text next to it.
   */
  label?: string;
  /**
   * What a quiet session is still running (HIVE-83), folded into the sr-only
   * text alongside `label`.
   *
   * Without this, a labelled dot on a hollow `idle` session announced plain
   * "idle" — the exact distinction the ring exists to carry, dropped for the
   * one audience that cannot see the ring at all.
   */
  detail?: IdleDetail;
  className?: string;
}

/**
 * A 7px status dot.
 *
 * The pulse is `animate-ccpulse` from `global.css` — never a hand-written
 * keyframe, so one definition drives every pulsing surface in the app.
 */
export function StatusDot({
  status,
  pulse,
  label,
  detail,
  className,
}: StatusDotProps) {
  const pulsing = pulse ?? status === 'working';
  /**
   * Derived, not passed in (HIVE-83 review fix). A caller used to hand-compute
   * this from `idleDetail` alone, which could not see `status` — a `done` row
   * with a stale `idleDetail` (see `hive-store.ts`'s `/clear` retirement) would
   * then draw a hollow ring in `STATUS_RING.done`, the brand colour, instead of
   * the solid fill. Gating on `status === 'idle'` here makes a hollow non-grey
   * dot unrepresentable regardless of what the caller passes.
   */
  const hollow = status === 'idle' && detail !== undefined;

  return (
    <span
      aria-hidden={label ? undefined : 'true'}
      className={cn(
        'inline-flex size-[7px] shrink-0 rounded-full',
        /*
          `STATUS_RING.working`, not `STATUS_RING[status]`. `hollow` is only
          ever true for `idle` with a detail, and that row is labelled and
          coloured as working — see `statusText`. Indexing by `status` here
          would draw the one grey ring under the one green word.
        */
        hollow
          ? `border-[1.5px] ${STATUS_RING.working}`
          : STATUS_FILL[status],
        pulsing && 'animate-ccpulse',
        className,
      )}
    >
      {label ? (
        <span className="sr-only">{`${label}: ${statusLabel(status, detail)}`}</span>
      ) : null}
    </span>
  );
}

import { Brain } from '@phosphor-icons/react';

import {
  chipLabel,
  clockLabel,
  dayClockLabel,
  pctLabel,
  pctOrNull,
} from '@/lib/session-metrics';
import { isSession } from '@/types/entity';

import { Chip } from '@components/ui/chip';
import { GaugeRing, gaugeTone } from '@components/ui/gauge-ring';
import { useActiveEntity, useSessionMetrics } from '@stores/hive-store';

const TONE_TEXT = {
  brand: 'text-brand',
  amber: 'text-amber',
  red: 'text-red',
} as const;

interface StatProps {
  pct: number | null;
  /** The word beside the number — `ctx`, or a reset time for the two limits. */
  detail: string;
  /** Names the quantity for assistive tech; never abbreviated. */
  label: string;
}

/**
 * One gauge, one percentage, one detail.
 *
 * The percentage takes the ring's own colour, so a limit going amber changes two
 * things that agree rather than one thing beside an unchanged number.
 */
function Stat({ pct, detail, label }: StatProps) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <GaugeRing pct={pct} label={label} />
      <span className={pct === null ? 'text-subtle' : TONE_TEXT[gaugeTone(pct)]}>
        {pctLabel(pct)}
      </span>
      <span className="text-subtle">{detail}</span>
    </span>
  );
}

/**
 * The active session's model, effort, context, and the two rate-limit windows
 * (HIVE-79).
 *
 * ```
 * ⌾ Opus 4.5 (1M) · high │ ◔ 46% ctx │ ◔ 12% ↻ 2:30p │ ◕ 46% ↻ Thu 5p
 * ```
 *
 * Renders nothing unless the active tab *is* a session: the orchestrator has no
 * model of its own, and agents are long-lived workers rather than a metered
 * conversation. Returning null rather than an empty chip lets the header's row
 * close the gap instead of holding an empty pill.
 *
 * ## Three stats, not two
 *
 * The chip used to show context and a single unlabelled percentage that was, in
 * fact, the five-hour window — with a reset **time but no day**. Two of those
 * three facts were unrecoverable from the chip itself. Now each window carries
 * its own gauge and its own reset, and the weekly one carries the weekday,
 * because "resets 5p" is the same string on a Monday and a Friday and completely
 * different news.
 *
 * ## What it does when it does not know
 *
 * An em dash and a dimmed, empty ring. `rate_limits` is absent until a session's
 * first API response, and absent for its whole life when the session
 * authenticated with an API key rather than a subscription — see
 * `metrics-contract.ts`. Rendering `0%` there would tell the user they have a
 * full week of headroom, which may be the opposite of true.
 *
 * ## Width, and what actually happens when the header narrows
 *
 * This chip is the thing that gives. `header.tsx` puts it inside the `flex-1`
 * zone while the counts zone sizes to its content, so the deficit lands here —
 * and `overflow-hidden` on the row lets the *stats* fall off the end rather
 * than forcing the header to scroll.
 *
 * It **clips rather than ellipsises**, and that is deliberate rather than a
 * `truncate` that failed. `text-overflow` acts on inline content; every child
 * of this row is a flex item, so an ellipsis has nothing to attach to and
 * `truncate` here would silently do nothing but hide the overflow. Clipping at a
 * hairline separator reads as "there is more", which is the honest signal — and
 * the full string, every label spelled out, stays in the `title`.
 *
 * The separators are hairline borders rather than `│` glyphs so they do not
 * change width with the font.
 */
export function ModelChip() {
  const entity = useActiveEntity();
  const metrics = useSessionMetrics(entity?.id);

  if (!entity || !isSession(entity)) return null;

  const context = pctOrNull(metrics?.contextPct);
  const fiveHour = pctOrNull(metrics?.fiveHourPct);
  const sevenDay = pctOrNull(metrics?.sevenDayPct);

  const label = chipLabel(metrics, entity.model, entity.effort);
  const fiveHourReset = clockLabel(metrics?.fiveHourResetsAt);
  const sevenDayReset = dayClockLabel(metrics?.sevenDayResetsAt);

  /*
    The tooltip spells out what the chip abbreviates — every label in full, both
    resets, and the window size in tokens. A truncated chip loses pixels, not
    information.
  */
  const title = [
    label,
    `context ${pctLabel(context)}`,
    `session limit ${pctLabel(fiveHour)}${fiveHourReset === null ? '' : `, resets ${fiveHourReset}`}`,
    `weekly limit ${pctLabel(sevenDay)}${sevenDayReset === null ? '' : `, resets ${sevenDayReset}`}`,
  ].join(' · ');

  return (
    <Chip title={title} className="min-w-0">
      <Brain size={13} weight="regular" className="shrink-0 text-brand" />
      <span className="flex min-w-0 items-center gap-2 overflow-hidden">
        <span className="shrink-0">{label}</span>

        <span className="flex shrink-0 items-center gap-2 border-l border-border pl-2">
          <Stat pct={context} detail="ctx" label="context" />
        </span>

        <span className="flex shrink-0 items-center gap-2 border-l border-border pl-2">
          <Stat
            pct={fiveHour}
            label="session limit"
            /*
              The window's *name* when there is no reset to show, not a second
              em dash. `— —` beside a dimmed ring is unreadable, and a session
              that has not reported yet is exactly when the user most needs to
              be told which of the two windows this is.
            */
            detail={fiveHourReset === null ? 'session' : `↻ ${fiveHourReset}`}
          />
        </span>

        <span className="flex shrink-0 items-center gap-2 border-l border-border pl-2">
          <Stat
            pct={sevenDay}
            label="weekly limit"
            detail={sevenDayReset === null ? 'week' : `↻ ${sevenDayReset}`}
          />
        </span>
      </span>
    </Chip>
  );
}

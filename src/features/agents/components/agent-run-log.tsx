import { useEffect, useRef } from 'react';

import type { TermLine } from '@/types/terminal';

import type { AgentStatus, RunSummary } from '@shared/agent-contract';
import { formatRunCost } from '@shared/agent-contract';
import { useTerminalAppearance } from '@stores/appearance-store';
import { useAgentLines, useAgentRuns } from '@stores/hive-store';

/**
 * The ceiling on the receipts half, as a share of the log's height.
 *
 * A percentage rather than a row count: this component's type scale is the
 * user's terminal one (10px to 18px), so "eight rows" is anywhere from 110px to
 * 200px of a box whose own height depends on two draggable rails. A share keeps
 * the same *proportion* at every size, which is what the rule is actually
 * about — the output must never be the smaller half.
 */
const RECEIPTS_MAX = '40%';

/**
 * The receipts' column track, shared by the header row and every receipt.
 *
 * **One constant, used twice, because a heading that can drift from its column
 * is worse than no heading.** Written as a string rather than duplicated
 * Tailwind classes for the same reason `RECEIPTS_MAX` is a constant: the two
 * consumers are forty lines apart.
 *
 * Widths are in `ch`, which is the right unit here and nowhere else in the app:
 * this component renders at the user's *terminal* type scale (10px to 18px), so
 * a pixel width that fits `interval` at 11px clips it at 17px. A `ch` is the
 * advance of `0` in the current font — in a monospace face, exactly one
 * character — so these columns hold the same number of glyphs at every size the
 * user can choose.
 *
 * The run id is **fixed**, not flexible, because it renders at a fixed width:
 * a full `randomUUID` is 36 characters — wider than every other column put
 * together — and the first eight already tell two runs apart, which is the
 * judgement `Fact label="Session"` in `agent-view.tsx` reached for the
 * conversation uuid. `#` plus eight is nine, so ten holds it with room.
 *
 * The flexible track goes to **Why** instead, and that is the one column that
 * earns it. `reason` is the only variable-length field here — "killed",
 * "stalled", "the app closed" — and it is the one thing a reader needs in full
 * when they need it at all. It was in the Outcome cell first, which clipped it
 * at every size the app can render, including the widest.
 *
 * `Turns`, `Took` and `Cost` are right-aligned with `tabular-nums`, so `9s` and
 * `10s` line up on their units and `$0.04` under `$0.16`. Left-aligned digits
 * were half the reason the old row looked ragged; the other half was that
 * `justify-between` gave `manual` (6 chars) and `interval` (8) different
 * starting points for everything after them.
 *
 * Measured in Chromium at 640/900/1200px and 10/12.5/18px: every cell's left
 * edge is identical across the header and all rows, and nothing clips except a
 * 37-character failure reason at the smallest pairing — which has its `title`.
 */
const RECEIPT_GRID =
  'grid items-baseline gap-x-3 [grid-template-columns:10ch_9ch_9ch_8ch_5ch_5ch_7ch_minmax(0,1fr)]';

interface AgentRunLogProps {
  name: string;
  status: AgentStatus;
}

/**
 * What an agent has been saying (HIVE-116).
 *
 * ## Why this is not an xterm
 *
 * A run log is a transcript, not a terminal: nothing is typed into it and no
 * process owns its cursor. It is DOM, which also means it can carry a header
 * row per run — something a character grid cannot do without drawing one.
 *
 * ## Colour comes from the theme's terminal palette, in JS
 *
 * `RunLineColor` names four slots — `ink`, `dim`, `amber`, `cyan` — and those
 * are terminal colours, which deliberately never reach CSS: `tokens.css` says
 * so at the top, and a `--cc-run-*` group would be a second representation of
 * values the theme already carries. `useTerminalAppearance` resolves them the
 * same way the xterm surface gets its palette, so a theme change moves this
 * log and the terminals together.
 *
 * The font size comes from there too, and that is load-bearing rather than
 * decorative: this log is the elastic half of the view's split, and it is the
 * user's terminal type scale (10px to 18px) that decides how many characters
 * fit on a line.
 *
 * ## The buffer is chopped into turns, not into runs
 *
 * Lines still arrive as a flat stream with **no run id on them**, so this
 * cannot group by run — only by turn, on the `endsTurn` fold. The two usually
 * coincide, and where they do not is the interesting part: a run that ends
 * without the CLI writing a fold would leave its output joined to the next
 * run's, which is why `runs.ts` writes one itself on every path that does not
 * produce a `result` (a kill, the stall watchdog, a quit).
 *
 * The boundary is that field and never the fold's `cyan`. Colour is
 * presentation; a partition that reads presentation breaks on the next palette.
 *
 * A live run has no identity here either, and that is a fact about the data
 * rather than a shortcut. `runs` is appended by `recordRun` when a run
 * *finalizes*, while `status: 'working'` is patched at spawn — so while an
 * agent is running, `runs[last]` is the run **before** this one. Drawing it as
 * the live header showed the wrong id, trigger and start time, and hid the
 * previous run's own receipt; on a first run there was no header at all.
 *
 * So every finished run is a receipt, always, and a live run is announced by a
 * banner that claims nothing it cannot know. Main would have to carry a
 * descriptor for the in-flight run for this to say more.
 *
 * Receipts do not expand, and they have no chevron promising that they might.
 * Their lines were never kept — `agents:lines` is a live push and nothing
 * writes it to disk — so a disclosure control would open onto nothing.
 *
 * ## Two scroll regions, not one
 *
 * The receipts and the output are two different documents that happened to be
 * stacked in one `overflow-y-auto` box, and one scrollbar for both made each of
 * them unreadable: scrolling back through fifty receipts pushed the output off
 * the bottom, and reading the output pushed every receipt out of reach. Worse,
 * the autoscroll below chases the foot of the *whole* box, so a live run
 * dragged the receipts away with it.
 *
 * So each half scrolls itself. The receipts take their natural height up to
 * {@link RECEIPTS_MAX}, then scroll in place; the output takes everything left
 * and is the half that grows. That split is the right way round because the
 * receipts are a fixed-height ledger of one line each and the output is prose
 * of unknown length — the elastic content gets the elastic space.
 *
 * Both halves read **newest first**, which is what makes the split safe. `runs`
 * is oldest-first and capped at `AGENT_RUN_HISTORY`, so a full history in a box
 * clipped to 40% would otherwise open on its ten oldest rows — with the newest
 * receipt, the one the `Latest output` heading beneath it describes, scrolled
 * out of sight. Reversing puts it at `scrollTop: 0`, which is where a scroll
 * box already opens; an earlier revision drove `scrollTop` from an effect
 * instead, which is machinery for a problem ordering does not have.
 */

export function AgentRunLog({ name, status }: AgentRunLogProps) {
  const lines = useAgentLines(name);
  const runs = useAgentRuns(name);
  const { palette, fontFamily, fontSize } = useTerminalAppearance();
  const foot = useRef<HTMLDivElement>(null);

  const live = status === 'working';

  /*
    Newest first, in both halves.

    This replaces a scroll pin. `runs` is oldest-first, and clipping the
    receipts to a share of the height meant a full history opened on its ten
    oldest rows — so an effect drove `scrollTop` to the bottom on every render.
    Reversing is the same answer without the machinery: the newest row is at
    `scrollTop: 0`, which is where a scroll box already opens, and the reader
    who scrolls away is not fighting an effect that wants to pull them back.

    `slice()` first, because `reverse` mutates and `runs` is the store's array.
  */
  const receipts = runs.slice().reverse();
  const turns = turnsOf(lines, live);

  useEffect(() => {
    /*
      Follow the newest line while it is being written.

      **Newest turn first does not mean newest line first**, and conflating the
      two is what this effect got wrong. Turns reverse; the lines inside a turn
      stay in reading order. So the live turn is the block on top, and its
      newest line is at the *bottom of that block* — not at the top of the
      region. Anchoring on the region's first child scrolled to the first line
      the run ever wrote and then re-yanked the reader there on every push,
      which is the opposite of following.

      `foot` therefore renders at the end of the live turn's lines. Not when
      the run is finished: pulling a reader out of a turn they are reading back
      through is the behaviour every transcript gets wrong.
    */
    if (live) foot.current?.scrollIntoView({ block: 'nearest' });
  }, [lines, live]);

  return (
    <div
      className="flex min-h-0 flex-col rounded-lg bg-term-bg p-2.5"
      style={{ fontFamily, fontSize }}
      data-region="run-log"
    >
      {receipts.length === 0 ? null : (
        /*
          **One scroll container, one font size**, and both are load-bearing.

          The header used to be a sibling *above* the scroller, which broke the
          column alignment twice over. Horizontally, only the rows could scroll,
          so at a narrow stage dragging them right left every label stationary
          over the wrong cell. Vertically it worked, but the fix for that is
          `sticky`, not separation.

          The font size is the subtler half, and it is why the constant alone
          was never enough. `ch` resolves against the font of *the element the
          track is declared on* — so a header at `0.8em` and rows at `0.9em`
          computed two different tracks from one identical class string. Every
          column drifted, from 8px at `Trigger` to 45px at `Why`, which put the
          heading nowhere near the values it named. The size therefore lives
          here, on the shared parent, and neither the header nor the rows may
          set their own.
        */
        <div
          className="shrink-0 overflow-auto text-[0.9em]"
          style={{ maxHeight: RECEIPTS_MAX }}
          data-region="run-receipts"
        >
          {/*
            `sticky`, not a sibling: it scrolls with the rows sideways and stays
            put as they pass underneath. It needs an opaque background for that
            second half — `bg-term-bg` is the log's own ground, so rows disappear
            *under* the header rather than through it.
          */}
          <div
            className={`${RECEIPT_GRID} sticky top-0 z-10 border-b border-border-soft bg-term-bg pb-1 tracking-[0.1em] uppercase`}
            style={{ color: palette.dim }}
            data-region="run-columns"
          >
            <span>Run</span>
            <span>Trigger</span>
            <span>Started</span>
            <span>Outcome</span>
            <span className="text-right">Turns</span>
            <span className="text-right">Took</span>
            <span className="text-right">Cost</span>
            <span>Why</span>
          </div>

          {receipts.map((run) => (
            <RunHeader
              key={run.run}
              run={run}
              dim={palette.dim}
              brand={palette.blue}
            />
          ))}
        </div>
      )}

      {live ? (
        <div
          /*
            `first:` restored. With no receipts — an agent's first ever run —
            this banner is the first child of the log, and without the variant
            it drew a top rule against nothing above it.
          */
          className="shrink-0 border-t border-border-soft pt-1 pb-0.5 text-[0.9em] first:border-t-0 first:pt-0"
          style={{ color: palette.dim }}
        >
          Running now — this run is recorded when it ends.
        </div>
      ) : null}

      {/*
        The heading sits outside the scroll box for the same reason the column
        header does: the output can be scrolled without losing the label that
        says what it is.

        It reads "Latest output" rather than "Last output" now, because the
        buffer holds several turns and the newest is on top — "last" named a
        single run that this has not been for a while.
      */}
      {!live && receipts.length > 0 && turns.length > 0 ? (
        <p
          className="shrink-0 border-t border-border-soft pt-1.5 pb-0.5 text-[0.85em] tracking-[0.1em] uppercase"
          style={{ color: palette.dim }}
        >
          Latest output
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto" data-region="run-output">
        {turns.length === 0 ? (
          <p style={{ color: palette.dim }}>
            Nothing yet — Run now wakes it.
          </p>
        ) : (
          turns.map((turn, turnIndex) => (
            <div
              /*
                Keyed by the turn's **first line**, not by its position.

                An index key was stable only while `turns.length` grew: once
                `capAgentLines` starts dropping whole turns off the head, the
                length stops moving and every key shifts by one, so React reuses
                each turn's node for a different turn. Harmless today — nothing
                in these blocks holds state — but the comment that used to sit
                here asserted an invariant the code did not have.

                A turn's opening line is unique enough in practice and, unlike
                the index, does not change when an older turn is evicted.
              */
              key={`${String(turnIndex)}:${turn[0]?.text ?? ''}`}
              className="border-t border-border-soft pt-1 pb-0.5 first:border-t-0 first:pt-0"
            >
              {turn.map((line, index) => (
                <p
                  key={index}
                  className="break-words whitespace-pre-wrap"
                  /*
                    `palette` is keyed by every `TermColor`, and `RunLineColor`
                    is a strict subset of it, so this indexes without a cast —
                    the same subset relationship a contract test pins.
                  */
                  style={{ color: palette[line.color] }}
                >
                  {line.text}
                </p>
              ))}

              {/*
                The anchor the live autoscroll chases, at the end of the newest
                turn's lines — which is where the newest line is. Only on the
                live turn: a finished log has nothing to follow.
              */}
              {live && turnIndex === 0 ? <div ref={foot} /> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Split a flat line buffer into turns, newest turn first.
 *
 * Lines within a turn keep their order — prose read bottom-up is not a log, it
 * is a puzzle. It is the *turns* that reverse, which is the same rule the
 * ledger column follows: the newest entry is on top, and each entry still reads
 * forwards.
 *
 * The boundary is `RunLine.endsTurn`, a field, and never the fold's `cyan`.
 * Colour is presentation; a structural split that reads presentation breaks on
 * the next palette change, which this file's own contract warns about.
 *
 * A trailing run of lines with no terminator means different things depending
 * on whether anything is running, and `live` is what tells them apart.
 *
 * While a run is live it is the **turn in progress**, and it belongs on top —
 * that is what the reader is watching. While nothing is running it is debris
 * from the turn that just ended: a stderr write flushed after the CLI's own
 * fold, most often a node or CLI warning emitted on the way out. Floating that
 * to the top would present a stray warning as the newest turn and push the
 * output it belongs to underneath it, so it is appended to the last finished
 * turn instead — which is where it actually came from.
 */
function turnsOf(lines: readonly TermLine[], live: boolean): TermLine[][] {
  const turns: TermLine[][] = [];
  let current: TermLine[] = [];

  for (const line of lines) {
    current.push(line);

    if (line.endsTurn === true) {
      turns.push(current);
      current = [];
    }
  }

  if (current.length > 0) {
    const previous = turns[turns.length - 1];

    if (!live && previous !== undefined) previous.push(...current);
    else turns.push(current);
  }

  return turns.reverse();
}

interface RunHeaderProps {
  run: RunSummary;
  dim: string;
  brand: string;
}

/**
 * One finished run, as a row of the receipts table.
 *
 * Only ever drawn for a **finished** run — a live one has no summary to draw
 * from. See the note on the component above.
 *
 * Every cell is its own grid child rather than a `·`-joined string, and that is
 * the whole of the alignment fix: joined text is laid out by its own length, so
 * `manual` moved the timestamp six characters left of where `interval` put it,
 * and a run that took `10s` pushed its cost a character right of one that took
 * `9s`. Columns cannot do that.
 *
 * `reason` has the last column and the only flexible track — see
 * {@link RECEIPT_GRID}. It rode in the outcome cell first, which clipped it at
 * every window size and font size the app can render.
 */
function RunHeader({ run, dim, brand }: RunHeaderProps) {
  const at = new Date(run.startedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const seconds = Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000));
  const cost = formatRunCost(run.costUsd);

  return (
    <div
      className={`${RECEIPT_GRID} border-t border-border-soft pt-1 pb-0.5`}
      style={{ color: dim }}
    >
      {/*
        Truncated to eight characters, with the whole uuid in the `title`. A
        `randomUUID` is 36 characters and would otherwise take more width than
        every other column combined — and eight is what already distinguishes a
        conversation on the Session tile.
      */}
      <span className="truncate" style={{ color: brand }} title={run.run}>
        {`#${run.run.slice(0, 8)}`}
      </span>
      <span className="truncate" title={run.trigger}>
        {run.trigger}
      </span>
      <span className="truncate tabular-nums">{at}</span>
      <span className="truncate" title={run.outcome}>
        {run.outcome}
      </span>
      {/*
        An em dash rather than a blank for a run that reported no turn count and
        no cost: a cell that is simply empty reads as a column that does not
        apply to this row, when what happened is that the run ended without
        saying.
      */}
      <span className="truncate text-right tabular-nums">{run.turns ?? '—'}</span>
      <span className="truncate text-right tabular-nums">{`${seconds}s`}</span>
      <span className="truncate text-right tabular-nums">{cost ?? '—'}</span>
      {/*
        Empty on almost every row, which is why it takes the *flexible* track
        rather than a width: a column sized for "killed after the stall watchdog
        fired" would steal that width from the columns that are never empty, and
        one sized for "killed" clips the sentence that actually explains a
        failure.
      */}
      <span className="truncate" title={run.reason}>
        {run.reason ?? ''}
      </span>
    </div>
  );
}

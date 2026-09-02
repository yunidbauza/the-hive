import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';
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
 * There is **no flexible track**, and the reason is not a column at all — it
 * gets its own line under the row it belongs to, drawn only when there is one.
 *
 * It was a `minmax(0,1fr)` column first, and that could not be made to work.
 * Given a flexible track it collapses to zero the moment the fixed columns
 * overflow the pane — so the field documented as "the one thing a reader needs
 * in full" was the first to vanish. Given `min-w-max` so the sticky header's
 * background could span the scroll width, it resolved to *max-content* instead
 * and made every row wider than the header, which is the same bug from the
 * other side. Off the track entirely, all eight columns are fixed, every row
 * and the header share one intrinsic width, and a failure reason can never be
 * clipped by a layout it does not participate in.
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
  'grid items-baseline gap-x-3 [grid-template-columns:10ch_9ch_9ch_8ch_5ch_5ch_7ch]';

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
  const output = useRef<HTMLDivElement>(null);

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
  const turns = turnsOf(lines);

  /**
   * Whether the reader is still watching the live turn.
   *
   * The guard is not optional here, and its absence was a bug the docblock
   * below used to deny. `lines` gets a fresh identity on every push, so the
   * effect fires on every chunk a run writes; without this, a reader who
   * scrolled *down* to an older turn was pulled back within a fraction of a
   * second, over and over, for as long as the run kept talking.
   *
   * Measured before React commits the new line, so it answers "were they
   * following along", not "does the box happen to fit". The 24px slack is
   * about a line: a reader one line off the anchor is still watching it.
   */
  const following = useRef(true);

  const noteScroll = () => {
    const box = output.current;
    const anchor = foot.current;

    if (box === null || anchor === null) return;

    const gap =
      anchor.getBoundingClientRect().bottom - box.getBoundingClientRect().bottom;

    following.current = gap <= 24;
  };

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

      `foot` therefore renders at the end of the live turn's lines, and only
      while a run is live — so `foot.current` is null on a finished log and the
      `live` check is belt to that brace.
    */
    if (live && following.current) foot.current?.scrollIntoView({ block: 'nearest' });
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
            /*
              `min-w-max` so the background spans the *scroll* width.

              A block box is as wide as its container's client width, so once
              the receipts overflow sideways and the reader scrolls right, the
              header's opaque fill simply stopped — and rows showed through the
              header, which is the one thing the fill was added to prevent. The
              rows carry it too, or they would not extend under it.
            */
            className={`${RECEIPT_GRID} sticky top-0 z-10 min-w-max border-b border-border-soft bg-term-bg pb-1 tracking-[0.1em] uppercase`}
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
          </div>

          {receipts.map((run, index) => (
            <RunHeader
              key={run.run}
              run={run}
              dim={palette.dim}
              brand={palette.blue}
              /*
                Explicit, not `first:`. The sticky header is the scroller's real
                `:first-child`, so the variant that used to suppress this rule is
                inert here — and the header's own `border-b` against the first
                row's `border-t` drew 2px under the heading where every other
                separator in the list is 1px.
              */
              first={index === 0}
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

      <div
        ref={output}
        onScroll={noteScroll}
        className="min-h-0 flex-1 overflow-y-auto"
        data-region="run-output"
      >
        {turns.length === 0 ? (
          <p style={{ color: palette.dim }}>
            Nothing yet — Run now wakes it.
          </p>
        ) : (
          turns.map((turn, turnIndex) => (
            <div
              /*
                Counted from the **oldest** turn, so appending does not renumber.

                `turns` is newest-first, so `turnIndex` alone shifts every key
                each time a turn arrives — which is every turn boundary — and
                React would rebuild the whole subtree, losing a text selection
                someone was making in an older turn. Subtracting from the length
                pins each turn to its position from the far end, which only
                moves when a turn is *evicted*: past `AGENT_LINE_CAP`, far rarer
                than an append, and with nothing stateful in these blocks to
                lose when it does.

                A content key was tried and is worse on both counts: every turn
                opens with the same `ledger_read` line, so it is not unique
                without the index — and with the index it is the index that
                decides, which is the churn this avoids.
              */
              key={turns.length - turnIndex}
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
 * A trailing run of lines with no terminator is the **turn in progress**, and
 * it belongs on top — that is what a reader watching a live run is watching.
 *
 * That is the only thing it can be, and only because `runs.ts` guarantees it:
 * every run terminates its own tail on close, including one whose stderr was
 * flushed *after* the CLI's fold. An earlier revision tried to sort that out
 * here instead, by asking whether the agent was currently running — and the
 * status flips to `working` before the next run writes anything, so a stray
 * warning was re-classified as the new run's opening line and sealed there.
 * The flag moved independently of the buffer it was describing. This function
 * reads only the buffer, which is the one thing that cannot lie about itself.
 */
function turnsOf(lines: readonly TermLine[]): TermLine[][] {
  const turns: TermLine[][] = [];
  let current: TermLine[] = [];

  for (const line of lines) {
    current.push(line);

    if (line.endsTurn === true) {
      turns.push(current);
      current = [];
    }
  }

  if (current.length > 0) turns.push(current);

  return turns.reverse();
}

interface RunHeaderProps {
  run: RunSummary;
  dim: string;
  brand: string;
  /** The row directly under the sticky header, which draws its own rule. */
  first: boolean;
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
function RunHeader({ run, dim, brand, first }: RunHeaderProps) {
  const at = new Date(run.startedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const seconds = Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000));
  const cost = formatRunCost(run.costUsd);

  return (
    <div
      className={cn(
        'min-w-max pb-0.5',
        first ? 'pt-1' : 'border-t border-border-soft pt-1',
      )}
      style={{ color: dim }}
    >
      <div className={RECEIPT_GRID}>
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
      </div>

      {/*
        Its own line, indented to the Trigger column so it reads as belonging to
        the row above rather than as a row of its own. Drawn only when a run
        actually ended badly, which is almost never — so it costs the ordinary
        row no height and the table no width.
      */}
      {run.reason === undefined ? null : (
        <p className="pl-[10ch] break-words whitespace-pre-wrap">{run.reason}</p>
      )}
    </div>
  );
}

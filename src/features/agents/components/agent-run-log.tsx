import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import type { TermLine } from '@/types/terminal';

import type { LiveRunSummary, RunSummary } from '@shared/agent-contract';
import { formatRunCost } from '@shared/agent-contract';
import { useTerminalAppearance } from '@stores/appearance-store';
import { useAgentLines, useAgentLive, useAgentRuns } from '@stores/hive-store';

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
 * The run id's floor is eleven, not nine, because it renders at a fixed width:
 * a full `randomUUID` is 36 characters — wider than every other column put
 * together — and the first eight already tell two runs apart, which is the
 * judgement `Fact label="Session"` in `agent-view.tsx` reached for the
 * conversation uuid. `#` plus eight is nine, and {@link LiveRow} prepends a kind
 * glyph — `●` or `○`, which most faces render wider than the `1ch` a digit
 * measures — so the floor is eleven: nine, the glyph, and room.
 *
 * ## Every track is `minmax(Nch, Nfr)`: a floor, and a proportional share
 *
 * The `ch` widths are **floors**, not sizes. Seven fixed tracks summed to about
 * 54 characters, which on the stage this log gets — the whole centre column,
 * often 1,500px and more — left two thirds of every row blank to the right of
 * `Cost`. The `fr` on each track shares whatever the pane has beyond the
 * floors, so the same seven columns read across the width they were given
 * rather than huddled at its left edge; on a narrow stage the floors bind and
 * the row is exactly what it was before.
 *
 * **The flex factor equals the floor, and that equality is the mechanism.**
 * The table wrapper carries `min-w-max`, so when the pane is narrower than the
 * columns the table is sized to its max-content — and under that constraint
 * CSS Grid resolves one `fr` to the largest `floor ÷ factor` across the
 * flexible tracks. With every ratio at `1ch`, each track lands on exactly its
 * floor: the overflowing table is the sum of the floors, which is precisely
 * the width the fixed grid had. `1fr` everywhere would instead have made every
 * column as wide as the *widest* floor — seven eleven-character tracks — and
 * pushed the pane into a sideways scroll it did not need. Wider than the
 * floors, the surplus is then split in the same proportions, so `Run` stays
 * the widest column and `Turns` the narrowest at every size instead of all
 * seven going equal.
 *
 * **One `min-w-max`, on a wrapper around the header and every row — never on
 * each of them.** Under the max-content constraint a grid also takes each
 * cell's own width into account, and the header's cells are wider than the
 * rows' for the same text: `tracking-[0.1em] uppercase` makes `TURNS` about
 * 5.8ch in a 5ch track. Given its own `min-w-max`, the header grid resolved a
 * larger `fr` than the row grids and drifted right of them by up to 70px at
 * `Cost` — measured in Chromium at a 360px scroller and 16px type. Sizing the
 * wrapper once, from the widest of them, hands header and rows the same
 * *definite* width, and against a definite width every grid here resolves the
 * same tracks, because only the floors and the factors take part.
 *
 * The reason and prompt lines under a row are `contain: inline-size` for the
 * same reason: a wrapping paragraph's max-content is its unwrapped length,
 * and one long failure reason would otherwise have widened the whole table
 * to fit it on a single line.
 *
 * That is also not the `minmax(0,1fr)` this grid once had, and the difference
 * is the zero. A track allowed to reach nothing does reach it the moment the
 * other tracks overflow the pane — which is how the failure reason vanished
 * first. A floor in `ch` closes that hole: no track can fall below its
 * shortest honest value.
 *
 * The failure reason is still **not a column** — it gets its own line under
 * the row it belongs to, drawn only when there is one — for the reason the
 * old fixed grid recorded: the one field a reader needs in full must not be
 * clipped by a layout it participates in.
 *
 * `Turns`, `Took` and `Cost` are right-aligned with `tabular-nums`, so `9s` and
 * `10s` line up on their units and `$0.04` under `$0.16`. Left-aligned digits
 * were half the reason the old row looked ragged; the other half was that
 * `justify-between` gave `manual` (6 chars) and `interval` (8) different
 * starting points for everything after them.
 */
const RECEIPT_GRID =
  'grid items-baseline gap-x-3 [grid-template-columns:minmax(11ch,11fr)_minmax(9ch,9fr)_minmax(9ch,9fr)_minmax(8ch,8fr)_minmax(5ch,5fr)_minmax(5ch,5fr)_minmax(7ch,7fr)]';

interface AgentRunLogProps {
  name: string;
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
 * ## The buffer is chopped into runs, then into turns
 *
 * Lines carry the run that wrote them (`TermLine.run`, HIVE-128), and they have
 * to: an agent runs a standing conversation and any number of tasks at once, so
 * several processes write into one buffer and a flat split on `endsTurn` would
 * cut one run's turn with another's fold. {@link groupsOf} partitions on the tag
 * first and splits each partition into turns after.
 *
 * The turn boundary is still the `endsTurn` field and never the fold's `cyan`.
 * Colour is presentation; a partition that reads presentation breaks on the next
 * palette. Where a run ends without the CLI writing a fold, `runs.ts` writes one
 * itself on every path that does not produce a `result` (a kill, the stall
 * watchdog, a quit).
 *
 * ## A live run has an identity, and it does not come from `runs`
 *
 * It never could: `runs` is appended by `recordRun` when a run *finalizes*, so
 * while an agent is running, `runs[last]` is the run **before** this one.
 * Drawing that as the live header showed the wrong id, trigger and start time,
 * and hid the previous run's own receipt; on a first run there was no header at
 * all. A banner claiming only "something is running" was the honest answer while
 * that was all the data said.
 *
 * Main carries a descriptor for every run in flight now (`Agent.live`), so each
 * one is a **row of the same table its receipt will join** — its own id, kind,
 * trigger and start time, `running` for an outcome, an elapsed `Took` that ticks,
 * and `—` for what a run cannot know until it ends. Every finished run is still
 * a receipt, always, and the two orderings differ on purpose: live runs read
 * standing-then-newest-task because that is the order they were started in
 * attention terms, finished runs read newest-first because that is history.
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

export function AgentRunLog({ name }: AgentRunLogProps) {
  const lines = useAgentLines(name);
  const runs = useAgentRuns(name);
  const liveRuns = useAgentLive(name);
  const { palette, fontFamily, fontSize } = useTerminalAppearance();
  const foot = useRef<HTMLDivElement>(null);
  const output = useRef<HTMLDivElement>(null);

  /*
    Liveness is the list, not the status word.

    `status: 'working'` is one flag for an agent that may be running a standing
    conversation and three tasks at once — it can say *that* something is
    running and never *what*, which is exactly the sentence the retired banner
    was reduced to.
  */
  const live = liveRuns.length > 0;

  /*
    Standing first, then tasks newest first (HIVE-128). The standing run is the
    agent being itself; a task is one job, and the newest job is the one the
    reader most likely just started.
  */
  const inFlight = liveRuns
    .slice()
    .sort((a, b) =>
      a.kind === b.kind ? b.startedAt - a.startedAt : a.kind === 'standing' ? -1 : 1,
    );

  /*
    `Took` counts up while a run is open, so this component owns a clock — one
    second, which is the resolution the column shows. It runs only while
    something is live, so a finished log re-renders on nothing at all.
  */
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return undefined;

    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);

    return () => {
      clearInterval(timer);
    };
  }, [live]);

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
  const groups = groupsOf(lines, inFlight, receipts);

  /*
    Which group the autoscroll anchor belongs to: the one that wrote the newest
    line in the buffer.

    It used to be group 0, and that was wrong in both directions. Group 0 is the
    live standing run — `inFlight` sorts standing first — so a chatty task run
    scrolled nothing at all, and the reader watching the job they just started
    watched the anchor chase a conversation that was idle. And before a live run
    has written its first line it has no group, so group 0 is then the newest
    *finished* run, which is history and cannot move.

    The buffer's own tail is the one thing that always names the run currently
    talking. Group 0 stays the fallback for a tag no group carries — the
    untagged bucket, whose lines predate the tag.
  */
  const lastRun = lines[lines.length - 1]?.run ?? '';
  const talking = groups.findIndex((group) => group.key === lastRun);
  const anchored = talking === -1 ? 0 : talking;

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
      {receipts.length === 0 && !live ? null : (
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
          data-testid="run-receipts"
        >
          {/*
            `min-w-max` on this wrapper, and on nothing inside it.

            A block box is as wide as its container's client width, so once
            the receipts overflow sideways and the reader scrolls right, the
            header's opaque fill simply stopped — and rows showed through the
            header, which is the one thing the fill was added to prevent. The
            wrapper is sized to the widest of its children, and header and rows
            are then blocks of that one definite width — which is also what
            keeps their tracks identical; see `RECEIPT_GRID` on why giving each
            of them its own `min-w-max` did not.
          */}
          <div className="min-w-max" data-region="run-table">
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
          </div>

          {/*
            The runs in flight, above the history, in the same columns. The
            reader's eye reads one table — which is the whole argument for
            putting them here rather than in a banner of their own.
          */}
          {inFlight.map((run, index) => (
            <LiveRow
              key={run.run}
              run={run}
              now={now}
              dim={palette.dim}
              brand={palette.blue}
              green={palette.green}
              first={index === 0}
            />
          ))}

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
              first={index === 0 && inFlight.length === 0}
            />
          ))}
          </div>
        </div>
      )}

      {/*
        The heading sits outside the scroll box for the same reason the column
        header does: the output can be scrolled without losing the label that
        says what it is.

        It reads "Latest output" rather than "Last output" now, because the
        buffer holds several turns and the newest is on top — "last" named a
        single run that this has not been for a while.
      */}
      {!live && receipts.length > 0 && groups.length > 0 ? (
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
        data-testid="run-output"
      >
        {groups.length === 0 ? (
          <p style={{ color: palette.dim }}>
            Nothing yet — Run now wakes it.
          </p>
        ) : (
          groups.map((group, groupIndex) => (
            <div
              key={group.key}
              className="border-t border-border-soft pt-1 pb-0.5 first:border-t-0 first:pt-0"
            >
              {/*
                Which run is talking. Unlabelled for the untagged group, because
                the honest label there is nothing at all — those lines were
                buffered before the tag existed and naming them would invent an
                attribution.

                It takes the size and tracking of a heading but **not** the
                `uppercase`, and that is the difference between a label and a
                heading: this one carries data. `text-transform` would print
                `#A3F9C21B` over a receipts row reading `#a3f9c21b` — two
                spellings of one id, on screen at once — and shout a task's
                prompt back at whoever typed it.
              */}
              {group.label === null ? null : (
                <p
                  className="text-[0.85em] tracking-[0.1em]"
                  style={{ color: palette.dim }}
                >
                  {group.label}
                </p>
              )}

              {group.turns.map((turn, turnIndex) => (
                <div
                  /*
                    Counted from the **oldest** turn, so appending does not
                    renumber.

                    `turns` is newest-first, so `turnIndex` alone shifts every
                    key each time a turn arrives — which is every turn boundary
                    — and React would rebuild the whole subtree, losing a text
                    selection someone was making in an older turn. Subtracting
                    from the length pins each turn to its position from the far
                    end, which only moves when a turn is *evicted*: past
                    `AGENT_LINE_CAP`, far rarer than an append, and with nothing
                    stateful in these blocks to lose when it does.

                    A content key was tried and is worse on both counts: every
                    turn opens with the same `ledger_read` line, so it is not
                    unique without the index — and with the index it is the
                    index that decides, which is the churn this avoids.
                  */
                  key={group.turns.length - turnIndex}
                  className="pt-0.5"
                >
                  {turn.map((line, index) => (
                    <p
                      key={index}
                      className="break-words whitespace-pre-wrap"
                      /*
                        `palette` is keyed by every `TermColor`, and
                        `RunLineColor` is a strict subset of it, so this indexes
                        without a cast — the same subset relationship a contract
                        test pins.
                      */
                      style={{ color: palette[line.color] }}
                    >
                      {line.text}
                    </p>
                  ))}

                  {/*
                    The anchor the live autoscroll chases, at the end of the
                    newest turn's lines — which is where the newest line is.
                    Only on the newest turn of the group that wrote that line
                    (see `anchored`): with several runs writing into one buffer,
                    the group being followed has to be the one currently
                    talking, not whichever sorts first. A finished log has
                    nothing to follow and mounts no anchor at all.
                  */}
                  {live && groupIndex === anchored && turnIndex === 0 ? (
                    <div ref={foot} data-testid="run-foot" />
                  ) : null}
                </div>
              ))}
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

interface OutputGroup {
  /** The run tag, or `''` for the lines that carry none. */
  key: string;
  /** `null` for the untagged group, which has no run to name. */
  label: string | null;
  turns: TermLine[][];
}

/**
 * The buffer, partitioned by the run that wrote each line, then split into
 * turns within each partition (HIVE-128).
 *
 * Several processes write into one agent's buffer at once, so a flat split on
 * `endsTurn` would cut one run's turn with another's fold. Order: the live
 * standing run, live tasks newest first, then finished runs newest first, then
 * whatever carries no tag — lines buffered before the tag existed — as one
 * trailing group. A tagged run no receipt names any more (evicted past the
 * history cap) keeps its place after the receipts, in first-seen order.
 */
function groupsOf(
  lines: readonly TermLine[],
  inFlight: readonly LiveRunSummary[],
  receipts: readonly RunSummary[],
): OutputGroup[] {
  const byRun = new Map<string, TermLine[]>();

  for (const line of lines) {
    const key = line.run ?? '';
    const bucket = byRun.get(key);

    if (bucket === undefined) byRun.set(key, [line]);
    else bucket.push(line);
  }

  const labelFor = (run: string): string => {
    const live = inFlight.find((candidate) => candidate.run === run);
    const id = `#${run.slice(0, 8)}`;

    if (live === undefined) return id;
    if (live.kind === 'standing') return `● standing · ${id}`;

    return `○ task · ${id}${live.extra === undefined ? '' : ` · ${live.extra}`}`;
  };

  /*
    The reading order, before any of it is known to have written a line: live
    runs, then receipts, then anything left in the buffer. Deduplicated by
    first appearance, so a run that is both live and (somehow) receipted keeps
    its live position.
  */
  const ordered = [
    ...inFlight.map((run) => run.run),
    ...receipts.map((run) => run.run),
    ...byRun.keys(),
  ].filter((key, index, all) => key !== '' && all.indexOf(key) === index);

  const groups: OutputGroup[] = [];

  for (const key of ordered) {
    const bucket = byRun.get(key);

    if (bucket === undefined) continue;

    groups.push({ key, label: labelFor(key), turns: turnsOf(bucket) });
  }

  const untagged = byRun.get('');

  if (untagged !== undefined) {
    groups.push({ key: '', label: null, turns: turnsOf(untagged) });
  }

  return groups;
}

interface LiveRowProps {
  run: LiveRunSummary;
  now: number;
  dim: string;
  brand: string;
  green: string;
  first: boolean;
}

/**
 * A run in flight, in the receipt columns (HIVE-128).
 *
 * The same seven cells as {@link RunHeader}, so the eye reads one table: what
 * is not known yet reads `—`, `Took` counts up, and the outcome is the one word
 * a live run can honestly claim.
 *
 * **`Turns` and `Cost` are both in that first category**, and turns only looks
 * as though it should not be. `endsTurn` is written once per run, by
 * `run-log.ts`, on the CLI's final `result` event — the fold that closes the
 * whole run — so counting the folds carrying this run's tag can only ever
 * return zero while the run is open. A cell that always reads `0` is not a
 * count, it is a claim that nothing has happened, in a row whose whole purpose
 * is to say something is. The settled number arrives with the receipt.
 *
 * The kind is a glyph before the id — filled for the standing conversation,
 * hollow for a task — with the word in the `title`, because a glyph nobody can
 * hover is a glyph nobody can read. A task's prompt takes the reason line
 * beneath, which is the one flexible track the grid has.
 */
function LiveRow({
  run,
  now,
  dim,
  brand,
  green,
  first,
}: LiveRowProps) {
  const at = new Date(run.startedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const seconds = Math.max(0, Math.round((now - run.startedAt) / 1000));
  const standing = run.kind === 'standing';

  return (
    <div
      className={cn('pb-0.5', first ? 'pt-1' : 'border-t border-border-soft pt-1')}
      style={{ color: dim }}
      data-live-run={run.kind}
    >
      <div className={RECEIPT_GRID}>
        <span
          className="truncate"
          style={{ color: brand }}
          title={standing ? 'standing run' : 'task run'}
        >
          <span aria-hidden="true" style={{ color: green }}>
            {standing ? '●' : '○'}
          </span>
          {`#${run.run.slice(0, 8)}`}
        </span>
        <span className="truncate" title={run.trigger}>
          {run.trigger}
        </span>
        <span className="truncate tabular-nums">{at}</span>
        <span className="truncate" style={{ color: green }}>
          running
        </span>
        {/* A turn count a run cannot know until it ends — see the docblock. */}
        <span className="truncate text-right tabular-nums">—</span>
        <span className="truncate text-right tabular-nums">{`${String(seconds)}s`}</span>
        {/* A cost a run cannot know until it ends — the same em dash a receipt uses. */}
        <span className="truncate text-right tabular-nums">—</span>
      </div>

      {/*
        The prompt a task was given, on the line a failure reason would take.
        The standing run has none — it was not asked anything, it simply woke.
      */}
      {run.extra === undefined ? null : (
        <p
          className="pl-[11ch] break-words whitespace-pre-wrap [contain:inline-size]"
          title={run.extra}
        >
          {run.extra}
        </p>
      )}
    </div>
  );
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
 * Only ever drawn for a **finished** run, and the reason is no longer that a
 * live one has nothing to draw from. A run in flight has a descriptor of its
 * own — the `LiveRunSummary` main pushes — and {@link LiveRow} draws it, in
 * these same columns. The split is about which source is truthful: this row
 * reads `runs`, which is written by `recordRun` at the moment a run finalizes,
 * so every cell here is settled. `LiveRow` reads the live list, where `Took`
 * still moves and the cost is not yet knowable.
 *
 * Every cell is its own grid child rather than a `·`-joined string, and that is
 * the whole of the alignment fix: joined text is laid out by its own length, so
 * `manual` moved the timestamp six characters left of where `interval` put it,
 * and a run that took `10s` pushed its cost a character right of one that took
 * `9s`. Columns cannot do that.
 *
 * `reason` is not a column at all — it gets its own line under the row, see
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
      className={cn('pb-0.5', first ? 'pt-1' : 'border-t border-border-soft pt-1')}
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
        <p className="pl-[11ch] break-words whitespace-pre-wrap [contain:inline-size]">
          {run.reason}
        </p>
      )}
    </div>
  );
}

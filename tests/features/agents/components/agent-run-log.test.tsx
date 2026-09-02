import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRunLog } from '@features/agents/components/agent-run-log';
import {
  type AgentSummary,
  type LiveRunSummary,
  type RunSummary,
} from '@shared/agent-contract';
import { useHiveStore } from '@stores/hive-store';

/**
 * What an agent has been saying.
 *
 * The mirror file CLAUDE.md requires. Its subject is the two-region split: the
 * receipts and the output are separate documents, and this pins that they are
 * separate *scroll containers* and that the receipts half opens on its newest
 * row rather than its oldest.
 *
 * That last claim is the one worth a test at all. `runs` is oldest-first, so
 * once the receipts were clipped to a share of the height, a full history
 * opened showing the ten oldest — with the newest receipt, the one the `Last
 * output` heading directly beneath it describes, scrolled out of sight. In a
 * single scroll box that could not happen.
 */
const run = (n: number, over: Partial<RunSummary> = {}): RunSummary => ({
  run: `r${String(n)}`,
  trigger: 'interval',
  startedAt: Date.UTC(2026, 8, 1, 12, n, 0),
  endedAt: Date.UTC(2026, 8, 1, 12, n, 4),
  outcome: 'done',
  costUsd: 0.01,
  turns: 2,
  ...over,
});

/*
  A run in flight, as main reports it (HIVE-128). Liveness is this list now, not
  `status: 'working'` — an agent can be running two things at once, and the
  status word cannot say which or how many.
*/
const standing = (over: Partial<LiveRunSummary> = {}): LiveRunSummary => ({
  run: 'live-standing',
  kind: 'standing',
  trigger: 'interval',
  startedAt: Date.UTC(2026, 8, 1, 14, 2, 0),
  ...over,
});

/** A task run, started `n` minutes after the standing one — so `n` orders them. */
const task = (n: number, extra: string): LiveRunSummary => ({
  run: `live-task-${String(n)}`,
  kind: 'task',
  trigger: 'manual',
  extra,
  startedAt: Date.UTC(2026, 8, 1, 14, 2 + n, 0),
});

const summary = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  name: 'watcher',
  description: 'Watches things.',
  icon: 'ph-robot',
  status: 'sleeping',
  wake: { on: [] },
  mcp: [],
  tools: [],
  rotateAfter: 50,
  runs: [],
  ...over,
});

const seed = (over: Partial<AgentSummary> = {}): void => {
  useHiveStore.getState().hydrateAgents([summary(over)]);
};

/*
  A `|` suffix marks the line that ends its turn — the `● turn ended` fold main
  writes with `endsTurn: true`. Spelled in the fixture rather than sniffed from
  the colour, which is the whole point of the field.
*/
const lines = (texts: string[], run?: string): void => {
  useHiveStore.getState().appendAgentLines({
    name: 'watcher',
    lines: texts.map((text) => ({
      ...(run === undefined ? {} : { run }),
      ...(text.endsWith('|')
        ? { text: text.slice(0, -1), color: 'cyan' as const, endsTurn: true as const }
        : { text, color: 'ink' as const }),
    })),
  });
};

describe('AgentRunLog', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
  });

  it('says so plainly when there is nothing yet', () => {
    seed();

    render(<AgentRunLog name="watcher" />);

    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
  });

  describe('the two regions', () => {
    it('puts the receipts and the output in separate scroll containers', () => {
      seed({ runs: [run(1), run(2)] });
      lines(['still going']);

      const { container } = render(<AgentRunLog name="watcher" />);

      const receipts = container.querySelector('[data-region="run-receipts"]');
      const output = container.querySelector('[data-region="run-output"]');

      expect(receipts).not.toBeNull();
      expect(output).not.toBeNull();
      expect(receipts).not.toContainElement(output as HTMLElement);
      expect(
        within(receipts as HTMLElement).getByText(/#r2/),
      ).toBeInTheDocument();
      expect(
        within(output as HTMLElement).getByText('still going'),
      ).toBeInTheDocument();
    });

    /*
      No receipts means no box for them — an empty scroll container would still
      take its share of the height for nothing.
    */
    it('draws no receipts region for an agent that has never run', () => {
      seed({ runs: [] });

      const { container } = render(<AgentRunLog name="watcher" />);

      expect(container.querySelector('[data-region="run-receipts"]')).toBeNull();
      expect(container.querySelector('[data-region="run-output"]')).not.toBeNull();
    });

    /**
     * The receipts read newest first.
     *
     * This replaced a scroll pin, and the pin is why the ordering is worth a
     * test rather than a glance. `runs` is oldest-first; once the receipts were
     * clipped to a share of the height, a full history opened on its ten oldest
     * rows, so an effect drove `scrollTop` to the bottom on every render.
     * Reversing is the same answer with no machinery — the newest row is at
     * `scrollTop: 0`, which is where a scroll box already opens.
     *
     * A regression to oldest-first is invisible to every other test here: the
     * same twenty rows render either way.
     */
    it('lists the newest run first', () => {
      seed({ runs: Array.from({ length: 20 }, (_, index) => run(index + 1)) });

      const { container } = render(<AgentRunLog name="watcher" />);

      const receipts = container.querySelector(
        '[data-region="run-receipts"]',
      ) as HTMLElement;

      const ids = within(receipts)
        .getAllByText(/^#r/)
        .map((node) => node.textContent);

      // Every receipt is rendered — the clip is visual, never a slice.
      expect(ids).toHaveLength(20);
      expect(ids[0]).toBe('#r20');
      expect(ids[19]).toBe('#r1');
    });

    /*
      The store's array is not reordered by the rendering of it. `reverse`
      mutates, and `runs` comes straight off the entity — an in-place reverse
      would flip the order on every re-render with no state change to explain it,
      and `agent-view`'s Session tile reads the same array.
    */
    it('leaves the store’s run history in the order main wrote it', () => {
      seed({ runs: [run(1), run(2), run(3)] });

      render(<AgentRunLog name="watcher" />);

      const entity = useHiveStore.getState().entities['watcher'];
      const order =
        entity !== undefined && 'runs' in entity
          ? entity.runs.map((r) => r.run)
          : [];

      expect(order).toEqual(['r1', 'r2', 'r3']);
    });

    /**
     * The column header is outside the scroll box.
     *
     * A heading that scrolls away with its rows is not a heading. It is also
     * the reason the receipts are a grid: `justify-between` has two ends and no
     * columns, so there was nothing for a header to name — and it was why
     * `manual` shifted the timestamp and `10s` shifted the cost.
     */
    /**
     * The header scrolls sideways with its rows and stays put as they pass
     * underneath — which is one container plus `sticky`, not two containers.
     *
     * It was a sibling *above* the scroller first. Vertically that worked;
     * horizontally it was the bug: only the rows could scroll, so at a narrow
     * stage dragging them right left every label stationary over the wrong
     * cell.
     */
    it('keeps the header with its columns, pinned rather than separated', () => {
      seed({ runs: [run(1)] });

      const { container } = render(<AgentRunLog name="watcher" />);

      const header = container.querySelector('[data-region="run-columns"]');
      const receipts = container.querySelector('[data-region="run-receipts"]');

      expect(header).not.toBeNull();
      // Same scroller, so a horizontal drag moves both.
      expect(receipts).toContainElement(header as HTMLElement);
      // Pinned, so a vertical scroll does not take it away.
      expect(header).toHaveClass('sticky');
      // Opaque, or rows would show through it as they pass under.
      expect(header).toHaveClass('bg-term-bg');

      for (const label of ['Run', 'Trigger', 'Started', 'Outcome', 'Turns', 'Took', 'Cost']) {
        expect(within(header as HTMLElement).getByText(label)).toBeInTheDocument();
      }
    });

    /**
     * One font size for the header and the rows, and this is the assertion the
     * "same track" test below could not make.
     *
     * `ch` resolves against the font of *the element the track is declared on*.
     * The header carried `text-[0.8em]` and the rows `text-[0.9em]`, so one
     * identical class string computed two different tracks: measured in
     * Chromium at 14px, the columns drifted from 8px at `Trigger` to 45px at
     * `Why` — the heading nowhere near the values it named. The size therefore
     * belongs to the shared parent, and neither may set its own.
     */
    it('lets neither the header nor the rows set their own font size', () => {
      seed({ runs: [run(1)] });

      const { container } = render(<AgentRunLog name="watcher" />);

      const scroller = container.querySelector(
        '[data-region="run-receipts"]',
      ) as HTMLElement;
      const header = container.querySelector('[data-region="run-columns"]');
      const row = scroller.querySelector('[data-region="run-columns"] ~ div');

      const sizes = (node: Element | null | undefined): string[] =>
        [...(node?.classList ?? [])].filter((c) => c.startsWith('text-['));

      expect(sizes(scroller)).toEqual(['text-[0.9em]']);
      expect(sizes(header)).toEqual([]);
      expect(sizes(row)).toEqual([]);
    });

    /*
      Both halves share one track constant, so a heading cannot drift from the
      column it names. Asserted as identity rather than by measuring, which
      happy-dom cannot do.
    */
    it('lays the header and the rows on the same track', () => {
      seed({ runs: [run(1)] });

      const { container } = render(<AgentRunLog name="watcher" />);

      const header = container.querySelector('[data-region="run-columns"]');
      /*
        The row's grid is an inner div now — the outer wrapper holds the rule
        and the optional reason line, which are not part of the track.
      */
      const row = container.querySelector(
        '[data-region="run-columns"] ~ div > div',
      );

      const track = (node: Element | null | undefined): string | undefined =>
        [...(node?.classList ?? [])].find((c) => c.includes('grid-template-columns'));

      expect(track(header)).toBeDefined();
      expect(track(row)).toBe(track(header));

      /*
        One `min-w-max`, on the wrapper, and none on the header or the rows.
        Given their own, the header — whose `uppercase tracking-[0.1em]` cells
        are wider than a row's for the same text — resolved a larger `fr` than
        the rows under the max-content constraint and drifted right of them;
        a shared wrapper hands all of them one definite width instead.
      */
      const table = container.querySelector('[data-region="run-table"]');
      expect(table).toHaveClass('min-w-max');
      expect(header).not.toHaveClass('min-w-max');
      expect(row?.parentElement).not.toHaveClass('min-w-max');
    });

    /**
     * Every column is `minmax(Nch, Nfr)` with the same `N` on both sides.
     *
     * The floor is what keeps a column from collapsing when the pane is
     * narrow; the flex share is what spreads seven short columns across a
     * 1,500px stage instead of leaving two thirds of it blank. The two being
     * *equal* is the part a reader cannot see and a refactor could quietly
     * break: under `min-w-max` the grid resolves to `max(floor ÷ factor)` per
     * `fr`, so equal ratios are what make an overflowing row exactly the sum
     * of its floors rather than seven copies of the widest one.
     */
    it('floors every column in ch and shares the surplus in the same proportion', () => {
      seed({ runs: [run(1)] });

      const { container } = render(<AgentRunLog name="watcher" />);
      const header = container.querySelector('[data-region="run-columns"]');
      const track = [...(header?.classList ?? [])].find((c) =>
        c.includes('grid-template-columns'),
      );

      const columns = track
        ?.replace(/^\[grid-template-columns:/, '')
        .replace(/\]$/, '')
        .split('_');

      expect(columns).toHaveLength(7);
      for (const column of columns ?? []) {
        const match = /^minmax\((\d+)ch,(\d+)fr\)$/.exec(column);
        expect(match, column).not.toBeNull();
        expect(match?.[1]).toBe(match?.[2]);
      }
    });
  });

  /*
    The reason has the only flexible column. It rode in the outcome cell first,
    which clipped it at every size — measured in Chromium, including the widest
    the app can render.
  */
  it('gives a failure its own column, in full', () => {
    seed({
      runs: [
        run(1, {
          outcome: 'failed',
          reason: 'killed after the stall watchdog fired',
        }),
      ],
    });

    const { container } = render(<AgentRunLog name="watcher" />);

    const receipts = container.querySelector(
      '[data-region="run-receipts"]',
    ) as HTMLElement;

    // The outcome cell says only the outcome; the reason is under it, whole.
    expect(within(receipts).getByText('failed')).toBeInTheDocument();

    const reason = within(receipts).getByText(
      'killed after the stall watchdog fired',
    );

    expect(reason).toBeInTheDocument();
    // A paragraph beneath the row, not a cell inside the grid.
    expect(reason.tagName).toBe('P');
    expect(reason.className).not.toContain('truncate');
  });

  /*
    An em dash, not a blank: an empty cell reads as a column that does not apply
    to this row, when what happened is the run ended without saying.
  */
  it('marks a missing turn count and cost rather than leaving them blank', () => {
    seed({ runs: [run(1, { turns: undefined, costUsd: undefined })] });

    const { container } = render(<AgentRunLog name="watcher" />);

    const receipts = container.querySelector(
      '[data-region="run-receipts"]',
    ) as HTMLElement;

    expect(within(receipts).getAllByText('—')).toHaveLength(2);
  });

  describe('the output, newest turn first', () => {
    /**
     * Turns reverse; the lines inside a turn do not.
     *
     * Prose read bottom-up is not a log, it is a puzzle — so this is the rule
     * the ledger column already follows: the newest entry is on top, and each
     * entry still reads forwards.
     */
    it('puts the newest turn on top and keeps each turn readable', () => {
      seed({ runs: [run(1)] });
      lines([
        'first: opened the file',
        'first: done',
        '● turn ended — success|',
        'second: read the ledger',
        'second: done',
        '● turn ended — success|',
      ]);

      const { container } = render(<AgentRunLog name="watcher" />);

      const output = container.querySelector(
        '[data-region="run-output"]',
      ) as HTMLElement;

      const text = [...output.querySelectorAll('p')].map((n) => n.textContent);

      expect(text).toEqual([
        'second: read the ledger',
        'second: done',
        '● turn ended — success',
        'first: opened the file',
        'first: done',
        '● turn ended — success',
      ]);
    });

    /*
      The live turn has no terminator yet — it is still being written — so it
      comes back as a trailing partial and belongs on top, which is where the
      reader is looking.
    */
    it('floats an unfinished turn above the finished ones', () => {
      seed({ status: 'working', runs: [run(1)], live: [standing()] });
      lines([
        'older: done',
        '● turn ended — success|',
        'newer: still working',
      ]);

      const { container } = render(<AgentRunLog name="watcher" />);

      const output = container.querySelector(
        '[data-region="run-output"]',
      ) as HTMLElement;

      const text = [...output.querySelectorAll('p')].map((n) => n.textContent);

      expect(text[0]).toBe('newer: still working');
    });

    /**
     * A live turn's newest line is at the **bottom of the top block**.
     *
     * Newest-turn-first does not mean newest-line-first: turns reverse, lines
     * inside a turn do not. The autoscroll anchor was the first child of the
     * output region, so it scrolled to the first line the run ever wrote and
     * re-yanked the reader there on every push — the opposite of following.
     */
    it('anchors the live autoscroll to the end of the newest turn', () => {
      seed({ status: 'working', runs: [run(1)], live: [standing()] });
      lines(['older: done', '● turn ended — success|', 'newest line']);

      const { container } = render(<AgentRunLog name="watcher" />);

      const output = container.querySelector(
        '[data-region="run-output"]',
      ) as HTMLElement;
      const anchor = output.querySelector('div > div:not([class])');
      const newest = within(output).getByText('newest line');

      expect(anchor).not.toBeNull();
      // Inside the newest turn's block, and after its last line.
      expect(newest.parentElement).toContainElement(anchor as HTMLElement);
      expect(
        newest.compareDocumentPosition(anchor as Node) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    /**
     * The effect actually fires — and stops firing once the reader leaves.
     *
     * The two tests around this one assert the anchor's *position*, which says
     * nothing about whether anything scrolls. `lines` gets a fresh identity on
     * every push, so the effect runs on every chunk a live run writes; without
     * the `following` guard a reader who scrolled down to an older turn was
     * pulled back within a fraction of a second, over and over, for as long as
     * the run kept talking — the behaviour the docblock claimed to prevent.
     */
    it('scrolls to the newest line while live, and stops once the reader scrolls away', () => {
      const scrollIntoView = vi.fn();

      vi.spyOn(
        window.HTMLElement.prototype,
        'scrollIntoView',
      ).mockImplementation(scrollIntoView);

      try {
        seed({ status: 'working', runs: [run(1)], live: [standing()] });
        lines(['first line']);

        const { container } = render(<AgentRunLog name="watcher" />);

        expect(scrollIntoView).toHaveBeenCalled();

        const output = container.querySelector(
          '[data-region="run-output"]',
        ) as HTMLElement;

        // The reader scrolls away. happy-dom reports 0 for every box, so the
        // measured gap is 0 — below the slack — and the guard stays true; force
        // the geometry that a real scroll would produce.
        vi.spyOn(output, 'getBoundingClientRect').mockReturnValue({
          bottom: 0,
        } as DOMRect);
        fireEvent.scroll(output);

        scrollIntoView.mockClear();
        lines(['second line']);

        expect(scrollIntoView).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    });

    /*
      Nothing to follow once the run is over, so the effect must not fire at
      all — the anchor is not even mounted.
    */
    it('never scrolls a finished log', () => {
      const scrollIntoView = vi.fn();

      vi.spyOn(
        window.HTMLElement.prototype,
        'scrollIntoView',
      ).mockImplementation(scrollIntoView);

      try {
        seed({ runs: [run(1)] });
        lines(['done', '● turn ended — success|']);

        render(<AgentRunLog name="watcher" />);

        expect(scrollIntoView).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    });

    /*
      Nothing to follow when nothing is running, so no anchor is rendered — and
      no rule is drawn above the first turn, which an unconditional anchor made
      permanently `:first-child` and so permanently doubled under the heading.
    */
    it('draws no anchor, and no leading rule, once the run has ended', () => {
      seed({ runs: [run(1)] });
      lines(['done', '● turn ended — success|']);

      const { container } = render(<AgentRunLog name="watcher" />);

      const output = container.querySelector(
        '[data-region="run-output"]',
      ) as HTMLElement;

      expect(output.querySelector('div > div:not([class])')).toBeNull();
    });

    /**
     * A terminated buffer is all this needs to read.
     *
     * The debris case — a stderr warning flushed after the CLI's fold — is
     * sealed by `runs.ts`, which re-closes the turn when output arrives after a
     * result. An earlier revision sorted it out here instead, by asking whether
     * the agent was currently running; the status flips to `working` before the
     * next run writes anything, so the warning was re-classified as the new
     * run's opening line and sealed there. This function reads only the buffer.
     */
    it('starts a new turn only where the buffer says one ended', () => {
      seed({ runs: [run(1)] });
      lines([
        'did the work',
        '● turn ended — success|',
        '(node) ExperimentalWarning: something',
        '● run ended — done|',
        'the next run speaks',
      ]);

      const { container } = render(<AgentRunLog name="watcher" />);

      const output = container.querySelector(
        '[data-region="run-output"]',
      ) as HTMLElement;

      /*
        The turn blocks, which are a level down now: the output is partitioned
        by run first, so each group is a div of its own and only its children
        are turns. Filtering by parent rather than by class keeps the assertion
        about structure rather than about the classes that happen to draw it.
      */
      const blocks = [...output.querySelectorAll('div[class]')]
        .filter((b) => b.parentElement !== output)
        .map((b) => [...b.querySelectorAll('p')].map((n) => n.textContent));

      expect(blocks).toEqual([
        ['the next run speaks'],
        ['(node) ExperimentalWarning: something', '● run ended — done'],
        ['did the work', '● turn ended — success'],
      ]);
    });

    /*
      A buffer written before `endsTurn` existed carries no terminators. It
      renders as one long turn rather than throwing — the degradation the field's
      optionality is for.
    */
    it('renders an unmarked buffer as a single turn', () => {
      seed({ runs: [run(1)] });
      lines(['one', 'two', 'three']);

      const { container } = render(<AgentRunLog name="watcher" />);

      const output = container.querySelector(
        '[data-region="run-output"]',
      ) as HTMLElement;

      expect([...output.querySelectorAll('p')].map((n) => n.textContent)).toEqual([
        'one',
        'two',
        'three',
      ]);
    });
  });

  describe('what a live run may claim', () => {
    /*
      The heading names the output below it, so it must not appear while a run
      is live — that output is this run's, not the last one's.
    */
    it('withholds the Latest output heading while a run is live', () => {
      seed({ status: 'working', runs: [run(1)], live: [standing()] });
      lines(['mid-flight']);

      render(<AgentRunLog name="watcher" />);

      expect(screen.queryByText('Latest output')).toBeNull();
    });

    it('heads the output once the run has ended', () => {
      seed({ status: 'sleeping', runs: [run(1)] });
      lines(['it finished']);

      render(<AgentRunLog name="watcher" />);

      expect(screen.getByText('Latest output')).toBeInTheDocument();
    });
  });

  /**
   * Several runs at once, each with a name (HIVE-128).
   *
   * The banner these replace could claim nothing but "something is running",
   * because a live run had no descriptor to draw from. Main sends one now, so
   * every run in flight is a row of the same table its receipt will join —
   * which is the claim worth pinning: a reader must be able to tell two live
   * runs apart, and tell each one's output from the other's.
   */
  describe('several runs live (HIVE-128)', () => {
    it('draws one running row per live run, the standing one first', () => {
      seed({
        status: 'working',
        runs: [run(1)],
        live: [task(1, 'review PR 166'), standing(), task(2, 'review PR 167')],
      });

      render(<AgentRunLog name="watcher" />);

      const receipts = screen.getByTestId('run-receipts');
      const ids = within(receipts)
        .getAllByTitle(/standing run|task run/)
        .map((el) => el.textContent);

      expect(ids).toEqual(['●#live-sta', '○#live-tas', '○#live-tas']);
      expect(within(receipts).getAllByText('running')).toHaveLength(3);
      expect(within(receipts).getAllByTitle('standing run')).toHaveLength(1);
      // The finished receipt survives beside them rather than being replaced.
      expect(within(receipts).getByText('#r1')).toBeInTheDocument();
      expect(screen.queryByText(/Running now/)).toBeNull();
    });

    /*
      `Turns` is not knowable while a run is open, so the row must not claim a
      number for it.

      `endsTurn` is written once per run — by the fold at the CLI's `result`
      event — so a count of this run's folds is zero for the whole life of the
      run, and a cell reading `0` says "nothing has happened" in a row whose
      only job is to say something is. The same em dash `Cost` uses.
    */
    it('reads — for a live run’s turns, not a number it cannot know', () => {
      seed({ status: 'working', live: [standing()] });

      const { container } = render(<AgentRunLog name="watcher" />);

      const row = container.querySelector(
        '[data-live-run="standing"]',
      ) as HTMLElement;
      const cells = [...(row.firstElementChild?.children ?? [])].map(
        (cell) => cell.textContent,
      );

      // Seven cells: id, trigger, started, outcome, turns, took, cost.
      expect(cells).toHaveLength(7);
      // Turns and cost both unknown; only `Took` carries a number.
      expect(cells[4]).toBe('—');
      expect(cells[6]).toBe('—');
      expect(cells[5]).toMatch(/^\d+s$/);
    });

    it('puts the task’s prompt under its row, where a failure reason goes', () => {
      seed({ status: 'working', live: [task(1, 'review PR 166 for correctness')] });

      render(<AgentRunLog name="watcher" />);

      expect(
        screen.getByText('review PR 166 for correctness'),
      ).toBeInTheDocument();
    });

    /*
      `Took` is the one cell that changes without a push from main, so the clock
      is this component's own — and a clock that renders once is a start time
      wearing a stopwatch's label.
    */
    it('counts the seconds a live run has taken, and keeps counting', () => {
      vi.useFakeTimers();

      // Restored on the way out however this ends: a failed expectation here
      // would otherwise leave every later spec in the file on a frozen clock.
      try {
        vi.setSystemTime(Date.UTC(2026, 8, 1, 14, 2, 41));
        seed({ status: 'working', live: [standing()] });

        render(<AgentRunLog name="watcher" />);

        expect(screen.getByText('41s')).toBeInTheDocument();

        act(() => {
          vi.advanceTimersByTime(2_000);
        });

        expect(screen.getByText('43s')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('groups the output by run, standing first, and labels each group', () => {
      seed({ status: 'working', live: [task(1, 'review PR 166'), standing()] });
      lines(['task line'], 'live-task-1');
      lines(['standing line'], 'live-standing');

      render(<AgentRunLog name="watcher" />);

      const output = screen.getByTestId('run-output');
      const text = output.textContent ?? '';

      expect(text.indexOf('standing line')).toBeLessThan(
        text.indexOf('task line'),
      );
      expect(
        within(output).getByText(/standing · #live-sta/),
      ).toBeInTheDocument();

      /*
        A label that carries data is not a heading, and `uppercase` is the
        difference. `text-transform` would print `#LIVE-TAS` over a receipts row
        reading `#live-tas` — two spellings of one id on screen at once — and
        shout a task's prompt back at whoever typed it.
      */
      const label = within(output).getByText(
        /task · #live-tas · review PR 166/,
      );

      expect(label).toBeInTheDocument();
      expect(label).not.toHaveClass('uppercase');
    });

    it('keeps lines with no run tag together at the end', () => {
      seed({ status: 'working', live: [standing()] });
      lines(['old untagged line|']);
      lines(['fresh line'], 'live-standing');

      render(<AgentRunLog name="watcher" />);

      const text = screen.getByTestId('run-output').textContent ?? '';

      expect(text.indexOf('fresh line')).toBeLessThan(
        text.indexOf('old untagged line'),
      );
    });

    /*
      The autoscroll follows whoever is talking, and with several runs live
      that is not whoever sorts first.

      The anchor used to sit in group 0, which is the standing run because
      `inFlight` puts it there — so a chatty task run scrolled nothing at all,
      and the reader watching the job they just started watched an anchor
      pinned to an idle conversation. The buffer's own tail names the run
      currently writing, and that is the group the anchor belongs to.
    */
    it('anchors the autoscroll in the group that wrote the newest line', () => {
      seed({ status: 'working', live: [standing(), task(1, 'review PR 166')] });
      lines(['standing line'], 'live-standing');
      lines(['task line'], 'live-task-1');

      render(<AgentRunLog name="watcher" />);

      const group = screen.getByTestId('run-foot').parentElement
        ?.parentElement as HTMLElement;

      expect(group.textContent).toContain('task line');
      expect(group.textContent).not.toContain('standing line');
    });

    /*
      An agent whose first ever run is still going has no receipts at all — and
      the row it does have still needs the columns that name its cells.
    */
    it('draws the columns for a first run that has not finished', () => {
      seed({ status: 'working', runs: [], live: [standing()] });

      const { container } = render(<AgentRunLog name="watcher" />);

      const receipts = screen.getByTestId('run-receipts');

      expect(
        container.querySelector('[data-region="run-columns"]'),
      ).not.toBeNull();
      expect(within(receipts).getByTitle('standing run')).toBeInTheDocument();
    });
  });
});

import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { AgentRunLog } from '@features/agents/components/agent-run-log';
import { type AgentSummary, type RunSummary } from '@shared/agent-contract';
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
const lines = (texts: string[]): void => {
  useHiveStore.getState().appendAgentLines({
    name: 'watcher',
    lines: texts.map((text) =>
      text.endsWith('|')
        ? { text: text.slice(0, -1), color: 'cyan' as const, endsTurn: true as const }
        : { text, color: 'ink' as const },
    ),
  });
};

describe('AgentRunLog', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
  });

  it('says so plainly when there is nothing yet', () => {
    seed();

    render(<AgentRunLog name="watcher" status="sleeping" />);

    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
  });

  describe('the two regions', () => {
    it('puts the receipts and the output in separate scroll containers', () => {
      seed({ runs: [run(1), run(2)] });
      lines(['still going']);

      const { container } = render(
        <AgentRunLog name="watcher" status="sleeping" />,
      );

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

      const { container } = render(
        <AgentRunLog name="watcher" status="sleeping" />,
      );

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

      const { container } = render(
        <AgentRunLog name="watcher" status="sleeping" />,
      );

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

      render(<AgentRunLog name="watcher" status="sleeping" />);

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

      const { container } = render(
        <AgentRunLog name="watcher" status="sleeping" />,
      );

      const header = container.querySelector('[data-region="run-columns"]');
      const receipts = container.querySelector('[data-region="run-receipts"]');

      expect(header).not.toBeNull();
      // Same scroller, so a horizontal drag moves both.
      expect(receipts).toContainElement(header as HTMLElement);
      // Pinned, so a vertical scroll does not take it away.
      expect(header).toHaveClass('sticky');
      // Opaque, or rows would show through it as they pass under.
      expect(header).toHaveClass('bg-term-bg');

      for (const label of ['Run', 'Trigger', 'Started', 'Outcome', 'Turns', 'Took', 'Cost', 'Why']) {
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

      const { container } = render(
        <AgentRunLog name="watcher" status="sleeping" />,
      );

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

      const { container } = render(
        <AgentRunLog name="watcher" status="sleeping" />,
      );

      const header = container.querySelector('[data-region="run-columns"]');
      const row = container.querySelector(
        '[data-region="run-columns"] ~ div',
      );

      const track = (node: Element | null | undefined): string | undefined =>
        [...(node?.classList ?? [])].find((c) => c.includes('grid-template-columns'));

      expect(track(header)).toBeDefined();
      expect(track(row)).toBe(track(header));
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

    const { container } = render(
      <AgentRunLog name="watcher" status="sleeping" />,
    );

    const receipts = container.querySelector(
      '[data-region="run-receipts"]',
    ) as HTMLElement;

    // The outcome cell says only the outcome; the reason is beside it, whole.
    expect(within(receipts).getByText('failed')).toBeInTheDocument();
    expect(
      within(receipts).getByText('killed after the stall watchdog fired'),
    ).toBeInTheDocument();
  });

  /*
    An em dash, not a blank: an empty cell reads as a column that does not apply
    to this row, when what happened is the run ended without saying.
  */
  it('marks a missing turn count and cost rather than leaving them blank', () => {
    seed({ runs: [run(1, { turns: undefined, costUsd: undefined })] });

    const { container } = render(
      <AgentRunLog name="watcher" status="sleeping" />,
    );

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

      const { container } = render(
        <AgentRunLog name="watcher" status="sleeping" />,
      );

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
      seed({ status: 'working', runs: [run(1)] });
      lines([
        'older: done',
        '● turn ended — success|',
        'newer: still working',
      ]);

      const { container } = render(
        <AgentRunLog name="watcher" status="working" />,
      );

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
      seed({ status: 'working', runs: [run(1)] });
      lines(['older: done', '● turn ended — success|', 'newest line']);

      const { container } = render(
        <AgentRunLog name="watcher" status="working" />,
      );

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

    /*
      Nothing to follow when nothing is running, so no anchor is rendered — and
      no rule is drawn above the first turn, which an unconditional anchor made
      permanently `:first-child` and so permanently doubled under the heading.
    */
    it('draws no anchor, and no leading rule, once the run has ended', () => {
      seed({ runs: [run(1)] });
      lines(['done', '● turn ended — success|']);

      const { container } = render(
        <AgentRunLog name="watcher" status="sleeping" />,
      );

      const output = container.querySelector(
        '[data-region="run-output"]',
      ) as HTMLElement;

      expect(output.querySelector('div > div:not([class])')).toBeNull();
      expect(output.firstElementChild).toHaveClass('first:border-t-0');
    });

    /**
     * A stray line after the fold is debris, not a new turn.
     *
     * stderr is flushed on the way out — a node or CLI warning lands after the
     * `result` the fold was written from. Left as a trailing partial it floated
     * to the very top and presented itself as the newest turn, pushing the
     * output it belongs to underneath it. While nothing is running it is
     * appended to the turn it came from instead.
     */
    it('attaches a post-fold stderr line to the turn it came from', () => {
      seed({ runs: [run(1)] });
      lines([
        'did the work',
        '● turn ended — success|',
        '(node) ExperimentalWarning: something',
      ]);

      const { container } = render(
        <AgentRunLog name="watcher" status="sleeping" />,
      );

      const output = container.querySelector(
        '[data-region="run-output"]',
      ) as HTMLElement;

      // One turn, not two — and the warning is last, where it happened.
      expect(output.querySelectorAll('div[class]')).toHaveLength(1);
      expect([...output.querySelectorAll('p')].map((n) => n.textContent)).toEqual([
        'did the work',
        '● turn ended — success',
        '(node) ExperimentalWarning: something',
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

      const { container } = render(
        <AgentRunLog name="watcher" status="sleeping" />,
      );

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
      `runs` is appended when a run finalizes, while `status: 'working'` is
      patched at spawn — so `runs[last]` is the run *before* this one, and
      drawing it as the live header showed the wrong id and start time.
    */
    it('announces a live run without borrowing the previous run’s identity', () => {
      seed({ status: 'working', runs: [run(1)] });

      render(<AgentRunLog name="watcher" status="working" />);

      expect(screen.getByText(/Running now/)).toBeInTheDocument();
      // The finished receipt survives beside it rather than being replaced.
      expect(screen.getByText(/#r1/)).toBeInTheDocument();
    });

    /*
      The heading names the output below it, so it must not appear while a run
      is live — that output is this run's, not the last one's.
    */
    it('withholds the Latest output heading while a run is live', () => {
      seed({ status: 'working', runs: [run(1)] });
      lines(['mid-flight']);

      render(<AgentRunLog name="watcher" status="working" />);

      expect(screen.queryByText('Latest output')).toBeNull();
    });

    it('heads the output once the run has ended', () => {
      seed({ status: 'sleeping', runs: [run(1)] });
      lines(['it finished']);

      render(<AgentRunLog name="watcher" status="sleeping" />);

      expect(screen.getByText('Latest output')).toBeInTheDocument();
    });
  });
});

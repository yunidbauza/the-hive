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

const lines = (texts: string[]): void => {
  useHiveStore.getState().appendAgentLines({
    name: 'watcher',
    lines: texts.map((text) => ({ text, color: 'ink' as const })),
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
        within(receipts as HTMLElement).getByText(/Run #r2/),
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
     * The receipts open on the newest row.
     *
     * `scrollHeight` is stubbed because happy-dom performs no layout and
     * answers `0` for every measurement — against which `scrollTop =
     * scrollHeight` is `0 = 0`, an assignment that cannot fail and therefore
     * cannot catch the regression it exists for. The defect was an effect that
     * did not run at all; a stubbed height is what makes "did it assign"
     * observable.
     *
     * What this still cannot prove is that 40% of a real box clips in the
     * first place. That is layout, and layout is Playwright's.
     */
    it('drives the receipts region to its newest row on open', () => {
      const height = Object.getOwnPropertyDescriptor(
        window.HTMLElement.prototype,
        'scrollHeight',
      );

      Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get: () => 640,
      });

      try {
        seed({ runs: Array.from({ length: 20 }, (_, index) => run(index + 1)) });

        const { container } = render(
          <AgentRunLog name="watcher" status="sleeping" />,
        );

        const receipts = container.querySelector(
          '[data-region="run-receipts"]',
        ) as HTMLElement;

        // Every receipt is rendered — the clip is visual, never a slice.
        expect(within(receipts).getAllByText(/^Run #/)).toHaveLength(20);
        expect(within(receipts).getByText(/Run #r20/)).toBeInTheDocument();
        expect(receipts.scrollTop).toBe(640);
      } finally {
        /*
          Restored rather than deleted: the property is `HTMLElement`'s own in
          happy-dom, and leaving a getter on the prototype would follow this
          file into every other suite in the run.
        */
        if (height === undefined) {
          Reflect.deleteProperty(window.HTMLElement.prototype, 'scrollHeight');
        } else {
          Object.defineProperty(
            window.HTMLElement.prototype,
            'scrollHeight',
            height,
          );
        }
      }
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
      expect(screen.getByText(/Run #r1/)).toBeInTheDocument();
    });

    /*
      The heading names the output below it, so it must not appear while a run
      is live — that output is this run's, not the last one's.
    */
    it('withholds the Last output heading while a run is live', () => {
      seed({ status: 'working', runs: [run(1)] });
      lines(['mid-flight']);

      render(<AgentRunLog name="watcher" status="working" />);

      expect(screen.queryByText('Last output')).toBeNull();
    });

    it('heads the output once the run has ended', () => {
      seed({ status: 'sleeping', runs: [run(1)] });
      lines(['it finished']);

      render(<AgentRunLog name="watcher" status="sleeping" />);

      expect(screen.getByText('Last output')).toBeInTheDocument();
    });
  });
});

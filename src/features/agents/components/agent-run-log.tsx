import { useEffect, useRef } from 'react';

import type { AgentStatus, RunSummary } from '@shared/agent-contract';
import { formatRunCost } from '@shared/agent-contract';
import { useTerminalAppearance } from '@stores/appearance-store';
import { useAgentLines, useAgentRuns } from '@stores/hive-store';

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
 * ## Why the buffer is not chopped into runs
 *
 * Lines arrive as a flat stream with no run id on them, so the only way to
 * partition the buffer would be to sniff the closing line's colour — brittle,
 * and wrong the moment the fold gains a second cyan line. Instead the header
 * names a run only while one is **live**, which is the case where the buffer
 * genuinely is that run's output. Once it ends, every run becomes a receipt
 * and the buffer is labelled for what it is: the last thing this agent said.
 *
 * Receipts do not expand, and they have no chevron promising that they might.
 * Their lines were never kept — `agents:lines` is a live push and nothing
 * writes it to disk — so a disclosure control would open onto nothing.
 */
export function AgentRunLog({ name, status }: AgentRunLogProps) {
  const lines = useAgentLines(name);
  const runs = useAgentRuns(name);
  const { palette, fontFamily, fontSize } = useTerminalAppearance();
  const foot = useRef<HTMLDivElement>(null);

  const live = status === 'working';
  const latest = runs[runs.length - 1];
  // While a run is live it owns the buffer and its receipt would duplicate the
  // header above it; once it ends it joins the others.
  const receipts = live ? runs.slice(0, -1) : runs;

  useEffect(() => {
    // Follow the output while it is being written, as the terminal does. Not
    // when it is finished: yanking a reader to the bottom of a log they are
    // scrolling back through is the behaviour every transcript gets wrong.
    if (live) foot.current?.scrollIntoView({ block: 'end' });
  }, [lines, live]);

  return (
    <div
      className="min-h-0 overflow-y-auto rounded-lg bg-term-bg p-2.5"
      style={{ fontFamily, fontSize }}
      data-region="run-log"
    >
      {receipts.map((run) => (
        <RunHeader key={run.run} run={run} dim={palette.dim} brand={palette.blue} />
      ))}

      {live && latest !== undefined ? (
        <RunHeader run={latest} dim={palette.dim} brand={palette.blue} live />
      ) : null}

      {lines.length === 0 ? (
        <p style={{ color: palette.dim }}>
          Nothing yet — Run now wakes it.
        </p>
      ) : (
        <>
          {!live && runs.length > 0 ? (
            <p
              className="pt-1.5 text-[0.85em] tracking-[0.1em] uppercase"
              style={{ color: palette.dim }}
            >
              Last output
            </p>
          ) : null}
          {lines.map((line, index) => (
            <p
              // Lines are append-only and never reordered, so the index is a
              // stable identity here in the one way it usually is not.
              key={index}
              className="break-words whitespace-pre-wrap"
              /*
                `palette` is keyed by every `TermColor`, and `RunLineColor` is
                a strict subset of it, so this indexes without a cast — the
                same subset relationship a contract test pins.
              */
              style={{ color: palette[line.color] }}
            >
              {line.text}
            </p>
          ))}
        </>
      )}

      <div ref={foot} />
    </div>
  );
}

interface RunHeaderProps {
  run: RunSummary;
  dim: string;
  brand: string;
  live?: boolean;
}

/** `Run #r17 · ledger · 14:32` on the left, what it cost on the right. */
function RunHeader({ run, dim, brand, live = false }: RunHeaderProps) {
  const at = new Date(run.startedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const seconds = Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000));
  const cost = formatRunCost(run.costUsd);

  const right = [
    run.turns === undefined ? null : `${run.turns} turns`,
    live ? null : `${seconds}s`,
    cost,
    // `reason` is the only place a failure says what actually happened —
    // killed, stalled, app-closed — and the outcome word alone does not.
    run.reason,
  ]
    .filter((part) => part !== null && part !== undefined)
    .join(' · ');

  return (
    <div
      className="flex items-baseline justify-between gap-3.5 border-t border-border-soft pt-1 pb-0.5 text-[0.9em] first:border-t-0 first:pt-0"
      style={{ color: dim }}
    >
      <span className="truncate">
        <span style={{ color: brand }}>Run #{run.run}</span>
        {` · ${run.trigger} · ${at}`}
      </span>
      <span className="shrink-0">{live ? 'running…' : `${run.outcome} · ${right}`}</span>
    </div>
  );
}

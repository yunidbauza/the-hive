import { useState, type KeyboardEvent } from 'react';

import { cn } from '@/lib/utils';
import type { Agent } from '@/types/entity';

import { Icon } from '@components/ui/icon';
import { STATUS_TEXT, STATUS_LABEL } from '@components/ui/status-dot';
import { AgentLedger } from '@features/agents/components/agent-ledger';
import { AgentRunLog } from '@features/agents/components/agent-run-log';
import { parseAgentInput } from '@lib/ledger/agent-input';
import { useAgentFacts } from '@stores/hive-store';
import { useSettingsActions } from '@stores/ui-store';

interface AgentViewProps {
  entity: Agent;
}

/**
 * An agent's place on the centre stage (HIVE-116).
 *
 * **Deliberately not a terminal.** Nothing here is typed into a process: the
 * input posts to the ledger, and the log is a transcript of turns that have
 * already ended. It keeps the terminal's rhythm — a header, a body, one input
 * at the bottom — so the eye knows where to look, and that is the whole of the
 * resemblance. Until this story an agent tab mounted a read-only xterm and a
 * message row, which looked like somewhere to type and was not.
 *
 * ## The split
 *
 * Run log and ledger sit side by side rather than stacked, because the two
 * want different widths for reasons that do not move: the log renders at the
 * *terminal* type scale, which the user sets anywhere from 10px to 18px, so
 * its character budget is elastic; the ledger is chrome at a fixed size
 * showing short correspondence. The elastic one takes the remainder.
 *
 * `minmax(0, 1fr)` and not a bare `1fr`: `1fr` carries an `auto` minimum, so
 * one unbreakable 95-character tool line — `ARG_LIMIT` is 60, plus the tool's
 * name — would push the grid past the stage and hand the whole app a
 * horizontal scrollbar.
 *
 * The stack point is a **container query**, not a media query, and this is the
 * first one in the codebase. The rails drag between 268px and 520px each, so a
 * 1920px window can hold a 700px stage; only this box knows how wide it
 * actually is. Below 800px the ledger drops beneath the log at full width,
 * which is the layout this story started from — nothing is lost, it is just
 * not the shape that suits a wide stage.
 */
export function AgentView({ entity }: AgentViewProps) {
  const facts = useAgentFacts(entity.id);
  const { openSettings } = useSettingsActions();
  const [draft, setDraft] = useState('');
  /**
   * The last refusal from a control on this surface, or `null`.
   *
   * Both verbs answer with a **value** rather than throwing — `AgentRunResult`
   * carries `refused: 'working' | 'unknown' | 'invalid'` and `LedgerResult` a
   * status and a reason — and both contracts say in as many words that they
   * are values so the renderer can draw the reason. Discarding them made a
   * refused Run now look like a dead button, and a rejected post silently eat
   * what the user typed.
   */
  const [notice, setNotice] = useState<string | null>(null);

  const runNow = () => {
    setNotice(null);

    void window.hive?.agents.run({ name: entity.id }).then((result) => {
      if (result.started) return;

      setNotice(
        result.reason ??
          (result.refused === 'working'
            ? 'Already running — one run at a time.'
            : result.refused === 'invalid'
              ? 'Its definition could not be read. Edit it to fix that.'
              : 'The agent runtime is not up.'),
      );
    });
  };

  const submit = () => {
    const input = parseAgentInput(draft);

    if (input.kind === 'empty') return;

    setNotice(null);

    const written =
      input.kind === 'answer'
        ? window.hive?.ledger.answer({ thread: input.thread, body: input.body })
        : window.hive?.ledger.post({
            to: entity.id,
            kind: 'ask',
            body: input.body,
          });

    /*
      The draft is cleared **on success**, never before the write is known.

      A body over the ledger's cap, an unresolvable ref, or a failed disk write
      all come back as a refusal — and clearing first destroyed the message on
      its way out, which is the exact failure `agent-input.ts` tightened its
      thread matching to avoid.
    */
    void written?.then((result) => {
      if (result.ok) {
        setDraft('');

        return;
      }

      setNotice(result.reason);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;

    event.preventDefault();
    submit();
  };

  return (
    <div
      className="@container flex min-h-0 flex-1 flex-col gap-2"
      data-view="agent"
    >
      <header className="flex items-center gap-2.5 px-0.5">
        <span className="relative flex size-7 shrink-0 items-center justify-center rounded-lg bg-chip">
          <Icon name={entity.icon} size={15} className="text-brand" />
        </span>

        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px]">{entity.id}</span>
          <span className="truncate text-[11px] text-subtle">{entity.sub}</span>
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={runNow}
            className="rounded-md border border-brand px-2 py-1 text-[11px] text-brand hover:bg-hover"
          >
            ▶ Run now
          </button>
          {/*
            Disabled rather than absent: pause is a control this surface will
            have, and hiding it until HIVE-117 lands would make the header
            change shape under the user for a reason they cannot see. There is
            no Stop — a run is one bounded turn, and `kill` belongs in the
            console for a runaway.
          */}
          <button
            type="button"
            disabled
            title="Pausing an agent arrives with HIVE-117"
            className="rounded-md border border-border px-2 py-1 text-[11px] text-muted opacity-40"
          >
            ⏸ Pause
          </button>
          <button
            type="button"
            onClick={() => openSettings('agents')}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:bg-hover hover:text-ink"
          >
            Edit definition
          </button>
        </span>
      </header>

      {facts === null ? null : (
        <div
          /*
            A container query, not `sm:`. The tiles live on the stage, and the
            stage is not the viewport: with both rails dragged wide a 1100px
            window leaves ~560px here, where `sm:` (a 640px *viewport*) still
            fires and truncates `Session` and `Today` into five ~105px columns.
            The same box this grid sits in is what knows.
          */
          className="grid grid-cols-2 gap-1.5 @min-[720px]:grid-cols-5"
        >
          <Fact label="Status" tone={STATUS_TEXT[facts.status]}>
            {STATUS_LABEL[facts.status]}
            {facts.askRef === undefined ? '' : ` ${facts.askRef}`}
          </Fact>
          <Fact label="Wake">{facts.wake}</Fact>
          <Fact label="Next">{facts.next}</Fact>
          <Fact label="Today">{`${facts.todayRuns} runs · ${facts.todayCost}`}</Fact>
          {/*
            The rotation made visible *before* it happens: an agent resumes one
            conversation until this fraction fills, and HIVE-122 starts a fresh
            one. Without the denominator a reader has no way to know how close
            that is.
          */}
          <Fact label="Session">
            {facts.sessionUuid === undefined
              ? '—'
              : `${facts.sessionUuid.slice(0, 8)} · run ${facts.runsSinceRotate}/${facts.rotateAfter}`}
          </Fact>
        </div>
      )}

      <div className="min-h-0 flex-1">
        <div className="grid h-full min-h-0 gap-2 [grid-template-columns:minmax(0,1fr)_clamp(280px,22%,380px)] @max-[800px]:[grid-template-columns:minmax(0,1fr)]">
          <AgentRunLog name={entity.id} status={entity.status} />
          <AgentLedger name={entity.id} />
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 rounded-lg bg-term-input px-2.5 py-2">
          <span className="shrink-0 text-brand">›</span>
          <label htmlFor="agent-input" className="sr-only">
            {`Post to ${entity.id}'s ledger`}
          </label>
          <input
            id="agent-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={entity.id}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-subtle"
          />
        </div>
        {/*
          "as the overmind", not "as you": main supplies `from` itself on both
          `ledger.post` and `ledger.answer`, so the renderer cannot speak as
          anyone else — and saying "as you" would describe an identity that
          does not exist in the log.
        */}
        {notice === null ? (
          <p className="px-1 pt-1 text-[10px] text-subtle">
            Enter posts to the ledger as the overmind. This is not a terminal —
            nothing here reaches a process.
          </p>
        ) : (
          <p role="status" className="px-1 pt-1 text-[10px] text-amber">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}

interface FactProps {
  label: string;
  tone?: string;
  children: React.ReactNode;
}

function Fact({ label, tone, children }: FactProps) {
  return (
    <div className="min-w-0 rounded-md border border-border-soft bg-panel px-2 py-1.5">
      <span className="block text-[8.5px] tracking-[0.1em] text-subtle uppercase">
        {label}
      </span>
      <span className={cn('block truncate text-[11px]', tone)}>{children}</span>
    </div>
  );
}
